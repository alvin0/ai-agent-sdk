import { createCoreSpan, createObservationRunScope, createOperationId } from '@ai-agent-sdk/core'
import {
  MemoryObservationExporter,
  createObservability,
  projectLog,
  projectMetrics,
  projectTrace,
} from '@ai-agent-sdk/observability'

export async function runPackedObservabilityFixture() {
  const memory = new MemoryObservationExporter()
  const observation = createObservability({
    exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
  })
  observation.logger({ fields: { component: 'packed' } })
    .warn('packed logger completed', { access_token: 'packed-secret-token' })

  const scope = createObservationRunScope()
  const correlation = createCoreSpan({
    name: 'sdk.model.call', runId: 'packed-run',
    startedAt: new Date().toISOString(), monotonicMs: scope.monotonicMs(),
  }).correlation
  observation.capture({
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence: scope.nextSequence(),
    name: 'sdk.model.call',
    phase: 'end',
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority: 'critical',
    resource: observation.resource,
    correlation,
    data: {
      provider: 'packed', model: 'high-cardinality-model', operation: 'generate',
      status: 'success', durationMs: 5, prompt: 'private packed prompt',
      usageReport: { coverage: 'complete', reported: { inputTokens: 4, outputTokens: 2 } },
    },
  })
  const flush = await observation.flush()
  const events = memory.events()
  const serialized = JSON.stringify(events)
  return {
    eventCount: events.length,
    logLevel: projectLog(events[0])?.level,
    traceName: projectTrace(events[1])?.name,
    metricCount: projectMetrics(events[1]).length,
    complete: flush.complete,
    healthy: observation.health().state,
    safe: !serialized.includes('packed-secret-token') && !serialized.includes('private packed prompt'),
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
