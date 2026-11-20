import {
  createCoreSpan, createObservationRunScope, createOperationId, type ObservationEvent,
} from '@alvin0/ai-agent-sdk-core'
import type { ObservationBatch } from '@alvin0/ai-agent-sdk-core/observability'

export type FetchInput = Parameters<typeof fetch>[0]

export function observationEvent(sequence = 1): ObservationEvent {
  const scope = createObservationRunScope()
  return {
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence,
    name: 'sdk.model.call',
    phase: 'end',
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority: 'critical',
    resource: {
      sdkName: 'ai-agent-sdk', sdkVersion: '0.1.0', runtime: 'edge',
    },
    correlation: createCoreSpan({
      name: 'sdk.model.call', runId: 'fetch-run',
      startedAt: new Date().toISOString(), monotonicMs: 0,
    }).correlation,
    data: { status: 'success' },
  }
}

export function batch(events: readonly ObservationEvent[] = [observationEvent()]): ObservationBatch {
  return Object.freeze({
    schemaVersion: 1,
    batchId: createOperationId(),
    createdAt: new Date().toISOString(),
    events,
  })
}

export function injectedFetch(
  implementation: (input: FetchInput, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch
}
