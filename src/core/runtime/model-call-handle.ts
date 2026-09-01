import type { GenerateOptions } from '../contract/generate-options.ts'
import { deepFreeze } from '../primitives/freeze.ts'
import type { JsonObject } from '../primitives/json.ts'
import type { StreamChunk, TokenUsage } from '../stream/chunk.ts'
import { createOperationId, isSpanId, isTraceId, type CorrelationContext } from '../observation/context.ts'
import { safeErrorRecord, type ObservationEvent, type ObservationResource, type OperationStatus, type SafeErrorRecord } from '../observation/event.ts'
import { createCoreSpan, disabledDeliverySummary, NOOP_OBSERVATION_PORT, snapshotObservationSpan, validateCaptureReceipt, type CaptureReceipt, type DeliveryMode, type ObservationBoundary, type ObservationDeliverySummary, type ObservationPort, type ObservationSpan } from '../observation/port.ts'
import { ModelCallObservationError, OBSERVATION_ERROR_CODES, type ModelCallHandle, type ModelCallReport, type ModelInvocationContext } from '../observation/report.ts'
import { validateUsageCounters, type UsageCoverage } from '../observation/usage.ts'

interface SequenceState { next: number; readonly originMs: number }
const sequences = new WeakMap<object, Map<string, SequenceState>>()

function nowMonotonic(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function stateFor(key: object, runId: string): SequenceState {
  let runs = sequences.get(key)
  if (!runs) {
    runs = new Map()
    sequences.set(key, runs)
  }
  let state = runs.get(runId)
  if (!state) {
    state = { next: 1, originMs: nowMonotonic() }
    runs.set(runId, state)
  }
  return state
}

function nextSequence(state: SequenceState): number {
  if (!Number.isSafeInteger(state.next) || state.next < 1) throw new RangeError('observation sequence exhausted')
  const value = state.next
  state.next += 1
  return value
}

function safeFailureFromFinish(chunk: Extract<StreamChunk, { type: 'finish' }>): SafeErrorRecord | undefined {
  if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') return undefined
  const failure = chunk.reason.failure
  return Object.freeze({
    type: 'ModelError',
    message: failure.message,
    code: failure.code,
    ...failure.status === undefined ? {} : { status: failure.status },
  })
}

function boundaryRank(boundary: ObservationBoundary): number {
  if (boundary === 'remote-acknowledged') return 2
  if (boundary === 'local-durable') return 1
  return 0
}

interface DeliveryTracker {
  accepted: number
  rejected: number
  pending: number
  reached: ObservationBoundary
  lastFailure?: SafeErrorRecord
}

function applyReceipt(tracker: DeliveryTracker, receipt: CaptureReceipt, critical: boolean): void {
  if (!critical) return
  if (receipt.status === 'accepted') tracker.accepted += 1
  else tracker.rejected += 1
  if (receipt.status === 'accepted' && boundaryRank(receipt.boundary) > boundaryRank(tracker.reached)) tracker.reached = receipt.boundary
}

function deliverySummary(port: ObservationPort, mode: DeliveryMode, tracker: DeliveryTracker): ObservationDeliverySummary {
  if (port === NOOP_OBSERVATION_PORT) return disabledDeliverySummary()
  const requiredBoundary: ObservationBoundary = mode === 'operational'
    ? 'none'
    : boundaryRank(tracker.reached) > 0 ? tracker.reached : 'local-durable'
  return deepFreeze({
    mode,
    requiredBoundary,
    reachedBoundary: tracker.reached,
    complete: tracker.rejected === 0 && tracker.pending === 0
      && boundaryRank(tracker.reached) >= boundaryRank(requiredBoundary),
    acceptedCritical: tracker.accepted,
    rejectedCritical: tracker.rejected,
    pendingCritical: tracker.pending,
    ...tracker.lastFailure === undefined ? {} : { lastFailure: tracker.lastFailure },
  })
}

function validParent(value: Partial<CorrelationContext> | undefined): CorrelationContext | undefined {
  if (!value || !isTraceId(value.traceId) || !isSpanId(value.spanId)
    || typeof value.runId !== 'string' || value.runId.length === 0) return undefined
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    parentSpanId: value.parentSpanId === null || isSpanId(value.parentSpanId) ? value.parentSpanId : null,
    runId: value.runId,
    ...value.conversationId === undefined ? {} : { conversationId: value.conversationId },
    ...value.turnId === undefined ? {} : { turnId: value.turnId },
    ...value.modelCallId === undefined ? {} : { modelCallId: value.modelCallId },
    ...value.attemptId === undefined ? {} : { attemptId: value.attemptId },
    ...value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId },
    ...value.providerRequestId === undefined ? {} : { providerRequestId: value.providerRequestId },
    ...value.sessionId === undefined ? {} : { sessionId: value.sessionId },
  }
}

function openContainedSpan(port: ObservationPort, input: Parameters<ObservationPort['openSpan']>[0], tracker: DeliveryTracker): ObservationSpan {
  try {
    const span = snapshotObservationSpan(port.openSpan(input))
    if (span && span.correlation.runId === input.runId
      && span.correlation.modelCallId === input.correlation?.modelCallId) {
      let ended = false
      return Object.freeze({
        correlation: span.correlation,
        traceparent: span.traceparent,
        end(status: OperationStatus, endedAt: string, monotonicMs: number): void {
          if (ended) return
          ended = true
          try { span.end(status, endedAt, monotonicMs) } catch (error) { tracker.lastFailure = safeErrorRecord(error) }
        },
      })
    }
    tracker.lastFailure = Object.freeze({
      type: 'ObservationSpanError',
      message: 'observation backend returned an invalid or mismatched span identity',
      code: OBSERVATION_ERROR_CODES.OTEL_PROVIDER_UNCONFIGURED,
    })
  } catch (error) {
    tracker.lastFailure = safeErrorRecord(error)
  }
  return createCoreSpan(input)
}

export interface CreateModelCallHandleOptions {
  readonly options: GenerateOptions
  readonly context?: ModelInvocationContext
  readonly defaultObservation?: ObservationPort
  readonly resource: ObservationResource
  readonly routePresent: boolean
  readonly dispatchState: () => 'not-sent' | 'unknown'
  readonly stream: (context: ModelInvocationContext) => AsyncIterable<StreamChunk>
}

export function createModelCallHandle(input: CreateModelCallHandleOptions): ModelCallHandle {
  const contextKey = input.context ?? {}
  const supplied = input.context?.correlation
  const runId = typeof supplied?.runId === 'string' && supplied.runId.length > 0 ? supplied.runId : createOperationId()
  const modelCallId = typeof supplied?.modelCallId === 'string' && supplied.modelCallId.length > 0 ? supplied.modelCallId : createOperationId()
  const sequenceState = stateFor(contextKey, runId)
  const startedAt = new Date().toISOString()
  const startedMonotonic = nowMonotonic()
  const port = input.context?.observation ?? input.defaultObservation ?? NOOP_OBSERVATION_PORT
  const tracker: DeliveryTracker = { accepted: 0, rejected: 0, pending: 0, reached: 'none' }
  let mode: DeliveryMode = 'operational'
  try {
    const configuredMode = port.mode
    if (configuredMode !== 'operational' && configuredMode !== 'reliable' && configuredMode !== 'audit') {
      throw new TypeError('observation delivery mode is invalid')
    }
    mode = configuredMode
  } catch (modeError) {
    tracker.lastFailure = safeErrorRecord(modeError)
  }
  const parent = validParent(supplied)
  const span = openContainedSpan(port, {
    name: 'sdk.model.call',
    runId,
    ...(parent === undefined ? {} : { parent }),
    correlation: {
      modelCallId,
      ...supplied?.conversationId === undefined ? {} : { conversationId: supplied.conversationId },
      ...supplied?.turnId === undefined ? {} : { turnId: supplied.turnId },
      ...supplied?.sessionId === undefined ? {} : { sessionId: supplied.sessionId },
    },
    startedAt,
    monotonicMs: Math.max(0, startedMonotonic - sequenceState.originMs),
  }, tracker)
  const effectiveContext: ModelInvocationContext = Object.freeze({
    observation: port,
    correlation: span.correlation,
    terminalCheckpointOwner: input.context?.terminalCheckpointOwner ?? 'model-call',
  })

  const makeEvent = (phase: 'start' | 'end', data: JsonObject): ObservationEvent<'sdk.model.call'> => deepFreeze({
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence: nextSequence(sequenceState),
    name: 'sdk.model.call',
    phase,
    occurredAt: new Date().toISOString(),
    monotonicMs: Math.max(0, nowMonotonic() - sequenceState.originMs),
    priority: 'critical',
    resource: input.resource,
    correlation: span.correlation,
    data,
  })

  const capture = (event: ObservationEvent): void => {
    try {
      const receipt = validateCaptureReceipt(port.capture(event), event.eventId)
      applyReceipt(tracker, receipt, event.priority === 'critical')
    } catch (error) {
      tracker.rejected += event.priority === 'critical' ? 1 : 0
      tracker.lastFailure = safeErrorRecord(error)
    }
  }
  capture(makeEvent('start', {
    provider: input.options.provider,
    model: input.options.model,
    operation: 'stream',
  }))

  let resolveReport: (report: ModelCallReport) => void = () => {}
  const report = new Promise<ModelCallReport>((resolvePromise) => { resolveReport = resolvePromise })
  let finalized = false
  let iterated = false
  let status: OperationStatus = 'unknown'
  let finishReason: string | undefined
  let error: SafeErrorRecord | undefined
  let usage: TokenUsage | undefined

  const finalize = async (): Promise<{ report: ModelCallReport; auditFailure: boolean }> => {
    if (finalized) return { report: await report, auditFailure: false }
    finalized = true
    const endedAt = new Date().toISOString()
    const endedMonotonic = nowMonotonic()
    if (status === 'unknown') {
      error ??= Object.freeze({
        type: 'OperationTerminalError',
        message: 'model call closed without a terminal finish reason',
        code: OBSERVATION_ERROR_CODES.OPERATION_TERMINAL_MISSING,
      })
    }
    try { span.end(status, endedAt, Math.max(0, endedMonotonic - sequenceState.originMs)) } catch (spanError) { tracker.lastFailure = safeErrorRecord(spanError) }

    const validated = usage === undefined ? undefined : validateUsageCounters(usage, true)
    const preDispatch = !input.routePresent || input.dispatchState() === 'not-sent'
    const coverage: UsageCoverage = validated === undefined
      ? preDispatch ? 'not-applicable' : 'missing'
      : validated.complete ? 'complete' : 'partial'
    if (validated && (validated.invalidFields.length > 0 || validated.overflow)) {
      error ??= Object.freeze({
        type: 'UsageValidationError',
        message: validated.overflow
          ? 'provider usage counters overflowed safe integer aggregation'
          : `provider usage contained invalid fields: ${validated.invalidFields.join(', ')}`,
        code: validated.overflow ? OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW : OBSERVATION_ERROR_CODES.USAGE_INVALID,
      })
    } else if (coverage === 'missing' && error === undefined) {
      error = Object.freeze({
        type: 'UsageMissingError',
        message: 'model call may have been dispatched but no provider usage was reported',
        code: OBSERVATION_ERROR_CODES.USAGE_MISSING,
      })
    }
    const durationMs = Math.max(0, endedMonotonic - startedMonotonic)
    const endEvent = makeEvent('end', {
      status,
      durationMs,
      ...finishReason === undefined ? {} : { finishReason },
      coverage,
      reported: { ...(validated?.reported ?? {}) },
      attemptCount: 0,
    })
    let auditFailure = false
    const checkpointOwner = effectiveContext.terminalCheckpointOwner ?? 'model-call'
    if (checkpointOwner === 'model-call' && mode !== 'operational') {
      tracker.pending += 1
      try {
        const rawReceipt = port.checkpoint
          ? await port.checkpoint(endEvent)
          : Object.freeze({ eventId: endEvent.eventId, status: 'rejected' as const, durable: false, boundary: 'none' as const, reason: 'exporter-unavailable' as const })
        const receipt = validateCaptureReceipt(rawReceipt, endEvent.eventId)
        tracker.pending -= 1
        applyReceipt(tracker, receipt, true)
        if (receipt.status !== 'accepted' || !receipt.durable) {
          auditFailure = mode === 'audit'
          tracker.lastFailure = Object.freeze({
            type: 'ObservationCheckpointError',
            message: `terminal observation checkpoint was ${receipt.status}`,
            code: OBSERVATION_ERROR_CODES.CAPTURE_REJECTED,
          })
        }
      } catch (checkpointError) {
        tracker.pending -= 1
        tracker.rejected += 1
        tracker.lastFailure = safeErrorRecord(checkpointError)
        auditFailure = mode === 'audit'
      }
    } else capture(endEvent)

    const finalReport = deepFreeze<ModelCallReport>({
      runId,
      traceId: span.correlation.traceId,
      modelCallId,
      spanId: span.correlation.spanId,
      provider: input.options.provider,
      model: input.options.model,
      status,
      startedAt,
      endedAt,
      durationMs,
      ...finishReason === undefined ? {} : { finishReason },
      coverage,
      reported: validated?.reported ?? {},
      attempts: [],
      possiblyBilledAttemptsWithoutUsage: coverage === 'missing' || coverage === 'partial' ? 1 : 0,
      authoritative: coverage === 'complete' || coverage === 'not-applicable',
      delivery: deliverySummary(port, mode, tracker),
      ...error === undefined ? {} : { error },
    })
    resolveReport(finalReport)
    return { report: finalReport, auditFailure }
  }

  const iterate = async function* (): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk> | undefined
    let sourceDone = false
    let thrown: unknown
    try {
      iterator = input.stream(effectiveContext)[Symbol.asyncIterator]()
      while (true) {
        const item = await iterator.next()
        if (item.done) {
          sourceDone = true
          break
        }
        const chunk = item.value
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') {
          finishReason = chunk.reason.kind
          status = chunk.reason.kind === 'aborted' ? 'aborted'
            : chunk.reason.kind === 'error' ? 'error' : 'success'
          error = safeFailureFromFinish(chunk)
        }
        yield chunk
      }
    } catch (streamError) {
      thrown = streamError
      status = input.options.signal?.aborted === true ? 'aborted' : 'error'
      error = safeErrorRecord(streamError)
      throw streamError
    } finally {
      if (!sourceDone) {
        if (thrown === undefined) status = 'aborted'
        const close = iterator?.return?.bind(iterator)
        if (close) try { await close() } catch (closeError) { error ??= safeErrorRecord(closeError) }
      }
      const terminal = await finalize()
      if (terminal.auditFailure) {
        throw new ModelCallObservationError('audit observation checkpoint failed after model-call finalization', terminal.report)
      }
    }
  }

  return Object.freeze({
    runId,
    modelCallId,
    report,
    [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
      if (iterated) {
        return (async function* () { throw new Error('a model call handle can only be iterated once') })()
      }
      iterated = true
      return iterate()
    },
  })
}
