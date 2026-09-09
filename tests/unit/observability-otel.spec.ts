import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type MetricAttributes,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api'
import type { LogRecord, Logger } from '@opentelemetry/api-logs'
import { readFile } from 'node:fs/promises'
import {
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  type CorrelationContext,
  type JsonObject,
  type ObservationEvent,
  type ObservationEventName,
  type ObservationPhase,
  type ObservationResource,
  type SafeErrorRecord,
} from '@alvin0/ai-agent-sdk-core'
import { createObservability } from '@alvin0/ai-agent-sdk-core/observability'
import {
  OTEL_SEMANTIC_CONVENTIONS_COMMIT,
  createOpenTelemetryBridge,
} from '@alvin0/ai-agent-sdk-observability-otel'
import { describe, expect, it, vi } from 'vitest'

const RESOURCE: ObservationResource = {
  sdkName: 'ai-agent-sdk', sdkVersion: '0.1.0', runtime: 'node', serviceName: 'otel-test',
}

interface Measurement {
  readonly name: string
  readonly value: number
  readonly attributes: MetricAttributes
}

class FakeInstrument {
  constructor(readonly name: string, private readonly output: Measurement[]) {}
  add(value: number, attributes: MetricAttributes = {}): void { this.output.push({ name: this.name, value, attributes }) }
  record(value: number, attributes: MetricAttributes = {}): void { this.output.push({ name: this.name, value, attributes }) }
}

class FakeMeter {
  readonly measurements: Measurement[] = []
  readonly instruments: Array<{ name: string; kind: 'counter' | 'histogram'; unit?: string }> = []

  createCounter(name: string, options?: { unit?: string }): Counter {
    this.instruments.push({ name, kind: 'counter', ...options?.unit === undefined ? {} : { unit: options.unit } })
    return new FakeInstrument(name, this.measurements) as unknown as Counter
  }

  createHistogram(name: string, options?: { unit?: string }): Histogram {
    this.instruments.push({ name, kind: 'histogram', ...options?.unit === undefined ? {} : { unit: options.unit } })
    return new FakeInstrument(name, this.measurements) as unknown as Histogram
  }
}

class FakeSpan implements Span {
  readonly attributes: Record<string, unknown> = {}
  readonly events: Array<{ name: string; attributes?: Attributes }> = []
  readonly statuses: Array<{ code: SpanStatusCode; message?: string }> = []
  readonly names: string[]
  endedAt: unknown

  constructor(
    name: string,
    readonly context: SpanContext,
    readonly parentSpanId: string | undefined,
    initial: Attributes | undefined,
  ) {
    this.names = [name]
    Object.assign(this.attributes, initial)
  }

  spanContext(): SpanContext { return this.context }
  setAttribute(key: string, value: unknown): this { this.attributes[key] = value; return this }
  setAttributes(attributes: Attributes): this { Object.assign(this.attributes, attributes); return this }
  addEvent(name: string, attributes?: Attributes): this {
    this.events.push({ name, ...attributes === undefined ? {} : { attributes } })
    return this
  }
  addLink(): this { return this }
  addLinks(): this { return this }
  setStatus(status: { code: SpanStatusCode; message?: string }): this { this.statuses.push(status); return this }
  updateName(name: string): this { this.names.push(name); return this }
  end(endTime?: unknown): void { this.endedAt = endTime ?? true }
  isRecording(): boolean { return true }
  recordException(): void {}
}

class FakeTracer implements Tracer {
  readonly spans: FakeSpan[] = []
  private next = 1

  constructor(
    private readonly traceFlags = 1,
    private readonly invalid = false,
    private readonly disconnectChildren = false,
  ) {}

  startSpan(name: string, options?: SpanOptions, context?: Context): Span {
    const parent = context === undefined ? undefined : trace.getSpanContext(context)
    const sequence = this.next++
    const traceId = this.invalid
      ? '0'.repeat(32)
      : this.disconnectChildren && parent !== undefined
        ? sequence.toString(16).padStart(32, '0')
        : parent?.traceId ?? 'a'.repeat(32)
    const spanId = this.invalid ? '0'.repeat(16) : sequence.toString(16).padStart(16, '0')
    const span = new FakeSpan(name, { traceId, spanId, traceFlags: this.traceFlags }, parent?.spanId, options?.attributes)
    this.spans.push(span)
    return span
  }

  startActiveSpan(..._args: never[]): never { throw new Error('bridge must not call startActiveSpan') }
}

class FakeLogger implements Logger {
  readonly records: LogRecord[] = []
  enabled = vi.fn(() => true)
  emit(record: LogRecord): void { this.records.push(record) }
}

function event(
  sequence: number,
  name: ObservationEventName,
  phase: ObservationPhase,
  correlation: CorrelationContext,
  data: JsonObject,
): ObservationEvent {
  return {
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence,
    name,
    phase,
    occurredAt: new Date('2030-01-02T03:04:05.000Z').toISOString(),
    monotonicMs: sequence,
    priority: name === 'sdk.log' ? 'normal' : 'critical',
    resource: RESOURCE,
    correlation,
    data,
  }
}

function openCoreParent(runId: string): CorrelationContext {
  return createCoreSpan({
    name: 'sdk.agent.run', runId, startedAt: new Date().toISOString(), monotonicMs: 0,
  }).correlation
}

describe('OpenTelemetry observation bridge', () => {
  it('opens real unsampled spans synchronously and preserves explicit logical/attempt topology', () => {
    const tracer = new FakeTracer(0)
    const meter = new FakeMeter()
    const bridge = createOpenTelemetryBridge({ tracer, meter: meter as unknown as Meter })
    const observation = createObservability({ openSpan: bridge.openSpan, processors: [bridge.processor] })
    const runId = 'otel-topology-run'
    const run = observation.openSpan({
      name: 'sdk.agent.run', runId, startedAt: '2030-01-02T03:04:00.000Z', monotonicMs: 0,
      correlation: { conversationId: 'conversation-1' },
    })
    expect(run.correlation).toMatchObject({ traceId: 'a'.repeat(32), spanId: '0000000000000001' })
    expect(run.traceparent).toBe(`00-${'a'.repeat(32)}-0000000000000001-00`)
    const model = observation.openSpan({
      name: 'sdk.model.call', runId, parent: run.correlation,
      startedAt: '2030-01-02T03:04:01.000Z', monotonicMs: 1,
      correlation: { modelCallId: 'model-call-1' },
    })
    const attempt = observation.openSpan({
      name: 'sdk.provider.attempt', runId, parent: model.correlation,
      startedAt: '2030-01-02T03:04:02.000Z', monotonicMs: 2,
      correlation: { modelCallId: 'model-call-1', attemptId: 'attempt-1' },
    })
    const retry = observation.openSpan({
      name: 'sdk.provider.attempt', runId, parent: model.correlation,
      startedAt: '2030-01-02T03:04:03.000Z', monotonicMs: 3,
      correlation: { modelCallId: 'model-call-1', attemptId: 'attempt-2' },
    })
    expect(tracer.spans.map(span => span.parentSpanId)).toEqual([
      undefined, '0000000000000001', '0000000000000002', '0000000000000002',
    ])
    expect(model.correlation.traceId).toBe(run.correlation.traceId)
    expect(attempt.correlation.parentSpanId).toBe(model.correlation.spanId)
    expect(retry.correlation.parentSpanId).toBe(model.correlation.spanId)
    expect(tracer.spans).toHaveLength(4)
  })

  it('maps golden GenAI spans, reported usage, SDK metrics, and correlated logs without competing spans', () => {
    const tracer = new FakeTracer()
    const meter = new FakeMeter()
    const logger = new FakeLogger()
    const bridge = createOpenTelemetryBridge({ tracer, meter: meter as unknown as Meter, logger })
    const observation = createObservability({ openSpan: bridge.openSpan, processors: [bridge.processor] })
    const runId = 'otel-golden-run'
    const scope = createObservationRunScope()
    const run = observation.openSpan({
      name: 'sdk.agent.run', runId, startedAt: '2030-01-02T03:04:00.000Z', monotonicMs: 0,
    })
    observation.capture(event(scope.nextSequence(), 'sdk.agent.run', 'start', run.correlation, {
      agentId: 'agent-1', mode: 'basic', maxTurns: 2,
    }))
    const model = observation.openSpan({
      name: 'sdk.model.call', runId, parent: run.correlation,
      startedAt: '2030-01-02T03:04:01.000Z', monotonicMs: 1,
      correlation: { modelCallId: 'call-1' },
    })
    observation.capture(event(scope.nextSequence(), 'sdk.model.call', 'start', model.correlation, {
      provider: 'openai', model: 'gpt-test', operation: 'stream',
      prompt: 'PRIVATE_OTEL_PROMPT/BODY~SENTINEL%',
    }))
    observation.capture(event(scope.nextSequence(), 'sdk.log', 'point', model.correlation, {
      level: 'warn', message: 'safe diagnostic', fields: { component: 'provider' },
    }))
    model.end('success', '2030-01-02T03:04:03.000Z', 3)
    observation.capture(event(scope.nextSequence(), 'sdk.model.call', 'end', model.correlation, {
      status: 'success', durationMs: 2_000, coverage: 'complete',
      reported: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 1, outputTokens: 4 },
      usageReport: { estimated: { inputTokens: 99 } },
    }))
    run.end('success', '2030-01-02T03:04:04.000Z', 4)
    observation.capture(event(scope.nextSequence(), 'sdk.agent.run', 'end', run.correlation, {
      status: 'success', durationMs: 4_000, completed: true,
      usage: {
        reported: { inputTokens: 10, outputTokens: 4 },
        estimated: { outputTokens: 7 },
        coverage: { complete: 1, partial: 0, estimated: 0, missing: 0, notApplicable: 0 },
      },
    }))

    expect(tracer.spans).toHaveLength(2)
    const modelSpan = tracer.spans[1]!
    expect(modelSpan.names).toContain('chat gpt-test')
    expect(modelSpan.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-test',
      'gen_ai.usage.input_tokens': 13,
      'gen_ai.usage.output_tokens': 4,
    })
    expect(JSON.stringify(modelSpan.attributes)).not.toContain('PRIVATE_OTEL_PROMPT/BODY~SENTINEL%')
    expect(modelSpan.statuses.at(-1)?.code).toBe(SpanStatusCode.OK)
    expect(modelSpan.endedAt).toBeInstanceOf(Date)

    const semanticTokens = meter.measurements.filter(item => item.name === 'gen_ai.client.token.usage')
    expect(semanticTokens.map(item => [item.value, item.attributes['gen_ai.token.type']])).toEqual([
      [13, 'input'], [4, 'output'],
    ])
    expect(semanticTokens.every(item => item.attributes['ai_agent_sdk.usage.source'] === 'reported')).toBe(true)
    expect(meter.measurements).toContainEqual(expect.objectContaining({
      name: 'gen_ai.client.operation.duration', value: 2,
    }))
    expect(meter.measurements).toContainEqual(expect.objectContaining({
      name: 'gen_ai.invoke_agent.duration', value: 4,
    }))
    expect(meter.measurements).toContainEqual(expect.objectContaining({
      name: 'ai_agent_sdk.token.usage', value: 99,
      attributes: expect.objectContaining({ 'ai_agent_sdk.usage.source': 'estimated' }),
    }))
    expect(logger.records).toHaveLength(1)
    expect(trace.getSpanContext(logger.records[0]?.context as Context)).toMatchObject({
      traceId: model.correlation.traceId, spanId: model.correlation.spanId,
    })
  })

  it('adds content attributes only under an explicit full-content bridge policy', () => {
    const tracer = new FakeTracer()
    const bridge = createOpenTelemetryBridge({
      tracer,
      meter: new FakeMeter() as unknown as Meter,
      content: 'full',
    })
    const observation = createObservability({
      content: 'full', openSpan: bridge.openSpan, processors: [bridge.processor],
    })
    const span = observation.openSpan({
      name: 'sdk.model.call', runId: 'content-run', parent: openCoreParent('content-run'),
      startedAt: new Date().toISOString(), monotonicMs: 0,
    })
    observation.capture(event(1, 'sdk.model.call', 'start', span.correlation, {
      provider: 'openai', model: 'gpt-test', operation: 'stream', prompt: 'explicit content',
    }))
    expect(tracer.spans[0]?.attributes['gen_ai.input.messages']).toBe('explicit content')
  })

  it('does not lose provider-reported cache-only input usage', () => {
    const tracer = new FakeTracer()
    const meter = new FakeMeter()
    const bridge = createOpenTelemetryBridge({ tracer, meter: meter as unknown as Meter })
    const observation = createObservability({ openSpan: bridge.openSpan, processors: [bridge.processor] })
    const span = observation.openSpan({
      name: 'sdk.model.call', runId: 'cache-run', startedAt: new Date().toISOString(), monotonicMs: 0,
    })
    observation.capture(event(1, 'sdk.model.call', 'end', span.correlation, {
      status: 'success', durationMs: 1, coverage: 'complete',
      reported: { cacheReadTokens: 8, cacheWriteTokens: 2, outputTokens: 1 },
    }))
    expect(tracer.spans[0]?.attributes['gen_ai.usage.input_tokens']).toBe(10)
    expect(meter.measurements).toContainEqual(expect.objectContaining({
      name: 'gen_ai.client.token.usage', value: 10,
      attributes: expect.objectContaining({ 'gen_ai.token.type': 'input' }),
    }))
  })

  it('flags no-op and disconnected tracer contexts with the stable code and lets the bus fall back', () => {
    const diagnostics: SafeErrorRecord[] = []
    const invalidBridge = createOpenTelemetryBridge({
      tracer: new FakeTracer(1, true),
      meter: new FakeMeter() as unknown as Meter,
      onDiagnostic: error => diagnostics.push(error),
    })
    const observation = createObservability({ openSpan: invalidBridge.openSpan, processors: [invalidBridge.processor] })
    const fallback = observation.openSpan({
      name: 'sdk.agent.run', runId: 'fallback-run', startedAt: new Date().toISOString(), monotonicMs: 0,
    })
    expect(fallback.correlation.traceId).not.toBe('0'.repeat(32))
    expect(observation.health()).toMatchObject({
      state: 'degraded',
      lastFailure: { code: 'OTEL_PROVIDER_UNCONFIGURED' },
    })
    expect(diagnostics).toMatchObject([{ code: 'OTEL_PROVIDER_UNCONFIGURED' }])

    const disconnectedBridge = createOpenTelemetryBridge({
      tracer: new FakeTracer(1, false, true), meter: new FakeMeter() as unknown as Meter,
    })
    const disconnectedObservation = createObservability({ openSpan: disconnectedBridge.openSpan })
    const parent = disconnectedObservation.openSpan({
      name: 'sdk.agent.run', runId: 'disconnect-run', startedAt: new Date().toISOString(), monotonicMs: 0,
    })
    const child = disconnectedObservation.openSpan({
      name: 'sdk.model.call', runId: 'disconnect-run', parent: parent.correlation,
      startedAt: new Date().toISOString(), monotonicMs: 1,
    })
    expect(child.correlation.traceId).toBe(parent.correlation.traceId)
    expect(disconnectedObservation.health().lastFailure?.code).toBe('OTEL_PROVIDER_UNCONFIGURED')
  })

  it('surfaces synchronous API misuse while keeping diagnostic messages content-safe', async () => {
    const fake = new FakeSpan(
      'broken', { traceId: 'b'.repeat(32), spanId: '1'.repeat(16), traceFlags: 1 }, undefined, {},
    )
    fake.setAttributes = () => { throw new Error('PRIVATE_TRACER/BODY~SENTINEL%') }
    const diagnostics: SafeErrorRecord[] = []
    const bridge = createOpenTelemetryBridge({
      tracer: { startSpan: () => fake } as unknown as Tracer,
      meter: new FakeMeter() as unknown as Meter,
      onDiagnostic: error => diagnostics.push(error),
    })
    const observation = createObservability({ openSpan: bridge.openSpan, processors: [bridge.processor] })
    const span = observation.openSpan({
      name: 'sdk.model.call', runId: 'misuse-run', startedAt: new Date().toISOString(), monotonicMs: 0,
    })
    expect(observation.capture(event(1, 'sdk.model.call', 'start', span.correlation, {
      provider: 'openai', model: 'gpt-test', operation: 'stream',
    }))).toMatchObject({ status: 'rejected', reason: 'processor-failed' })
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_TRACER/BODY~SENTINEL%')
    expect(diagnostics[0]?.message).toBe('OpenTelemetry bridge API call failed')
    span.end('error', new Date().toISOString(), 1)
    await Promise.resolve()
    expect(fake.endedAt).toBeInstanceOf(Date)
  })

  it('pins the golden mapping to the reviewed upstream commit and installs no global provider', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('../fixtures/observability-otel/semantic-conventions.json', import.meta.url), 'utf8',
    )) as { commit: string; metrics: Array<{ name: string; unit: string }> }
    expect(OTEL_SEMANTIC_CONVENTIONS_COMMIT).toBe('5ca9052bc796ef1e497200b1d558fd87a201f335')
    expect(fixture.commit).toBe(OTEL_SEMANTIC_CONVENTIONS_COMMIT)
    const providerBefore = trace.getTracerProvider()
    const meter = new FakeMeter()
    createOpenTelemetryBridge({ tracer: new FakeTracer(), meter: meter as unknown as Meter })
    expect(meter.instruments).toEqual(expect.arrayContaining(fixture.metrics.map(metric => expect.objectContaining({
      name: metric.name, unit: metric.unit, kind: 'histogram',
    }))))
    expect(trace.getTracerProvider()).toBe(providerBefore)
  })
})
