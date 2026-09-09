import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import {
  createCoreSpan,
  createSpanId,
  createTraceId,
  isSpanId,
  isTraceId,
  normalizeModelFailure,
  safeErrorRecord,
  snapshotObservationSpan,
  type CaptureReceipt,
  type ModelCallReport,
  type ModelInvocationContext,
  type ObservationEvent,
  type ObservationPort,
  type OpenObservationSpanInput,
} from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'

class ObservedAdapter extends ModelAdapter {
  seenContext: ModelInvocationContext | undefined
  private readonly chunks: () => AsyncIterable<StreamChunk>

  constructor(chunks: () => AsyncIterable<StreamChunk>) {
    super()
    this.chunks = chunks
  }

  stream(_options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    this.seenContext = context
    return this.chunks()
  }
}

function request(provider = 'observed'): GenerateOptions {
  return { provider, model: 'model', messages: [] }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function accepted(event: ObservationEvent): CaptureReceipt {
  return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
}

function recordingPort(mode: ObservationPort['mode'] = 'operational') {
  const events: ObservationEvent[] = []
  const ended = vi.fn()
  const port: ObservationPort = {
    mode,
    openSpan(input: OpenObservationSpanInput) {
      const span = createCoreSpan(input)
      return { ...span, end: ended }
    },
    capture(event) {
      events.push(event)
      return accepted(event)
    },
    checkpoint(event) {
      events.push(event)
      return Promise.resolve({ eventId: event.eventId, status: 'accepted', durable: true, boundary: 'local-durable' })
    },
  }
  return { port, events, ended }
}

describe('core observation identities and model-call handles', () => {
  it('creates valid non-zero W3C ids and traceparent values', () => {
    const traceId = createTraceId()
    const spanId = createSpanId()
    expect(isTraceId(traceId)).toBe(true)
    expect(isSpanId(spanId)).toBe(true)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('accepts valid unsampled backend traceparent values without changing their flags', () => {
    const core = createCoreSpan({
      name: 'sdk.agent.run',
      runId: 'run',
      startedAt: new Date().toISOString(),
      monotonicMs: 0,
    })
    const unsampled = { ...core, traceparent: core.traceparent.replace(/-01$/, '-00') }
    expect(snapshotObservationSpan(unsampled)?.traceparent).toBe(unsampled.traceparent)
  })

  it('captures monotonic sequenced start/end events and a complete usage report', async () => {
    const observed = recordingPort()
    const adapter = new ObservedAdapter(async function* () {
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, reasoningTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const registry = new ModelRegistry({ observation: observed.port })
    registry.registerAdapter(['observed'], adapter)
    const handle = registry.stream(request())

    expect(handle.runId).toMatch(/^[0-9a-f]{32}$/)
    expect(handle.modelCallId).toMatch(/^[0-9a-f]{32}$/)
    await drain(handle)
    const report = await handle.report

    expect(observed.events.map(event => [event.phase, event.sequence])).toEqual([['start', 1], ['end', 2]])
    expect(observed.events.every(event => Object.isFrozen(event))).toBe(true)
    expect(observed.events[0]?.resource.sdkVersion).toBe('0.1.0')
    expect(report).toMatchObject({ status: 'success', coverage: 'complete', authoritative: true })
    expect(report.reported).toEqual({ inputTokens: 3, outputTokens: 2, reasoningTokens: 1, totalTokens: 5 })
    expect(observed.ended).toHaveBeenCalledTimes(1)
  })

  it('shares one explicit invocation context through middleware and adapter', async () => {
    const observed = recordingPort()
    const adapter = new ObservedAdapter(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], adapter)
    let middlewareContext: ModelInvocationContext | undefined
    registry.use((_options, next, context) => {
      middlewareContext = context
      return next()
    })
    const inputContext: ModelInvocationContext = { observation: observed.port, correlation: { runId: 'shared-run' } }
    const handle = registry.stream(request(), inputContext)
    await drain(handle)

    expect(handle.runId).toBe('shared-run')
    expect(adapter.seenContext).toBe(middlewareContext)
    expect(adapter.seenContext?.correlation?.modelCallId).toBe(handle.modelCallId)
    expect(isTraceId(adapter.seenContext?.correlation?.traceId)).toBe(true)
  })

  it('uses the dispatch-time context override for a default prepared adapter call', async () => {
    const first = recordingPort()
    const override = recordingPort()
    const adapter = new ObservedAdapter(async function* () {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], adapter)
    const prepared = await registry.prepareCall(
      { provider: 'observed', model: 'model' },
      undefined,
      { observation: first.port, correlation: { runId: 'first' } },
    )
    const handle = prepared.stream(
      { ...prepared.config, messages: [] },
      { observation: override.port, correlation: { runId: 'override' } },
    )
    await drain(handle)

    expect(handle.runId).toBe('override')
    expect(adapter.seenContext?.observation).toBe(override.port)
    expect(first.events).toHaveLength(0)
    expect(override.events).toHaveLength(2)
  })

  it('keeps missing usage distinct from numeric zero', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    const handle = registry.stream(request())
    await drain(handle)
    const report = await handle.report
    expect(report.coverage).toBe('missing')
    expect(report.reported).toEqual({})
    expect(report.error?.code).toBe('USAGE_MISSING')
    expect(report.possiblyBilledAttemptsWithoutUsage).toBe(1)
  })

  it('treats explicit zero counters as complete usage', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    const handle = registry.stream(request())
    await drain(handle)
    await expect(handle.report).resolves.toMatchObject({
      coverage: 'complete',
      reported: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      authoritative: true,
      possiblyBilledAttemptsWithoutUsage: 0,
    })
  })

  it('resolves a non-authoritative report when an adapter emits invalid usage at runtime', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield {
        type: 'usage',
        usage: { inputTokens: -1, outputTokens: 2 },
      } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    const handle = registry.stream(request())
    await drain(handle)
    await expect(handle.report).resolves.toMatchObject({
      status: 'success',
      coverage: 'partial',
      reported: { outputTokens: 2 },
      authoritative: false,
      error: { code: 'USAGE_INVALID' },
    })
  })

  it('reports disabled delivery explicitly when no observation sink is configured', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    const handle = registry.stream(request())
    await drain(handle)
    expect((await handle.report).delivery).toEqual({
      mode: 'operational',
      requiredBoundary: 'none',
      reachedBoundary: 'none',
      complete: true,
      acceptedCritical: 0,
      rejectedCritical: 0,
      pendingCritical: 0,
    })
  })

  it('classifies a missing route as not-applicable before dispatch', async () => {
    const handle = new ModelRegistry().stream(request('absent'))
    await drain(handle)
    await expect(handle.report).resolves.toMatchObject({
      status: 'error',
      coverage: 'not-applicable',
      reported: {},
      authoritative: true,
      possiblyBilledAttemptsWithoutUsage: 0,
    })
  })

  it('uses dispatch evidence instead of guessing from provider error-code names', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'provider rejected request', code: 'INVALID_REQUEST' } },
      }
    }))
    const handle = registry.stream(request())
    await drain(handle)
    await expect(handle.report).resolves.toMatchObject({
      coverage: 'missing',
      possiblyBilledAttemptsWithoutUsage: 1,
      authoritative: false,
    })
  })

  it('resolves the report and closes the adapter when the consumer stops', async () => {
    let closed = false
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      try {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        await new Promise(() => {})
      } finally {
        closed = true
      }
    }))
    const handle = registry.stream(request())
    for await (const _chunk of handle) break
    const report = await handle.report
    expect(closed).toBe(true)
    expect(report.status).toBe('aborted')
  })

  it('falls back from invalid backend ids without changing the model result', async () => {
    const badPort: ObservationPort = {
      mode: 'operational',
      openSpan(input) {
        return {
          correlation: {
            traceId: '0'.repeat(32) as ReturnType<typeof createTraceId>,
            spanId: '0'.repeat(16) as ReturnType<typeof createSpanId>,
            parentSpanId: null,
            runId: input.runId,
            ...input.correlation?.modelCallId === undefined ? {} : { modelCallId: input.correlation.modelCallId },
          },
          traceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01`,
          end() {},
        }
      },
      capture: accepted,
    }
    const registry = new ModelRegistry({ observation: badPort })
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    const handle = registry.stream(request())
    await drain(handle)
    const report = await handle.report
    expect(isTraceId(report.traceId)).toBe(true)
    expect(isSpanId(report.spanId)).toBe(true)
    expect(report.status).toBe('success')
  })

  it('contains malformed observer receipts and never upgrades false durability claims', async () => {
    const malformedPort: ObservationPort = {
      mode: 'operational',
      openSpan: createCoreSpan,
      capture(event) {
        return {
          eventId: event.eventId,
          status: 'accepted',
          durable: true,
          boundary: 'none',
        }
      },
    }
    const registry = new ModelRegistry({ observation: malformedPort })
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    const handle = registry.stream(request())
    await expect(drain(handle)).resolves.toHaveLength(1)
    const report = await handle.report
    expect(report.status).toBe('success')
    expect(report.delivery).toMatchObject({
      reachedBoundary: 'none',
      complete: false,
      acceptedCritical: 0,
      rejectedCritical: 2,
    })
    expect(report.delivery.lastFailure?.type).toBe('TypeError')
  })

  it('does not let an aborted provider signal cancel the terminal durability checkpoint', async () => {
    const controller = new AbortController()
    const observed = recordingPort('reliable')
    const registry = new ModelRegistry({ observation: observed.port })
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      controller.abort()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }
    }))
    const handle = registry.stream({ ...request(), signal: controller.signal })
    await drain(handle)
    expect((await handle.report).delivery.complete).toBe(true)
    expect(observed.events).toHaveLength(2)
  })

  it('resolves reports for middleware failures and rejects a second iteration', async () => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    registry.use(() => { throw new Error('middleware failed') })
    const handle = registry.stream(request())
    await expect(drain(handle)).rejects.toThrow('middleware failed')
    await expect(handle.report).resolves.toMatchObject({ status: 'error', coverage: 'not-applicable' })
    await expect(drain(handle)).rejects.toThrow('only be iterated once')
  })

  it('allocates one monotonic sequence across calls in the same run context', async () => {
    const observed = recordingPort()
    const registry = new ModelRegistry()
    registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }))
    const context: ModelInvocationContext = { observation: observed.port, correlation: { runId: 'one-run' } }
    const first = registry.stream(request(), context)
    await drain(first)
    const second = registry.stream(request(), context)
    await drain(second)
    expect(observed.events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
  })

  it('contains hostile Error property getters while producing safe records', () => {
    const hostile = new Error('hidden')
    Object.defineProperties(hostile, {
      name: { get() { throw new Error('name getter') } },
      message: { get() { throw new Error('message getter') } },
      cause: { get() { throw new Error('cause getter') } },
      code: { get() { throw new Error('code getter') } },
    })
    expect(safeErrorRecord(hostile)).toEqual({ type: 'Error', message: 'undefined' })
  })

  it('normalizes foreign failure data without invoking outer or inner accessors', () => {
    const outerGetter = vi.fn(() => 'RATE_LIMIT')
    const innerGetter = vi.fn(() => 'RATE_LIMIT')
    const outer = new Error('outer')
    Object.defineProperty(outer, 'code', { get: outerGetter })
    Object.defineProperty(outer, 'failure', {
      value: { message: 'busy', code: 'RATE_LIMIT' },
    })
    const inner = Object.assign(new Error('inner'), { code: 'RATE_LIMIT' })
    const failure = { message: 'busy' }
    Object.defineProperty(failure, 'code', { get: innerGetter })
    Object.defineProperty(inner, 'failure', { value: failure })

    expect(normalizeModelFailure(outer)).toEqual({ message: 'outer', code: 'UNKNOWN' })
    expect(normalizeModelFailure(inner)).toEqual({ message: 'inner', code: 'UNKNOWN' })
    expect(outerGetter).not.toHaveBeenCalled()
    expect(innerGetter).not.toHaveBeenCalled()
  })

  it('preserves results in reliable mode but fails closed after audit terminal checkpoint failure', async () => {
    const makePort = (mode: 'reliable' | 'audit'): ObservationPort => ({
      mode,
      openSpan: createCoreSpan,
      capture: accepted,
      checkpoint(event) {
        return Promise.resolve({
          eventId: event.eventId,
          status: 'rejected',
          durable: false,
          boundary: 'none',
          reason: 'exporter-unavailable',
        })
      },
    })
    const makeRegistry = (port: ObservationPort) => {
      const registry = new ModelRegistry({ observation: port })
      registry.registerAdapter(['observed'], new ObservedAdapter(async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      }))
      return registry
    }

    const reliable = makeRegistry(makePort('reliable')).stream(request())
    await expect(drain(reliable)).resolves.toHaveLength(1)
    expect((await reliable.report).delivery.complete).toBe(false)

    const audit = makeRegistry(makePort('audit')).stream(request())
    let recovered: ModelCallReport | undefined
    try {
      await drain(audit)
    } catch (error) {
      const candidate = error as { readonly code?: string; readonly report?: ModelCallReport }
      expect(candidate.code).toBe('OBSERVABILITY_AUDIT_UNAVAILABLE')
      recovered = candidate.report
    }
    expect(recovered).toBe(await audit.report)
    expect(recovered?.delivery.complete).toBe(false)
  })
})
