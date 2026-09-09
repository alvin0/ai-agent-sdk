import type { ObservationEvent } from '../../observation/index.ts'
import type { RuntimeObservationHealthSnapshot } from '../observation/health.ts'
import { eventHasIntegrationEvidence } from './integration.ts'

export interface ExpectedIntegrationOperation {
  readonly family: string
  readonly operation: string
  readonly logicalOperations: number
  readonly attempts: number
}

export interface IntegrationCompletenessInput {
  readonly expected?: readonly ExpectedIntegrationOperation[]
  readonly events: readonly ObservationEvent[]
  readonly acceptedEventIds?: readonly string[]
  readonly health: Pick<RuntimeObservationHealthSnapshot, 'integrationEvidence'>
  readonly source: 'authoritative-export' | 'diagnostic-ring'
  readonly diagnosticEvictions?: number
  readonly cleanup: 'complete' | 'failed' | 'unavailable'
}

export interface IntegrationCompletenessResult {
  readonly status: 'complete' | 'incomplete' | 'unknown'
  readonly reason:
    | 'complete'
    | 'expected-instrumentation-unavailable'
    | 'evidence-counter-overflow'
    | 'evidence-loss'
    | 'diagnostic-ring-incomplete'
    | 'delivery-acknowledgment-unavailable'
    | 'delivery-acknowledgment-incomplete'
    | 'operation-cardinality-mismatch'
    | 'operation-pairing-invalid'
    | 'cleanup-failed'
    | 'cleanup-unavailable'
}

/** Reconcile trace evidence; queue health or a critical checkpoint alone can never certify it. */
export function assessIntegrationCompleteness(
  input: IntegrationCompletenessInput,
): IntegrationCompletenessResult {
  if (input.expected === undefined) return result('unknown', 'expected-instrumentation-unavailable')
  const counters = input.health.integrationEvidence
  if (Object.values(counters).some(value => value >= Number.MAX_SAFE_INTEGER)) {
    return result('unknown', 'evidence-counter-overflow')
  }
  if (counters.filtered > 0 || counters.dropped > 0 || counters.rejected > 0) {
    return result('incomplete', 'evidence-loss')
  }
  if (input.source === 'diagnostic-ring' && (input.diagnosticEvictions ?? 0) > 0) {
    return result('unknown', 'diagnostic-ring-incomplete')
  }
  if (input.cleanup === 'unavailable') return result('unknown', 'cleanup-unavailable')
  if (input.cleanup === 'failed') return result('incomplete', 'cleanup-failed')
  if (input.acceptedEventIds === undefined) {
    return result('unknown', 'delivery-acknowledgment-unavailable')
  }
  const expected = new Map(input.expected.map(row => [key(row.family, row.operation), row]))
  const evidence = input.events.filter(event => eventHasIntegrationEvidence(event))
    .filter(event => expected.has(eventKey(event)))
  const acknowledged = new Set(input.acceptedEventIds)
  if (evidence.some(event => !acknowledged.has(event.eventId))) {
    return result('incomplete', 'delivery-acknowledgment-incomplete')
  }
  const logicalCounts = new Map<string, number>(), attemptCounts = new Map<string, number>()
  const logicalPairs = new Map<string, { start: number; terminal: number }>()
  const attemptPairs = new Map<string, { start: number; terminal: number }>()
  for (const event of evidence) {
    const fields = event.data.fields as Record<string, unknown>
    const operationKey = key(String(fields.integrationFamily), String(fields.integrationOperation))
    const kind = fields.kind
    if (kind === 'logical-start' || kind === 'logical-terminal') {
      const id = `${operationKey}:${String(fields.operationId)}`
      const pair = logicalPairs.get(id) ?? { start: 0, terminal: 0 }
      if (kind === 'logical-start') {
        pair.start++
        logicalCounts.set(operationKey, (logicalCounts.get(operationKey) ?? 0) + 1)
      } else pair.terminal++
      logicalPairs.set(id, pair)
    }
    if (kind === 'attempt-start' || kind === 'attempt-terminal') {
      const id = `${operationKey}:${String(fields.operationId)}:${String(fields.attemptId)}`
      const pair = attemptPairs.get(id) ?? { start: 0, terminal: 0 }
      if (kind === 'attempt-start') {
        pair.start++
        attemptCounts.set(operationKey, (attemptCounts.get(operationKey) ?? 0) + 1)
      } else pair.terminal++
      attemptPairs.set(id, pair)
    }
  }
  for (const [operationKey, row] of expected) {
    if ((logicalCounts.get(operationKey) ?? 0) !== row.logicalOperations
      || (attemptCounts.get(operationKey) ?? 0) !== row.attempts) {
      return result('incomplete', 'operation-cardinality-mismatch')
    }
  }
  if ([...logicalPairs.values(), ...attemptPairs.values()]
    .some(pair => pair.start !== 1 || pair.terminal !== 1)) {
    return result('incomplete', 'operation-pairing-invalid')
  }
  return result('complete', 'complete')
}

function eventKey(event: ObservationEvent): string {
  const fields = event.data.fields as Record<string, unknown>
  return key(String(fields.integrationFamily), String(fields.integrationOperation))
}
function key(family: string, operation: string): string { return `${family}\u0000${operation}` }
function result(status: IntegrationCompletenessResult['status'], reason: IntegrationCompletenessResult['reason']):
IntegrationCompletenessResult { return Object.freeze({ status, reason }) }
