import { trace } from '@opentelemetry/api'
import { createOperationId } from '@alvin0/ai-agent-sdk-core'
import { createObservability } from '@alvin0/ai-agent-sdk-core/observability'
import { createOpenTelemetryBridge } from '@alvin0/ai-agent-sdk-observability-otel'

class Span {
  constructor(name, context, parent, attributes) {
    this.name = name
    this.context = context
    this.parent = parent
    this.attributes = { ...attributes }
    this.ended = false
  }
  spanContext() { return this.context }
  setAttribute(key, value) { this.attributes[key] = value; return this }
  setAttributes(value) { Object.assign(this.attributes, value); return this }
  addEvent() { return this }
  addLink() { return this }
  addLinks() { return this }
  setStatus(value) { this.status = value; return this }
  updateName(value) { this.name = value; return this }
  end() { this.ended = true }
  isRecording() { return true }
  recordException() {}
}

export async function runPackedOtelFixture() {
  const spans = []
  let sequence = 1
  const tracer = {
    startSpan(name, options, parentContext) {
      const parent = trace.getSpanContext(parentContext)
      const context = {
        traceId: parent?.traceId ?? 'a'.repeat(32),
        spanId: (spans.length + 1).toString(16).padStart(16, '0'),
        traceFlags: 0,
      }
      const span = new Span(name, context, parent?.spanId, options?.attributes)
      spans.push(span)
      return span
    },
  }
  const measurements = []
  const instrument = name => ({
    add: (value, attributes) => measurements.push({ name, value, attributes }),
    record: (value, attributes) => measurements.push({ name, value, attributes }),
  })
  const meter = {
    createCounter: instrument,
    createHistogram: instrument,
  }
  const logs = []
  const logger = { enabled: () => true, emit: record => logs.push(record) }
  const providerBefore = trace.getTracerProvider()
  const bridge = createOpenTelemetryBridge({ tracer, meter, logger })
  const observation = createObservability({ openSpan: bridge.openSpan, processors: [bridge.processor] })
  const span = observation.openSpan({
    name: 'sdk.model.call', runId: 'packed-otel-run',
    startedAt: new Date().toISOString(), monotonicMs: 0,
    correlation: { modelCallId: 'packed-call' },
  })
  const base = (phase, data) => ({
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence: sequence++,
    name: 'sdk.model.call',
    phase,
    occurredAt: new Date().toISOString(),
    monotonicMs: sequence,
    priority: 'critical',
    resource: observation.resource,
    correlation: span.correlation,
    data,
  })
  observation.capture(base('start', {
    provider: 'packed', model: 'packed-model', operation: 'stream', prompt: 'private packed prompt',
  }))
  observation.logger({ correlation: span.correlation }).info('packed log', { component: 'packed' })
  span.end('success', new Date().toISOString(), 2)
  observation.capture(base('end', {
    status: 'success', durationMs: 2_000, coverage: 'complete',
    reported: { inputTokens: 3, outputTokens: 2 },
  }))
  await observation.flush()
  const serialized = JSON.stringify({ spans, measurements, logs })
  return {
    spanCount: spans.length,
    traceparent: span.traceparent,
    ended: spans[0]?.ended,
    semanticDuration: measurements.some(value => value.name === 'gen_ai.client.operation.duration' && value.value === 2),
    semanticTokens: measurements.filter(value => value.name === 'gen_ai.client.token.usage').length,
    logCount: logs.length,
    safe: !serialized.includes('private packed prompt'),
    providerUnchanged: trace.getTracerProvider() === providerBefore,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
