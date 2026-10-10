import { deepFreeze } from '../primitives/freeze.ts'
import type { StreamChunk, TokenUsage } from '../stream/chunk.ts'
import { safeErrorRecord, type OperationStatus, type SafeErrorRecord } from '../observation/event.ts'
import { validateCaptureReceipt, type CaptureReceipt } from '../observation/port.ts'
import { ModelCallObservationError, OBSERVATION_ERROR_CODES, type ModelCallHandle,
  type ModelCallReport } from '../observation/report.ts'
import { addUsageCounters, validateUsageCounters,
  type UsageCoverage, type UsageCounters } from '../observation/usage.ts'
import { nowMonotonic, safeFailureFromFinish, applyReceipt, deliverySummary } from './model-call-support.ts'
import { modelCallCoverage, usageValidationError,
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

export class ModelCallRuntime {
  private resolveReport: (report: ModelCallReport) => void = () => {}
  private readonly report = new Promise<ModelCallReport>((resolve) => { this.resolveReport = resolve })
  private finalized = false
  private iterated = false
  private status: OperationStatus = 'unknown'
  private finishReason: string | undefined
  private error: SafeErrorRecord | undefined
  private usage: TokenUsage | undefined

  constructor(private readonly host: ModelCallHost) {}

  private async finalize(): Promise<{ report: ModelCallReport; auditFailure: boolean }> {
    const { port, tracker, mode, capture, effectiveContext } = this.host
    if (this.finalized) return { report: await this.report, auditFailure: false }
    this.finalized = true
    const endedAt = new Date().toISOString()
    const endedMonotonic = nowMonotonic()
    this.closeAttempts(endedAt)

    const summary = this.summarizeUsage(endedMonotonic)
    const endEvent = this.endEvent(summary)
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

    const finalReport = this.makeReport(summary, endedAt)
    this.resolveReport(finalReport)
    return { report: finalReport, auditFailure }
  }

  private async *iterate(): AsyncGenerator<StreamChunk> {
    const { input, effectiveContext } = this.host
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
        this.recordChunk(chunk)
        yield chunk
      }
    } catch (streamError) {
      thrown = streamError
      this.recordStreamError(streamError)
      throw streamError
    } finally {
      if (!sourceDone) {
        if (thrown === undefined) this.status = 'aborted'
        const close = iteratorClose(iterator)
        if (close) try { await close() } catch (closeError) { this.recordCloseError(closeError) }
      }
      const terminal = await this.finalize()
      if (terminal.auditFailure) {
        throw new ModelCallObservationError('audit observation checkpoint failed after model-call finalization',
          terminal.report)
      }
    }
  }

  handle(): ModelCallHandle {
    const { runId, modelCallId } = this.host
    const runtime = this
    return Object.freeze({
      runId,
      modelCallId,
      report: this.report,
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        if (runtime.iterated) {
          return (async function* () { throw new Error('a model call handle can only be iterated once') })()
        }
        runtime.iterated = true
        return runtime.iterate()
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
    for (const closeAttempt of [...openAttempts]) {
      closeAttempt({
        status: this.status === 'aborted' ? 'aborted' : 'unknown',
        dispatchState: input.dispatchState() === 'not-sent' ? 'not-sent' : 'unknown',
        ...(this.error === undefined ? {} : { error: this.error }),
      })
    }
    try { span.end(this.status, endedAt,
      scope.monotonicMs()) } catch (spanError) { tracker.lastFailure = safeErrorRecord(spanError) }

  }

  private summarizeUsage(endedMonotonic: number): UsageSummary {
    const { input, accounting, startedMonotonic } = this.host
    const { attempts } = accounting
    const validated = this.usage === undefined ? undefined : validateUsageCounters(this.usage, true)
    const preDispatch = !input.routePresent || input.dispatchState() === 'not-sent'
    const coverage = modelCallCoverage(attempts, accounting.declared, validated, preDispatch)
    this.recordUsageError(validated, coverage)
    const durationMs = Math.max(0, endedMonotonic - startedMonotonic)
    return { durationMs, coverage, ...this.aggregateUsage(validated) }
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

  private aggregateUsage(validated: ValidatedUsage | undefined) {
    const { attempts } = this.host.accounting
    const attemptUsage = attempts.length === 0
      ? undefined
      : addUsageCounters(attempts.map(attempt => attempt.reported))
    const accountingOverflow = usageOverflow(attemptUsage, validated)
    if (accountingOverflow) this.error ??= Object.freeze({
      type: 'UsageValidationError', message: 'provider usage counters overflowed safe integer aggregation',
      code: OBSERVATION_ERROR_CODES.USAGE_COUNTER_OVERFLOW,
    })
    const reported = attemptUsage?.counters ?? validated?.reported ?? {}
    return { accountingOverflow, reported }
  }

  private endEvent(summary: UsageSummary) {
    const { input, makeEvent, accounting } = this.host
    const { attempts } = accounting
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

  private makeReport(summary: UsageSummary, endedAt: string): ModelCallReport {
    const { input, runId, modelCallId, span, startedAt, accounting, port, mode, tracker } = this.host
    const { attempts } = accounting
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
    if (chunk.type === 'usage') this.usage = chunk.usage
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
