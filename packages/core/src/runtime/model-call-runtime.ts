import { deepFreeze } from '../primitives/freeze.ts'
import type { StreamChunk, TokenUsage } from '../stream/chunk.ts'
import { safeErrorRecord, type OperationStatus, type SafeErrorRecord } from '../observation/event.ts'
import { validateCaptureReceipt, type CaptureReceipt } from '../observation/port.ts'
import { ModelCallObservationError, OBSERVATION_ERROR_CODES, type ModelCallHandle,
  type ModelCallReport } from '../observation/report.ts'
import { addUsageCounters, hasUsageCounters, validateUsageCounters,
  type AttemptUsageReport, type UsageCoverage, type UsageCounters } from '../observation/usage.ts'
import { elapsedWithin, nowMonotonic, safeFailureFromFinish, applyReceipt,
  deliverySummary } from './model-call-support.ts'
import { modelCallCoverage, mergeUsageLowerBounds, usageValidationError,
  billedAttemptsWithoutUsage, finishStatus } from './model-call-usage.ts'
import type { captureModelCall } from './model-call-config.ts'

type ValidatedUsage = ReturnType<typeof validateUsageCounters>
interface UsageSummary {
  readonly durationMs: number
  readonly coverage: UsageCoverage
  readonly reported: UsageCounters
  readonly accountingOverflow: boolean
}

type ModelCallHost = ReturnType<typeof captureModelCall>

const activeIterators = new WeakMap<AsyncIterator<StreamChunk>, ModelCallRuntime>()

/** Read the evidence available at the agent's teardown deadline, without awaiting the provider. */
export function snapshotUnsettledModelCall(iterator: AsyncIterator<StreamChunk>): ModelCallReport | undefined {
  return activeIterators.get(iterator)?.unsettledReport()
}

export class ModelCallRuntime {
  private activeIterator?: AsyncIterator<StreamChunk>
  private resolveReport: (report: ModelCallReport) => void = () => {}
  private readonly report = new Promise<ModelCallReport>((resolve) => { this.resolveReport = resolve })
  private finalized = false
  private status: OperationStatus = 'unknown'
  private finishReason: string | undefined
  private error: SafeErrorRecord | undefined
  private usage: TokenUsage | undefined
  private firstOutputMonotonic: number | undefined

  constructor(private readonly host: ModelCallHost) {}

  private async finalize(): Promise<{ report: ModelCallReport; auditFailure: boolean }> {
    const { port, tracker, mode, capture, effectiveContext } = this.host
    if (this.finalized) return { report: await this.report, auditFailure: false }
    this.finalized = true
    const endedAt = new Date().toISOString()
    const endedMonotonic = nowMonotonic()
    this.closeAttempts(endedAt)

    const attempts = this.host.accounting.reportedAttempts()
    const summary = this.summarizeUsage(endedMonotonic, attempts)
    const endEvent = this.endEvent(summary, attempts)
    let auditFailure = false
    const checkpointOwner = effectiveContext.terminalCheckpointOwner ?? 'model-call'
    if (checkpointOwner === 'model-call' && mode !== 'operational') {
      tracker.pending += 1
      try {
        const rawReceipt = port.checkpoint
          ? await port.checkpoint(endEvent)
          : Object.freeze({ eventId: endEvent.eventId, status: 'rejected' as const, durable: false,
            boundary: 'none' as const, reason: 'exporter-unavailable' as const })
        auditFailure = this.acceptTerminalCheckpoint(rawReceipt, endEvent.eventId)
      } catch (checkpointError) {
        tracker.pending -= 1
        tracker.rejected += 1
        tracker.lastFailure = safeErrorRecord(checkpointError)
        auditFailure = mode === 'audit'
      }
    } else capture(endEvent)

    const finalReport = this.makeReport(summary, endedAt, attempts)
    this.resolveReport(finalReport)
    return { report: finalReport, auditFailure }
  }

  // A completed native generator can retain its receiver. Take the runtime out of
  // a one-shot slot so an application can keep the iterator without pinning its request.
  private static async *iterate(slot: { owner: ModelCallRuntime | undefined }): AsyncGenerator<StreamChunk> {
    const runtime = slot.owner!
    slot.owner = undefined
    const { input, effectiveContext } = runtime.host
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
        runtime.recordChunk(chunk)
        yield chunk
      }
    } catch (streamError) {
      thrown = streamError
      runtime.recordStreamError(streamError)
      throw streamError
    } finally {
      if (!sourceDone) {
        if (thrown === undefined) runtime.status = 'aborted'
        const close = iteratorClose(iterator)
        if (close) try { await close() } catch (closeError) { runtime.recordCloseError(closeError) }
      }
      await runtime.finish()
    }
  }

  private async finish(): Promise<void> {
    try {
      const terminal = await this.finalize()
      if (terminal.auditFailure) {
        throw new ModelCallObservationError('audit observation checkpoint failed after model-call finalization',
          terminal.report)
      }
    } finally {
      if (this.activeIterator) activeIterators.delete(this.activeIterator)
    }
  }

  private iterator(): AsyncGenerator<StreamChunk> {
    // Native async generators skip their finally block when closed before the first next().
    const slot: { owner: ModelCallRuntime | undefined } = { owner: this }
    const chunks = ModelCallRuntime.iterate(slot)
    this.activeIterator = chunks
    activeIterators.set(chunks, this)
    const close = chunks.return.bind(chunks)
    const fail = chunks.throw.bind(chunks)
    chunks.return = async value => {
      const owner = slot.owner
      slot.owner = undefined
      try { return await close(value) } finally {
        if (owner) {
          owner.status = 'aborted'
          await owner.finish()
        }
      }
    }
    chunks.throw = async error => {
      const owner = slot.owner
      slot.owner = undefined
      try { return await fail(error) } finally {
        if (owner) {
          owner.recordStreamError(error)
          await owner.finish()
        }
      }
    }
    return chunks
  }

  handle(): ModelCallHandle {
    const { runId, modelCallId } = this.host
    let available: ModelCallRuntime | undefined = this
    return Object.freeze({
      runId,
      modelCallId,
      report: this.report,
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        if (available === undefined) {
          return (async function* () { throw new Error('a model call handle can only be iterated once') })()
        }
        // Transfer the request to the iterator. Keeping a completed handle only retains its report.
        const chunks = available.iterator()
        available = undefined
        return chunks
      },
    })
  }

  private closeAttempts(endedAt: string): void {
    const { input, scope, span, tracker, accounting } = this.host
    const { openAttempts } = accounting
    if (this.status === 'unknown') {
      this.error ??= Object.freeze({
        type: 'OperationTerminalError',
        message: 'model call closed without a terminal finish reason',
        code: OBSERVATION_ERROR_CODES.OPERATION_TERMINAL_MISSING,
      })
    }
    for (const closeAttempt of [...openAttempts.keys()]) {
      closeAttempt({
        status: this.status === 'aborted' ? 'aborted' : 'unknown',
        dispatchState: input.dispatchState() === 'not-sent' ? 'not-sent' : 'unknown',
        ...(this.error === undefined ? {} : { error: this.error }),
      })
    }
    try { span.end(this.status, endedAt,
      scope.monotonicMs()) } catch (spanError) { tracker.lastFailure = safeErrorRecord(spanError) }

  }

  private recordOutputTime(): void {
    const { accounting } = this.host
    const at = nowMonotonic()
    this.firstOutputMonotonic ??= at
    accounting.markFirstOutput(at)
  }

  private firstOutputMs(durationMs: number): { firstOutputMs?: number } {
    if (this.firstOutputMonotonic === undefined) return {}
    const firstOutputMs = elapsedWithin(this.host.startedMonotonic, this.firstOutputMonotonic, durationMs)
    return { firstOutputMs }
  }

  private summarizeUsage(endedMonotonic: number, attempts: readonly AttemptUsageReport[]): UsageSummary {
    const { input, accounting, startedMonotonic } = this.host
    const validated = this.usage === undefined ? undefined : validateUsageCounters(this.usage, true)
    const preDispatch = !input.routePresent || input.dispatchState() === 'not-sent'
    const aggregate = this.aggregateUsage(validated, attempts)
    let coverage = modelCallCoverage(attempts, accounting.declared, validated, preDispatch)
    if (aggregate.supplemented && coverage === 'complete') coverage = 'partial'
    this.recordUsageError(validated, coverage)
    const durationMs = Math.max(0, endedMonotonic - startedMonotonic)
    return { durationMs, coverage, reported: aggregate.reported, accountingOverflow: aggregate.accountingOverflow }
  }

  private recordUsageError(validated: ValidatedUsage | undefined, coverage: UsageCoverage): void {
    if (validated && (validated.invalidFields.length > 0 || validated.overflow)) {
      this.error ??= usageValidationError(validated, 'call')
    } else if (coverage === 'missing' && this.error === undefined) {
      this.error = Object.freeze({
        type: 'UsageMissingError',
        message: 'model call may have been dispatched but no provider usage was reported',
        code: OBSERVATION_ERROR_CODES.USAGE_MISSING,
      })
    }
  }

  private aggregateUsage(validated: ValidatedUsage | undefined, attempts: readonly AttemptUsageReport[]) {
    const attemptUsage = attempts.length === 0
      ? undefined
      : addUsageCounters(attempts.map(attempt => attempt.reported))
    const combined = mergeUsageLowerBounds(attemptUsage?.counters ?? {}, validated?.reported ?? {})
    const accountingOverflow = usageOverflow(attemptUsage, validated) || combined.overflow
    if (accountingOverflow) this.error ??= Object.freeze({
      type: 'UsageValidationError', message: 'provider usage counters overflowed safe integer aggregation',
      code: OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW,
    })
    const reported = combined.reported
    const supplemented = attemptUsage !== undefined && combined.supplemented
    return { accountingOverflow, reported, supplemented }
  }

  private endEvent(summary: UsageSummary, attempts: readonly AttemptUsageReport[]) {
    const { input, makeEvent } = this.host
    const { durationMs, coverage, reported } = summary
    return makeEvent('end', {
      status: this.status,
      durationMs,
      ...this.finishReason === undefined ? {} : { finishReason: this.finishReason },
      dispatchState: attempts.at(-1)?.dispatchState
        ?? (input.dispatchState() === 'not-sent' ? 'not-sent' : 'unknown'),
      coverage,
      reported: { ...reported },
      attemptCount: attempts.length,
    })
  }

  unsettledReport(): ModelCallReport {
    const endedAt = new Date().toISOString()
    const now = nowMonotonic()
    const attempts = this.host.accounting.unsettledAttempts(endedAt, now)
    const byAttempt = addUsageCounters(attempts.map(attempt => attempt.reported))
    const byCall = validateUsageCounters(this.usage, true)
    const combined = mergeUsageLowerBounds(byAttempt.counters, byCall.reported)
    const reported = combined.reported
    const preDispatch = attempts.length === 0 && !hasUsageCounters(reported)
      && this.host.input.dispatchState() === 'not-sent'
    let coverage: UsageCoverage = hasUsageCounters(reported) ? 'partial' : 'missing'
    if (preDispatch) coverage = 'not-applicable'
    const report = this.makeReport({ durationMs: Math.max(0, now - this.host.startedMonotonic),
      coverage, reported, accountingOverflow: byAttempt.overflow || byCall.overflow || combined.overflow,
    }, endedAt, attempts)
    return Object.freeze({ ...report, status: 'unknown', authoritative: false,
      error: Object.freeze({ type: 'ModelError', code: 'MODEL_TEARDOWN_TIMEOUT',
        message: 'Model stream did not settle before the teardown deadline' }) })
  }

  private makeReport(summary: UsageSummary, endedAt: string, attempts: readonly AttemptUsageReport[]):
  ModelCallReport {
    const { input, runId, modelCallId, span, startedAt, port, mode, tracker } = this.host
    const { durationMs, coverage, reported, accountingOverflow } = summary
    return deepFreeze<ModelCallReport>({
      runId,
      traceId: span.correlation.traceId,
      modelCallId,
      spanId: span.correlation.spanId,
      provider: input.options.provider,
      ...providerMetadata(input),
      model: input.options.model,
      status: this.status,
      startedAt,
      endedAt,
      durationMs,
      ...this.firstOutputMs(durationMs),
      ...this.finishReason === undefined ? {} : { finishReason: this.finishReason },
      dispatchState: attempts.at(-1)?.dispatchState
        ?? (input.dispatchState() === 'not-sent' ? 'not-sent' : 'unknown'),
      coverage,
      reported,
      attempts: [...attempts].sort((left, right) => left.attemptNumber - right.attemptNumber),
      possiblyBilledAttemptsWithoutUsage: billedAttemptsWithoutUsage(attempts, coverage),
      authoritative: authoritativeCoverage(coverage, accountingOverflow),
      delivery: deliverySummary(port, mode, tracker),
      ...this.error === undefined ? {} : { error: this.error },
    })
  }

  private acceptTerminalCheckpoint(rawReceipt: CaptureReceipt, eventId: string): boolean {
    const { tracker, mode } = this.host
    const receipt = validateCaptureReceipt(rawReceipt, eventId)
    tracker.pending -= 1
    applyReceipt(tracker, receipt, true)
    if (receipt.status !== 'accepted' || !receipt.durable) {
      const auditFailure = mode === 'audit'
      tracker.lastFailure = Object.freeze({
        type: 'ObservationCheckpointError',
        message: `terminal observation checkpoint was ${receipt.status}`,
        code: OBSERVATION_ERROR_CODES.CAPTURE_REJECTED,
      })
      return auditFailure
    }
    return false
  }

  private recordChunk(chunk: StreamChunk): void {
    const { input } = this.host
    if ((this.firstOutputMonotonic === undefined || this.host.accounting.awaitingFirstOutput)
      && isOutputChunk(chunk)) this.recordOutputTime()
    if (chunk.type === 'usage') {
      this.usage = chunk.usage
      this.host.accounting.recordUsage(chunk.usage)
    }
    if (chunk.type === 'finish') {
      this.finishReason = chunk.reason.kind
      this.status = finishStatus(chunk)
      this.error = safeFailureFromFinish(chunk, input.isRetryable)
    }
  }

  private recordStreamError(streamError: unknown): void {
    const { input } = this.host
    this.status = input.options.signal?.aborted === true ? 'aborted' : 'error'
    this.error = safeErrorRecord(streamError)
  }

  private recordCloseError(closeError: unknown): void {
    this.error ??= safeErrorRecord(closeError)
  }
}

/** Chunks that carry model output; `block-start` is excluded because it precedes any content. */
function isOutputChunk(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta': case 'reasoning-delta': case 'image-delta': case 'tool-call-delta': case 'block-end':
      return true
    default:
      return false
  }
}

function providerMetadata(input: ModelCallHost['input']) {
  return {
    ...input.providerFamily === undefined ? {} : { providerFamily: input.providerFamily },
    ...input.providerPluginId === undefined ? {} : { providerPluginId: input.providerPluginId },
  }
}

function authoritativeCoverage(coverage: UsageCoverage, overflow: boolean): boolean {
  return (coverage === 'complete' || coverage === 'not-applicable') && !overflow
}

function iteratorClose(iterator: AsyncIterator<StreamChunk> | undefined) {
  return iterator?.return?.bind(iterator)
}

function usageOverflow(aggregate: ReturnType<typeof addUsageCounters> | undefined,
  validated: ValidatedUsage | undefined): boolean {
  return aggregate?.overflow === true || validated?.overflow === true
}
