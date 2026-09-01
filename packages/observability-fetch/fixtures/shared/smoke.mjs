import { createCoreSpan, createObservationRunScope, createOperationId } from '@ai-agent-sdk/core'
import { createObservability } from '@ai-agent-sdk/observability'
import {
  FetchObservationExporter,
  flushObservabilityWithWaitUntil,
} from '@ai-agent-sdk/observability-fetch'

// Construct host response objects before the standards-only Node fixture removes
// Node globals; browsers and Workers already provide native Web Response objects.
const retryResponse = new Response(null, { status: 503 })
const acceptedResponse = new Response(null, { status: 204 })

export async function runPackedFetchObservationFixture() {
  const requests = []
  const exporter = new FetchObservationExporter({
    endpoint: 'https://telemetry.example.test/v1/events',
    delay: async () => undefined,
    fetch: async (_input, init) => {
      requests.push(init)
      return requests.length === 1 ? retryResponse : acceptedResponse
    },
  })
  const observation = createObservability({
    mode: 'reliable',
    exporters: [{ exporter, requirement: 'required', boundary: 'remote-acknowledged' }],
  })
  const scope = createObservationRunScope()
  const correlation = createCoreSpan({
    name: 'sdk.model.call', runId: 'packed-fetch-run',
    startedAt: new Date().toISOString(), monotonicMs: scope.monotonicMs(),
  }).correlation
  const receipt = await observation.checkpoint({
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
    data: { status: 'success', prompt: 'private-packed-prompt', authorization: 'Bearer packed-secret' },
  })
  const lifetimes = []
  const flushed = await flushObservabilityWithWaitUntil(observation, pending => lifetimes.push(pending))
  const bodies = requests.map(request => request.body)
  const headers = requests.map(request => request.headers)
  return {
    durable: receipt.durable,
    boundary: receipt.boundary,
    calls: requests.length,
    identicalBody: bodies.length === 2 && bodies[0] === bodies[1],
    identicalKey: headers.length === 2
      && headers[0]['idempotency-key'] === headers[1]['idempotency-key'],
    complete: flushed.complete,
    lifetimeCount: lifetimes.length,
    safe: !String(bodies[0]).includes('private-packed-prompt')
      && !String(bodies[0]).includes('packed-secret'),
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
