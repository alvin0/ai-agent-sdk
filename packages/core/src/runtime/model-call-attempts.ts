import { deepFreeze } from '../primitives/freeze.ts'
import { createOperationId, type ObservationRunScope } from '../observation/context.ts'
import { safeErrorRecord, type ObservationEvent } from '../observation/event.ts'
import { validateCaptureReceipt, type CaptureReceipt, type DeliveryMode,
  type ObservationPort, type ObservationSpan } from '../observation/port.ts'
import { AgentSdkError } from '../errors/agent-sdk-error.ts'
import { OBSERVATION_ERROR_CODES, type EndProviderAttemptInput, type ProviderAttemptHandle,
  type ProviderRetryScheduledInput, type StartProviderAttemptInput } from '../observation/report.ts'
import { validateUsageCounters, type AttemptUsageReport } from '../observation/usage.ts'
import type { CreateModelCallHandleOptions } from './model-call-handle.ts'
import { nowMonotonic, openContainedSpan, applyReceipt, type DeliveryTracker } from './model-call-support.ts'
import { attemptCoverage, invalidAttemptUsage } from './model-call-usage.ts'

interface AttemptHost {
  readonly input: CreateModelCallHandleOptions
  readonly scope: ObservationRunScope
  readonly span: ObservationSpan
  readonly port: ObservationPort
  readonly tracker: DeliveryTracker
  readonly mode: DeliveryMode
  readonly runId: string
  readonly modelCallId: string
  capture(event: ObservationEvent): void
}

interface AttemptState {
  readonly attemptInput: StartProviderAttemptInput
  readonly attemptNumber: number
  readonly attemptId: string
  readonly attemptStartedAt: string
  readonly attemptStartedMonotonic: number
  readonly attemptSpan: ObservationSpan
}

export class ModelCallAttempts {
  readonly attempts: AttemptUsageReport[] = []
  readonly openAttempts = new Set<(input: EndProviderAttemptInput) => AttemptUsageReport>()
  private nextAttemptNumber = 1
  declared = false

  constructor(private readonly host: AttemptHost) {}

  recordProviderRetry(retry: ProviderRetryScheduledInput): void {
    const { input, scope, span, capture } = this.host
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

  async startProviderAttempt(
    attemptInput: StartProviderAttemptInput,
    signal?: AbortSignal,
  ): Promise<ProviderAttemptHandle> {
    const { port, tracker, mode, scope, span, runId, modelCallId, capture } = this.host
    const attemptNumber = this.nextAttemptNumber++
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
    const startEvent = this.startEvent(attemptInput, { attemptNumber, attemptStartedAt, attemptSpan })

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
        this.acceptCheckpoint(rawReceipt, startEvent.eventId, attemptSpan)
      } catch (checkpointError) {
        throw this.rejectCheckpoint(checkpointError, attemptSpan)
      }
    } else capture(startEvent)

    const end = this.attemptEnd({
      attemptInput, attemptNumber, attemptId, attemptStartedAt, attemptStartedMonotonic, attemptSpan,
    })
    this.openAttempts.add(end)
    return Object.freeze({ attemptId, attemptNumber, traceparent: attemptSpan.traceparent, end })
  }
  private startEvent(attemptInput: StartProviderAttemptInput,
    state: Pick<AttemptState, 'attemptNumber' | 'attemptStartedAt' | 'attemptSpan'>,
  ): ObservationEvent<'sdk.provider.attempt'> {
    const { input, scope } = this.host
    const { attemptNumber, attemptStartedAt, attemptSpan } = state
    return deepFreeze({
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

  }

  private attemptEnd(state: AttemptState): (input: EndProviderAttemptInput) => AttemptUsageReport {
    const { input, scope, capture } = this.host
    const { attemptInput, attemptNumber, attemptId, attemptStartedAt, attemptStartedMonotonic, attemptSpan } = state
    let finalReport: AttemptUsageReport | undefined
    const end = (endInput: EndProviderAttemptInput): AttemptUsageReport => {
      if (finalReport !== undefined) return finalReport
      const endedAt = new Date().toISOString()
      const endedMonotonic = nowMonotonic()
      const validated = validateUsageCounters(endInput.reported, true)
      const coverage = attemptCoverage(endInput, validated)
      const invalidError = invalidAttemptUsage(validated)
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
          origin: attemptInput.origin,
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
        startedAt: attemptStartedAt, endedAt, durationMs,
        dispatchState: endInput.dispatchState,
        coverage,
        reported: validated.reported,
        origin: attemptInput.origin,
        ...endInput.httpStatus === undefined ? {} : { httpStatus: endInput.httpStatus },
        ...endInput.providerRequestId === undefined ? {} : { providerRequestId: endInput.providerRequestId },
        ...terminalError === undefined ? {} : { error: terminalError },
      })
      this.attempts.push(finalReport)
      this.openAttempts.delete(end)
      return finalReport
    }
    return end
  }

  private acceptCheckpoint(rawReceipt: CaptureReceipt, eventId: string, attemptSpan: ObservationSpan): void {
    const { tracker, scope } = this.host
    const receipt = validateCaptureReceipt(rawReceipt, eventId)
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
  }

  private rejectCheckpoint(checkpointError: unknown, attemptSpan: ObservationSpan): AgentSdkError {
    const { tracker, scope } = this.host
    if (tracker.pending > 0) tracker.pending -= 1
    if (!(checkpointError instanceof AgentSdkError
      && checkpointError.code === OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE)) {
      tracker.rejected += 1
      tracker.lastFailure = safeErrorRecord(checkpointError)
      attemptSpan.end('rejected', new Date().toISOString(), scope.monotonicMs())
    }
    return checkpointError instanceof AgentSdkError
      && checkpointError.code === OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE
      ? checkpointError
      : new AgentSdkError(
        'audit observation is unavailable before provider dispatch',
        OBSERVATION_ERROR_CODES.AUDIT_UNAVAILABLE,
        { cause: checkpointError },
      )
  }
}
