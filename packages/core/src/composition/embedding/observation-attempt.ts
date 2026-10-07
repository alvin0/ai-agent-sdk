import { createOperationId, type CorrelationContext } from '../../observation/context.ts'
import type {
  EndProviderAttemptInput, ProviderAttemptHandle, StartProviderAttemptInput,
} from '../../observation/report.ts'
import type { ObservationSpan } from '../../observation/port.ts'
import { validateUsageCounters, type AttemptUsageReport, type UsageCoverage } from '../../observation/usage.ts'
import { deepFreeze } from '../../primitives/freeze.ts'
import { openSpanSafely, type ObservationChannel } from './observation-channel.ts'

/**
 * Attempt accounting for one `Physical_Batch`.
 *
 * Produces the same `sdk.provider.attempt` start/end pair the generation ledger
 * produces, so an embedding retry is countable with the same tooling. Usage is
 * passed through `validateUsageCounters` rather than trusted: a malformed
 * provider report becomes a coverage downgrade, never a zero.
 */
export function createAttemptStarter(
  channel: ObservationChannel,
  parent: CorrelationContext,
  nextAttemptNumber: () => number,
): (input: StartProviderAttemptInput, signal?: AbortSignal) => Promise<ProviderAttemptHandle> {
  return async input => beginAttempt(channel, parent, nextAttemptNumber, input)
}

function beginAttempt(
  channel: ObservationChannel, parent: CorrelationContext,
  nextAttemptNumber: () => number, input: StartProviderAttemptInput,
): ProviderAttemptHandle {

  const attemptNumber = nextAttemptNumber()
  const attemptId = createOperationId()
  const startedAt = new Date().toISOString()
  const startedMonotonic = channel.scope.monotonicMs()
  const span = openSpanSafely(channel.port, {
    name: 'sdk.provider.attempt',
    runId: channel.runId,
    parent,
    correlation: {
      attemptId,
      ...(parent.modelCallId === undefined ? {} : { modelCallId: parent.modelCallId }),
    },
    startedAt,
    monotonicMs: startedMonotonic,
  })
  channel.capture('sdk.provider.attempt', 'start', span.correlation, {
    provider: input.provider,
    model: input.model,
    attemptNumber,
    method: input.method,
    // Origin only: a path or query string can carry identifiers the caller
    // considers content, and `StartProviderAttemptInput` already forbids them.
    origin: input.origin,
    dispatchState: 'not-sent',
  })

  const end = createAttemptEnd({ channel, input, attemptNumber, attemptId, startedAt, startedMonotonic, span })
  return Object.freeze({ attemptId, attemptNumber, traceparent: span.traceparent, end })
}
function createAttemptEnd(state: {
  channel: ObservationChannel
  input: StartProviderAttemptInput
  attemptNumber: number
  attemptId: string
  startedAt: string
  startedMonotonic: number
  span: ObservationSpan
}) {
  const { channel, input, attemptNumber, attemptId, startedAt, startedMonotonic, span } = state
  let report: AttemptUsageReport | undefined
  const end = (terminal: EndProviderAttemptInput): AttemptUsageReport => {
    // Idempotent: `attempt.end` is called exactly once per attempt on every
    // exit path of the transport, and a second call must not invent a record.
    if (report !== undefined) return report
    const endedAt = new Date().toISOString()
    const endedMonotonic = channel.scope.monotonicMs()
    const validated = validateUsageCounters(terminal.reported, true)
    const coverage = attemptCoverage(terminal, validated)
    const durationMs = Math.max(0, endedMonotonic - startedMonotonic)
    span.end(terminal.status, endedAt, endedMonotonic)
    const correlation = terminal.providerRequestId === undefined
      ? span.correlation
      : deepFreeze({ ...span.correlation, providerRequestId: terminal.providerRequestId })
    channel.capture('sdk.provider.attempt', 'end', correlation, {
      status: terminal.status,
      durationMs,
      origin: input.origin,
      // Reported by the transport, never re-derived here (Requirement 4.8).
      dispatchState: terminal.dispatchState,
      coverage,
      reported: { ...validated.reported },
      ...(terminal.httpStatus === undefined ? {} : { httpStatus: terminal.httpStatus }),
      ...(terminal.providerRequestId === undefined ? {} : { providerRequestId: terminal.providerRequestId }),
      ...(terminal.error === undefined ? {} : { error: { ...terminal.error } }),
    })
    report = deepFreeze({
      attemptId,
      spanId: span.correlation.spanId,
      attemptNumber,
      status: terminal.status,
      startedAt,
      endedAt,
      durationMs,
      dispatchState: terminal.dispatchState,
      coverage,
      reported: validated.reported,
      origin: input.origin,
      ...(terminal.httpStatus === undefined ? {} : { httpStatus: terminal.httpStatus }),
      ...(terminal.providerRequestId === undefined ? {} : { providerRequestId: terminal.providerRequestId }),
      ...(terminal.error === undefined ? {} : { error: terminal.error }),
    })
    return report
  }
  return end
}

function attemptCoverage(
  terminal: EndProviderAttemptInput, validated: ReturnType<typeof validateUsageCounters>,
): UsageCoverage {
  if (terminal.dispatchState === 'not-sent') return 'not-applicable'
  if (validated.complete) return 'complete'
  return Object.keys(validated.reported).length > 0 ? 'partial' : 'missing'
}
