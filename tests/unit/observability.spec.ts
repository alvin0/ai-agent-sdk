import { describe, expect, it, vi } from 'vitest'
import * as canonicalObservability from '@ai-agent-sdk/core/observability'
import {
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  ModelAdapter,
  ModelRegistry,
  type JsonObject,
  type ObservationEvent,
  type ObservationPriority,
  type StreamChunk,
} from '@ai-agent-sdk/core'
import {
  MemoryObservationExporter,
  TestObservationExporter,
  createObservability,
  projectLog,
  projectMetrics,
  projectTrace,
  type ObservationExporter,
} from '@ai-agent-sdk/core/observability'

const resource = Object.freeze({
  sdkName: 'ai-agent-sdk' as const,
  sdkVersion: '0.1.0',
  runtime: 'unknown' as const,
})

function event(
  sequence: number,
  priority: ObservationPriority = 'critical',
  data: JsonObject = { status: 'success' },
  runId = 'run-1',
): ObservationEvent {
  const scope = createObservationRunScope()
  return {
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence,
    name: 'sdk.model.call',
    phase: sequence % 2 === 0 ? 'end' : 'start',
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority,
    resource,
    correlation: createCoreSpan({
      name: 'sdk.model.call', runId, startedAt: new Date().toISOString(), monotonicMs: 0,
    }).correlation,
    data,
  }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Universal observation bus', () => {
  it('keeps the compatibility bridge on the exact core-owned runtime values', () => {
    expect(createObservability).toBe(canonicalObservability.createObservability)
    expect(MemoryObservationExporter).toBe(canonicalObservability.MemoryObservationExporter)
    expect(TestObservationExporter).toBe(canonicalObservability.TestObservationExporter)
    expect(projectLog).toBe(canonicalObservability.projectLog)
    expect(projectMetrics).toBe(canonicalObservability.projectMetrics)
    expect(projectTrace).toBe(canonicalObservability.projectTrace)
  })
  it('captures, batches, exports, and reports healthy delivery', async () => {
    const memory = new MemoryObservationExporter()
    const observation = createObservability({
      exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
    })
    expect(observation.capture(event(1))).toMatchObject({ status: 'accepted', durable: false, boundary: 'none' })
    expect(observation.health()).toMatchObject({ state: 'healthy', queuedEvents: 1, accepted: 1 })
    await expect(observation.flush()).resolves.toEqual({
      complete: true, exportedEvents: 1, pendingEvents: 0, rejectedCritical: 0, timedOut: false,
    })
    expect(memory.events()).toHaveLength(1)
    expect(observation.health()).toMatchObject({ state: 'healthy', queuedEvents: 0, exported: 1 })
  })

  it('rejects false durability and invalid mode registrations at construction', () => {
    const memory = new MemoryObservationExporter()
    expect(() => createObservability({ mode: 'reliable' })).toThrow(/durable required exporter/i)
    expect(() => createObservability({
      mode: 'reliable',
      exporters: [{ exporter: memory, requirement: 'required', boundary: 'local-durable' }],
    })).toThrow(/does not support local-durable/i)
    expect(() => createObservability({
      exporters: [{ exporter: memory, requirement: 'required', boundary: 'none' }],
    })).toThrow(/operational.*best-effort/i)
    expect(() => createObservability({ content: 'unsafe' as never })).toThrow(/content policy/i)
    expect(() => createObservability({ minimumLogLevel: 'everything' as never })).toThrow(/log level/i)
  })

  it('runs processors in order but forbids them from rewriting correlation envelopes', async () => {
    const memory = new MemoryObservationExporter()
    const order: string[] = []
    const observation = createObservability({
      processors: [
        { id: 'first', transform: source => { order.push('first'); return { ...source, data: { first: true } } } },
        { id: 'second', transform: source => { order.push('second'); return { ...source, data: { ...source.data, second: true } } } },
      ],
      exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
    })
    observation.capture(event(1))
    await observation.flush()
    expect(order).toEqual(['first', 'second'])
    expect(memory.events()[0]?.data).toEqual({ first: true, second: true })

    const invalid = createObservability({ processors: [{
      id: 'rewrites-envelope',
      transform: source => ({ ...source, eventId: createOperationId() }),
    }] })
    expect(invalid.capture(event(1))).toMatchObject({ status: 'rejected', reason: 'processor-failed' })
  })

  it('checkpoints every prior critical event through the required boundary', async () => {
    const durable = new TestObservationExporter({ supportedBoundaries: ['local-durable'] })
    const observation = createObservability({
      mode: 'reliable',
      exporters: [{ exporter: durable, requirement: 'required', boundary: 'local-durable' }],
    })
    observation.capture(event(1))
    const terminal = event(2)
    await expect(observation.checkpoint(terminal)).resolves.toMatchObject({
      eventId: terminal.eventId, status: 'accepted', durable: true, boundary: 'local-durable',
    })
    expect(durable.exported.flatMap(batch => batch.events).map(item => item.sequence)).toEqual([1, 2])
    expect(observation.health().queuedEvents).toBe(0)
  })

  it('starts exporter staging during capture and waits for it at checkpoint export', async () => {
    let release!: () => void
    const committed = new Promise<void>(resolve => { release = resolve })
    const stage = vi.fn(() => committed)
    const exporter: ObservationExporter = {
      id: 'staged-local',
      supportedBoundaries: ['local-durable'],
      stage,
      async export(batch) {
        await committed
        return { batchId: batch.batchId, accepted: true, retryable: false }
      },
    }
    const observation = createObservability({
      mode: 'reliable',
      exporters: [{ exporter, requirement: 'required', boundary: 'local-durable' }],
    })
    observation.capture(event(1))
    expect(stage).toHaveBeenCalledTimes(1)
    const pending = observation.checkpoint(event(2))
    expect(stage).toHaveBeenCalledTimes(2)
    release()
    await expect(pending).resolves.toMatchObject({ durable: true, boundary: 'local-durable' })
  })

  it('does not let a best-effort exporter block a required checkpoint', async () => {
    const durable = new TestObservationExporter({ id: 'durable', supportedBoundaries: ['local-durable'] })
    const broken = new TestObservationExporter({ id: 'broken', failExports: 1, retryable: false })
    const observation = createObservability({
      mode: 'audit',
      exporters: [
        { exporter: durable, requirement: 'required', boundary: 'local-durable' },
        { exporter: broken, requirement: 'best-effort', boundary: 'none' },
      ],
    })
    await expect(observation.checkpoint(event(1))).resolves.toMatchObject({ status: 'accepted', durable: true })
    expect(observation.health()).toMatchObject({ state: 'degraded', exporterFailures: 1 })
  })

  it('fails a checkpoint honestly when its required exporter fails', async () => {
    const broken = new TestObservationExporter({
      supportedBoundaries: ['remote-acknowledged'], failExports: 1,
    })
    const observation = createObservability({
      mode: 'audit',
      exporters: [{ exporter: broken, requirement: 'required', boundary: 'remote-acknowledged' }],
    })
    await expect(observation.checkpoint(event(1))).resolves.toMatchObject({
      status: 'rejected', durable: false, reason: 'exporter-unavailable',
    })
    expect(observation.health()).toMatchObject({ state: 'failed', exporterFailures: 1, queuedEvents: 2 })
  })

  it('preserves reliable results and fails audit only after finalizing the same report', async () => {
    const makeCall = (mode: 'reliable' | 'audit') => {
      let dispatches = 0
      const exporter = new TestObservationExporter({
        supportedBoundaries: ['local-durable'], failExports: 1,
      })
      const observation = createObservability({
        mode,
        exporters: [{ exporter, requirement: 'required', boundary: 'local-durable' }],
      })
      class SuccessfulAdapter extends ModelAdapter {
        stream(): AsyncIterable<StreamChunk> {
          dispatches++
          return (async function* () {
            yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
      }
      const registry = new ModelRegistry({ observation })
      registry.registerAdapter(['observed'], new SuccessfulAdapter())
      const handle = registry.stream({ provider: 'observed', model: 'm', messages: [] })
      return { handle, dispatches: () => dispatches }
    }

    const reliable = makeCall('reliable')
    await expect(drain(reliable.handle)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }),
    ]))
    expect(reliable.dispatches()).toBe(1)
    expect(await reliable.handle.report).toMatchObject({ status: 'success', delivery: { complete: false } })

    const audit = makeCall('audit')
    let recovered: unknown
    try { await drain(audit.handle) } catch (error) {
      expect(error).toMatchObject({ code: 'OBSERVABILITY_AUDIT_UNAVAILABLE' })
      recovered = (error as { report?: unknown }).report
    }
    expect(audit.dispatches()).toBe(1)
    expect(recovered).toBe(await audit.handle.report)
    expect(recovered).toMatchObject({ status: 'success', delivery: { complete: false } })
  })

  it('evicts verbose then normal events and never evicts critical events', () => {
    const observation = createObservability({ maxQueueEvents: 2, maxQueueBytes: 1_000_000 })
    observation.capture(event(1, 'verbose'))
    observation.capture(event(2, 'normal'))
    observation.capture(event(3, 'critical'))
    expect(observation.health()).toMatchObject({ droppedVerbose: 1, queuedEvents: 2 })
    observation.capture(event(4, 'critical'))
    expect(observation.health()).toMatchObject({ droppedNormal: 1, queuedEvents: 2 })
    expect(observation.capture(event(5, 'critical'))).toMatchObject({ status: 'rejected', reason: 'capacity' })
    expect(observation.health()).toMatchObject({ state: 'failed', criticalRejected: 1, queuedEvents: 2 })
  })

  it('contains a user processor failure and emits one protected health event', async () => {
    const memory = new MemoryObservationExporter()
    const process = vi.fn(() => { throw new Error('PRIVATE_PROCESSOR/BODY~SENTINEL%') })
    const observation = createObservability({
      processors: [{ id: 'broken', transform: process }],
      exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
    })
    expect(observation.capture(event(1))).toMatchObject({ status: 'rejected', reason: 'processor-failed' })
    await observation.flush()
    expect(process).toHaveBeenCalledTimes(1)
    expect(memory.events().map(item => item.name)).toEqual(['sdk.observer.failure'])
    expect(JSON.stringify(memory.events())).not.toContain('PRIVATE_PROCESSOR/BODY~SENTINEL%')
    expect(observation.health()).toMatchObject({ state: 'degraded', processorFailures: 1 })
  })

  it('redacts secrets, removes content, bounds hostile values, and runs privacy after user processors', async () => {
    const memory = new MemoryObservationExporter()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const processorInputs: unknown[] = []
    const observation = createObservability({
      content: 'none',
      processors: [{
        id: 'tries-to-reintroduce-secret',
        transform: source => {
          processorInputs.push(source.data)
          return { ...source, data: { ...source.data, access_token: 'processor-secret' } }
        },
      }],
      exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
    })
    const unsafe = event(1, 'critical', {
      prompt: 'private prompt',
      authorization: 'Bearer secret',
      headers: { authorization: 'secret', 'content-type': 'application/json', 'x-private': 'hidden' },
      cycle: cyclic,
      error: new Error('authorization: Bearer raw-error-secret'),
    } as unknown as JsonObject)
    observation.capture(unsafe)
    await observation.flush()
    const serialized = JSON.stringify(memory.events())
    expect(serialized).not.toContain('private prompt')
    expect(serialized).not.toContain('Bearer secret')
    expect(serialized).not.toContain('processor-secret')
    expect(serialized).not.toContain('raw-error-secret')
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).toContain('[Circular]')
    expect(serialized).not.toContain('.spec.ts')
    expect(processorInputs).toEqual([expect.objectContaining({ authorization: '[REDACTED]' })])
    expect(processorInputs[0]).not.toHaveProperty('prompt')
  })

  it('rejects hostile schemas and events that cannot fit one configured batch', () => {
    const observation = createObservability({ maxBatchBytes: 200 })
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, 'schemaVersion', { get() { throw new Error('hostile getter') } })
    expect(() => observation.capture(hostile as unknown as ObservationEvent)).not.toThrow()
    expect(observation.health()).toMatchObject({ state: 'degraded', processorFailures: 1 })
    expect(observation.capture(event(1))).toMatchObject({ status: 'rejected', reason: 'capacity' })
  })

  it('supports metadata and explicit redacted content policies', async () => {
    const metadata = new MemoryObservationExporter('metadata')
    const metadataBus = createObservability({
      content: 'metadata', exporters: [{ exporter: metadata, requirement: 'best-effort', boundary: 'none' }],
    })
    metadataBus.capture(event(1, 'normal', { prompt: '12345' }))
    await metadataBus.flush()
    expect(metadata.events()[0]?.data.prompt).toEqual({ kind: 'string', length: 5 })

    const redacted = new MemoryObservationExporter('redacted')
    const redactedBus = createObservability({
      content: 'redacted',
      redactors: [{ id: 'digits', redact: value => value.replaceAll(/\d/g, '#') }],
      exporters: [{ exporter: redacted, requirement: 'best-effort', boundary: 'none' }],
    })
    redactedBus.capture(event(1, 'normal', { prompt: 'account 12345' }))
    await redactedBus.flush()
    expect(redacted.events()[0]?.data.prompt).toBe('account #####')
  })

  it('creates scoped correlated logs with level priorities and immutable child fields', async () => {
    const memory = new MemoryObservationExporter()
    const observation = createObservability({
      minimumLogLevel: 'info',
      exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
    })
    const logger = observation.logger({ fields: { subsystem: 'provider' } })
    logger.debug('not retained')
    logger.child({ operation: 'catalog' }).info('catalog ready', { authorization: 'secret' })
    logger.error('catalog failed', { code: 'CATALOG_FAILED' })
    await observation.flush()
    const logs = memory.events()
    expect(logs.map(item => [item.data.level, item.priority])).toEqual([
      ['info', 'normal'], ['error', 'critical'],
    ])
    expect(logs[0]?.data.fields).toEqual({ subsystem: 'provider', operation: 'catalog', authorization: '[REDACTED]' })
    expect(projectLog(logs[0]!)?.traceId).toBe(logs[0]?.correlation.traceId)
  })

  it('times out an exporter that ignores AbortSignal without losing health evidence', async () => {
    const stuck: ObservationExporter = {
      id: 'stuck', supportedBoundaries: ['none'],
      export: () => new Promise(() => {}),
    }
    const observation = createObservability({
      flushTimeoutMs: 10,
      exporters: [{ exporter: stuck, requirement: 'best-effort', boundary: 'none' }],
    })
    observation.capture(event(1))
    await expect(observation.flush()).resolves.toMatchObject({ complete: false, timedOut: true })
    expect(observation.health()).toMatchObject({ state: 'failed', exporterFailures: 1, flushTimeouts: 1 })
  })

  it('shuts exporters down in reverse order and makes shutdown idempotent', async () => {
    const order: string[] = []
    const exporter = (id: string): ObservationExporter => ({
      id, supportedBoundaries: ['none'],
      export: batch => Promise.resolve({ batchId: batch.batchId, accepted: true, retryable: false }),
      shutdown: () => { order.push(id); return Promise.resolve() },
    })
    const observation = createObservability({ exporters: [
      { exporter: exporter('one'), requirement: 'best-effort', boundary: 'none' },
      { exporter: exporter('two'), requirement: 'best-effort', boundary: 'none' },
    ] })
    observation.capture(event(1))
    const first = observation.shutdown()
    const second = observation.shutdown()
    expect(second).toBe(first)
    await first
    expect(order).toEqual(['two', 'one'])
    expect(observation.health().state).toBe('closed')
    expect(observation.capture(event(2))).toMatchObject({ status: 'rejected', reason: 'closed' })
    expect(() => observation.flush()).toThrow(/closed/i)
  })

  it('falls back from invalid tracing backends and records degraded health', () => {
    const observation = createObservability({ openSpan: () => ({}) as never })
    const span = observation.openSpan({
      name: 'sdk.model.call', runId: 'run', startedAt: new Date().toISOString(), monotonicMs: 0,
    })
    expect(span.correlation.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(observation.health()).toMatchObject({ state: 'degraded', processorFailures: 1 })
  })

  it('projects traces and bounded-cardinality metrics without IDs, models, tools, or URLs', () => {
    const terminal = event(2, 'critical', {
      provider: 'openai', model: 'secret-model', toolName: 'sensitive-tool', origin: 'https://private.invalid',
      operation: 'generate', status: 'success', durationMs: 12,
      usageReport: { coverage: 'complete', reported: { inputTokens: 3, outputTokens: 2 } },
    })
    expect(projectTrace(terminal)).toMatchObject({ name: 'sdk.model.call', phase: 'end', durationMs: 12 })
    const serialized = JSON.stringify(projectMetrics(terminal))
    expect(serialized).toContain('ai_agent_sdk.token.usage')
    expect(serialized).toContain('openai')
    expect(serialized).not.toContain('secret-model')
    expect(serialized).not.toContain('sensitive-tool')
    expect(serialized).not.toContain('private.invalid')
    expect(serialized).not.toContain(terminal.correlation.traceId)
  })

  it('splits batches by event count and safely clears a bus with no exporters', async () => {
    const memory = new MemoryObservationExporter()
    const observation = createObservability({
      maxBatchEvents: 2,
      exporters: [{ exporter: memory, requirement: 'best-effort', boundary: 'none' }],
    })
    for (let sequence = 1; sequence <= 5; sequence++) observation.capture(event(sequence))
    await observation.flush()
    expect(memory.batches().map(batch => batch.events.length)).toEqual([2, 2, 1])

    const sinkless = createObservability()
    sinkless.capture(event(1))
    await expect(sinkless.flush()).resolves.toMatchObject({ complete: true, pendingEvents: 0 })
    expect(sinkless.health().queuedEvents).toBe(0)
  })
})
