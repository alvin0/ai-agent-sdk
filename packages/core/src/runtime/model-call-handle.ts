import type { GenerateOptions } from '../contract/generate-options.ts'
import { deepFreeze } from '../primitives/freeze.ts'
import type { JsonObject } from '../primitives/json.ts'
import type { StreamChunk, TokenUsage } from '../stream/chunk.ts'
import { createObservationRunScope, createOperationId, isSpanId, isTraceId, type CorrelationContext, type ObservationRunScope } from '../observation/context.ts'
import { safeErrorRecord, type ObservationEvent, type ObservationResource, type OperationStatus, type SafeErrorRecord } from '../observation/event.ts'
import { createCoreSpan, disabledDeliverySummary, NOOP_OBSERVATION_PORT, snapshotObservationSpan, validateCaptureReceipt, type CaptureReceipt, type DeliveryMode, type ObservationBoundary, type ObservationDeliverySummary, type ObservationPort, type ObservationSpan } from '../observation/port.ts'
import { AgentSdkError } from '../errors/agent-sdk-error.ts'
import { ModelCallObservationError, OBSERVATION_ERROR_CODES, type EndProviderAttemptInput, type ModelCallHandle, type ModelCallReport, type ModelInvocationContext, type ProviderAttemptHandle, type ProviderRetryScheduledInput, type StartProviderAttemptInput } from '../observation/report.ts'
import { addUsageCounters, classifyUsageCoverage, possiblyBilledAttemptsWithoutUsage, validateUsageCounters, type AttemptUsageReport, type UsageCoverage } from '../observation/usage.ts'

const scopes = new WeakMap<object, Map<string, ObservationRunScope>>()

function nowMonotonic(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function scopeFor(key: object, runId: string, supplied?: ObservationRunScope): ObservationRunScope {
  if (supplied !== undefined) return supplied
  let runs = scopes.get(key)
  if (!runs) {
    runs = new Map()
    scopes.set(key, runs)
  }
  let scope = runs.get(runId)
  if (!scope) {
    scope = createObservationRunScope()
    runs.set(runId, scope)
  }
  return scope
}

function safeFailureFromFinish(chunk: Extract<StreamChunk, { type: 'finish' }>): SafeErrorRecord | undefined {
  if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') return undefined
  const failure = chunk.reason.failure
  return Object.freeze({
    type: 'ModelError',
    message: chunk.reason.kind === 'aborted'
      ? 'model call was aborted; inspect the stable code for classification'
      : 'model call failed; inspect the stable code and provider request ID',
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
  const scope = scopeFor(contextKey, runId, input.context?.scope)
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
    monotonicMs: scope.monotonicMs(),
  }, tracker)
  const makeEvent = (phase: 'start' | 'end', data: JsonObject): ObservationEvent<'sdk.model.call'> => deepFreeze({
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence: scope.nextSequence(),
    name: 'sdk.model.call',
    phase,
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
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

  const attempts: AttemptUsageReport[] = []
  const openAttempts = new Set<(input: EndProviderAttemptInput) => AttemptUsageReport>()
  let nextAttemptNumber = 1
  let providerAttemptAccountingDeclared = false

  function recordProviderRetry(retry: ProviderRetryScheduledInput): void {
    capture(deepFreeze({
      schemaVersion: 1,
      eventId: createOperationId(),
      sequence: scope.nextSequence(),
      name: 'sdk.provider.retry.scheduled',
      phase: 'point',
      occurredAt: new Date().toISOString(),
      monotonicMs: scope.monotonicMs(),
      priority: 'critical',
      resource: input.resource,
      correlation: span.correlation,
      data: {
        nextAttemptNumber: retry.nextAttemptNumber,
        delayMs: retry.delayMs,
        failureCode: retry.failureCode,
      },
    }))
  }

  async function startProviderAttempt(
    attemptInput: StartProviderAttemptInput,
    signal?: AbortSignal,
  ): Promise<ProviderAttemptHandle> {
    const attemptNumber = nextAttemptNumber++
    const attemptId = createOperationId()
    const attemptStartedAt = new Date().toISOString()
    const attemptStartedMonotonic = nowMonotonic()
    const attemptSpan = openContainedSpan(port, {
      name: 'sdk.provider.attempt',
      runId,
      parent: span.correlation,
      correlation: { modelCallId, attemptId },
      startedAt: attemptStartedAt,
      monotonicMs: scope.monotonicMs(),
    }, tracker)
    const startEvent: ObservationEvent<'sdk.provider.attempt'> = deepFreeze({
      schemaVersion: 1,
      eventId: createOperationId(),
      sequence: scope.nextSequence(),
      name: 'sdk.provider.attempt',
      phase: 'start',
      occurredAt: attemptStartedAt,
      monotonicMs: scope.monotonicMs(),
      priority: 'critical',
      resource: input.resource,
      correlation: attemptSpan.correlation,
      data: {
        provider: attemptInput.provider,
        model: attemptInput.model,
        attemptNumber,
        method: attemptInput.method,
        origin: attemptInput.origin,
        dispatchState: 'not-sent',
      },
    })

    if (mode === 'audit') {
      tracker.pending += 1
      try {
        const rawReceipt = port.checkpoint
          ? await port.checkpoint(startEvent, signal)
          : Object.freeze({
            eventId: startEvent.eventId,
            status: 'rejected' as const,
            durable: false,
            boundary: 'none' as const,
            reason: 'exporter-unavailable' as const,
          })
        const receipt = validateCaptureReceipt(rawReceipt, startEvent.eventId)
        tracker.pending -= 1
        applyReceipt(tracker, receipt, true)
        if (receipt.status !== 'accepted' || !receipt.durable) {
          if (receipt.status === 'accepted') tracker.rejected += 1
          tracker.lastFailure = Object.freeze({
            type: 'ObservationCheckpointError',
            message: `provider-attempt audit checkpoint was ${receipt.status}`,
            code: OBSERVATION_ERROR_CODES.CAPTURE_REJECTED,
          })
          attemptSpan.end('rejected', new Date().toISOString(), scope.monotonicMs())
          throw new AgentSdkError(
            'audit observation is unavailable before provider dispatch',
            OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE,
          )
        }
      } catch (checkpointError) {
        if (tracker.pending > 0) tracker.pending -= 1
        if (!(checkpointError instanceof AgentSdkError
          && checkpointError.code === OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE)) {
          tracker.rejected += 1
          tracker.lastFailure = safeErrorRecord(checkpointError)
          attemptSpan.end('rejected', new Date().toISOString(), scope.monotonicMs())
        }
        throw checkpointError instanceof AgentSdkError
          && checkpointError.code === OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE
          ? checkpointError
          : new AgentSdkError(
            'audit observation is unavailable before provider dispatch',
            OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE,
            { cause: checkpointError },
          )
      }
    } else capture(startEvent)

    let finalReport: AttemptUsageReport | undefined
    const end = (endInput: EndProviderAttemptInput): AttemptUsageReport => {
      if (finalReport !== undefined) return finalReport
      const endedAt = new Date().toISOString()
      const endedMonotonic = nowMonotonic()
      const validated = validateUsageCounters(endInput.reported, true)
      const coverage: UsageCoverage = endInput.dispatchState === 'not-sent'
        ? 'not-applicable'
        : validated.complete ? 'complete'
          : Object.keys(validated.reported).length > 0 ? 'partial' : 'missing'
      const invalidError = validated.invalidFields.length > 0 || validated.overflow
        ? Object.freeze({
          type: 'UsageValidationError',
          message: validated.overflow
            ? 'provider attempt usage counters overflowed safe integer validation'
            : `provider attempt usage contained invalid fields: ${validated.invalidFields.join(', ')}`,
          code: validated.overflow
            ? OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW
            : OBSERVATION_ERROR_CODES.USAGE_INVALID,
        })
        : undefined
      const terminalError = endInput.error ?? invalidError
      const durationMs = Math.max(0, endedMonotonic - attemptStartedMonotonic)
      attemptSpan.end(endInput.status, endedAt, scope.monotonicMs())
      const terminalCorrelation = endInput.providerRequestId === undefined
        ? attemptSpan.correlation
        : deepFreeze({ ...attemptSpan.correlation, providerRequestId: endInput.providerRequestId })
      capture(deepFreeze({
        schemaVersion: 1,
        eventId: createOperationId(),
        sequence: scope.nextSequence(),
        name: 'sdk.provider.attempt',
        phase: 'end',
        occurredAt: endedAt,
        monotonicMs: scope.monotonicMs(),
        priority: 'critical',
        resource: input.resource,
        correlation: terminalCorrelation,
        data: {
          status: endInput.status,
          durationMs,
          dispatchState: endInput.dispatchState,
          coverage,
          reported: { ...validated.reported },
          ...endInput.httpStatus === undefined ? {} : { httpStatus: endInput.httpStatus },
          ...endInput.providerRequestId === undefined ? {} : { providerRequestId: endInput.providerRequestId },
          ...terminalError === undefined ? {} : { error: { ...terminalError } },
        },
      }))
      finalReport = deepFreeze({
        attemptId,
        spanId: attemptSpan.correlation.spanId,
        attemptNumber,
        status: endInput.status,
        startedAt: attemptStartedAt,
        endedAt,
        durationMs,
        dispatchState: endInput.dispatchState,
        coverage,
        reported: validated.reported,
        ...endInput.httpStatus === undefined ? {} : { httpStatus: endInput.httpStatus },
        ...endInput.providerRequestId === undefined ? {} : { providerRequestId: endInput.providerRequestId },
        ...terminalError === undefined ? {} : { error: terminalError },
      })
      attempts.push(finalReport)
      openAttempts.delete(end)
      return finalReport
    }
    openAttempts.add(end)
    return Object.freeze({ attemptId, attemptNumber, traceparent: attemptSpan.traceparent, end })
  }
  const effectiveContext: ModelInvocationContext = Object.freeze({
    observation: port,
    correlation: span.correlation,
    terminalCheckpointOwner: input.context?.terminalCheckpointOwner ?? 'model-call',
    scope,
    declareProviderAttemptAccounting: () => { providerAttemptAccountingDeclared = true },
    startProviderAttempt,
    recordProviderRetry,
  })
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
    for (const closeAttempt of [...openAttempts]) {
      closeAttempt({
        status: status === 'aborted' ? 'aborted' : 'unknown',
        dispatchState: input.dispatchState() === 'not-sent' ? 'not-sent' : 'unknown',
        ...(error === undefined ? {} : { error }),
      })
    }
    try { span.end(status, endedAt, scope.monotonicMs()) } catch (spanError) { tracker.lastFailure = safeErrorRecord(spanError) }

    const validated = usage === undefined ? undefined : validateUsageCounters(usage, true)
    const preDispatch = !input.routePresent || input.dispatchState() === 'not-sent'
    const coverage: UsageCoverage = attempts.length > 0 || providerAttemptAccountingDeclared
      ? classifyUsageCoverage(attempts)
      : validated === undefined
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
    const attemptUsage = attempts.length === 0
      ? undefined
      : addUsageCounters(attempts.map(attempt => attempt.reported)).counters
    const reported = attemptUsage ?? validated?.reported ?? {}
    const endEvent = makeEvent('end', {
      status,
      durationMs,
      ...finishReason === undefined ? {} : { finishReason },
      coverage,
      reported: { ...reported },
      attemptCount: attempts.length,
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
      reported,
      attempts: [...attempts].sort((left, right) => left.attemptNumber - right.attemptNumber),
      possiblyBilledAttemptsWithoutUsage: attempts.length > 0
        ? possiblyBilledAttemptsWithoutUsage(attempts)
        : coverage === 'missing' || coverage === 'partial' ? 1 : 0,
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
