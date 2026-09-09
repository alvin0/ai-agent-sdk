import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObservationDeliveryBatch } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import type { ObservationExporterPlugin, RuntimeObservationExporterRegistration } from '../../../packages/core/src/composition/exporter/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import { exporter, provider } from './exporter-fixtures.ts'
import { createCoreSpan, type ObservationEvent } from '../../../packages/core/src/observation/index.ts'

function acceptingExporter(order?: string[]): ObservationExporterPlugin {
  const base = exporter('runtime-sink')
  return {
    ...base,
    export: vi.fn(async (batch: ObservationDeliveryBatch) => {
      order?.push('export')
      return { batchId: batch.id, acceptedEventIds: batch.events.map(event => event.eventId),
        acceptedRunIds: batch.runRecords.map(record => record.runId) }
    }),
    shutdown: vi.fn(async () => { order?.push('shutdown') }),
  }
}

function registered(
  sink: ObservationExporterPlugin,
  ownership: 'owned' | 'borrowed' = 'owned',
  requirement: 'required' | 'best-effort' = 'best-effort',
): RuntimeObservationExporterRegistration {
  return { exporter: sink, ownership, requirement,
    boundary: requirement === 'required' ? 'local-durable' : 'none' }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('runtime composition owner construction', () => {
  it('publishes immutable topology, one resource, diagnostics and a bound logger', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('alpha')] })
    expect(runtime.providers()).toEqual([{ id: 'alpha', route: 'alpha', name: 'alpha', pluginId: 'alpha', family: 'alpha' }])
    expect(Object.isFrozen(runtime.providers())).toBe(true)
    runtime.logger({ scope: 'application' }).info('hello', { safe: true })
    const diagnostic = runtime.diagnostics()
    expect(diagnostic).toMatchObject({ retainedEvents: 5, observationHealth: { state: 'healthy', accepted: 5 } })
    const applicationLog = diagnostic.events.find(event => event.data.message === 'hello')
    expect(applicationLog?.resource).toBe(diagnostic.resource)
    await runtime.close()
  })

  it('checks the Web Platform before reading capability markers or methods', async () => {
    let markerReads = 0
    const candidate = { get kind() { markerReads++; return 'model-provider-plugin' } }
    const host = Object.create(globalThis) as typeof globalThis
    Object.defineProperty(host, 'ReadableStream', { value: undefined })
    await expect(createRuntimeCompositionOwner({ providers: [candidate] } as never, host))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_RUNTIME', feature: 'ReadableStream' })
    expect(markerReads).toBe(0)
  })

  it('rejects accessor options without invoking them or allocating provider setup', async () => {
    const setup = vi.fn()
    const options = Object.defineProperty({}, 'providers', { enumerable: true, get() { throw new Error('PRIVATE_GETTER') } })
    await expect(createRuntimeCompositionOwner(options as never)).rejects.toThrow('metadata must not use accessors')
    expect(setup).not.toHaveBeenCalled()
  })

  it('rejects an invalid startup signal before reading capability metadata', async () => {
    const marker = vi.fn(() => 'model-provider-plugin')
    const candidate = Object.defineProperty({}, 'kind', { get: marker })
    await expect(createRuntimeCompositionOwner({ providers: [candidate], signal: {} as AbortSignal } as never))
      .rejects.toThrow(TypeError)
    expect(marker).not.toHaveBeenCalled()
  })

  it('enforces the explicit delivery mode rather than inferring it from exporter flags', async () => {
    const sink = acceptingExporter()
    await expect(createRuntimeCompositionOwner({ providers: [provider()], observability: {
      mode: 'operational', exporters: [registered(sink, 'borrowed', 'required')],
    } })).rejects.toThrow('Operational observation exporters must be best-effort')
    const runtime = await createRuntimeCompositionOwner({ providers: [provider()], observability: {
      mode: 'reliable', exporters: [registered(sink, 'borrowed', 'required')],
    } })
    await runtime.close()
  })

  it('captures processor/redactor/span methods once while retaining their live receivers', async () => {
    let processorReads = 0, redactorReads = 0, spanCalls = 0
    const processor = {
      id: 'captured-processor', state: 'initial',
      get transform() {
        processorReads++
        return function(this: { state: string }, input: ObservationEvent): ObservationEvent {
          return { ...input, data: { ...input.data, processorState: this.state } }
        }
      },
    }
    const redactor = { id: 'captured-redactor', get redact() { redactorReads++; return (value: string) => value } }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('extensions')], observability: {
      processors: [processor as never], redactors: [redactor], includeErrorStacks: true,
      openSpan(input) { spanCalls++; return createCoreSpan(input) }, shutdownTimeoutMs: 50,
    } })
    processor.state = 'live'
    Object.defineProperty(processor, 'transform', { value: () => { throw new Error('MUTATED_PROCESSOR') } })
    Object.defineProperty(redactor, 'redact', { value: () => { throw new Error('MUTATED_REDACTOR') } })
    runtime.logger().info('processed')
    const processed = runtime.diagnostics().events.find(event => event.data.message === 'processed')
    expect(processed?.data).toMatchObject({ processorState: 'live' })
    const span = runtime.observation.openSpan({ name: 'sdk.agent.run', runId: 'span-run',
      startedAt: new Date().toISOString(), monotonicMs: 0 })
    expect(span.correlation.runId).toBe('span-run')
    expect({ processorReads, redactorReads, spanCalls }).toEqual({ processorReads: 1, redactorReads: 1, spanCalls: 1 })
    await runtime.close()
  })

  it('rejects duplicate observation identities before reading executable methods', async () => {
    const transform = vi.fn()
    const duplicate = [
      Object.defineProperty({ id: 'same' }, 'transform', { get: transform }),
      Object.defineProperty({ id: 'same' }, 'transform', { get: transform }),
    ]
    await expect(createRuntimeCompositionOwner({ providers: [provider()], observability: {
      processors: duplicate as never,
    } })).rejects.toThrow('Duplicate observation processor identity')
    expect(transform).not.toHaveBeenCalled()
  })
})

describe('runtime composition owner close', () => {
  it('rejects an invalid close signal before starting the irreversible close task', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider()] })
    expect(() => runtime.close({ signal: {} as AbortSignal })).toThrow(TypeError)
    expect(runtime.operations.status).toBe('active')
    expect(await runtime.close()).toMatchObject({ state: 'closed', quiescenceEnd: 'settled' })
  })

  it('is one irreversible promise and closes providers, final delivery, then owned exporters', async () => {
    const order: string[] = []
    const sink = acceptingExporter(order)
    let runtime!: Awaited<ReturnType<typeof createRuntimeCompositionOwner>>
    const first = provider('first', () => { order.push('first') })
    const second = provider('second', () => {
      order.push('second')
      expect(runtime.close()).toBe(closing)
      expect(runtime.operations.status).toBe('closing')
      expect(runtime.operations.activeCount).toBe(0)
    })
    runtime = await createRuntimeCompositionOwner({ providers: [first, second], observability: {
      exporters: [registered(sink)],
    } })
    const logger = runtime.logger({ scope: 'close-test' })
    logger.info('flush me')
    const closing = runtime.close()
    expect(runtime.close({ signal: new AbortController().signal })).toBe(closing)
    const report = await closing
    expect(order).toEqual(['second', 'first', 'export', 'shutdown'])
    expect(report.components).toEqual([
      { kind: 'provider-registration', id: 'provider-1', status: 'closed' },
      { kind: 'provider-registration', id: 'provider-0', status: 'closed' },
      { kind: 'observation-exporter', id: 'exporter-0', status: 'closed' },
    ])
    expect(report).toMatchObject({ state: 'closed', quiescenceEnd: 'settled', deadlineReached: false,
      observationHealth: { state: 'closed', accepted: 9, exported: 9 } })
    logger.error('ignored after close')
    expect(runtime.diagnostics()).toMatchObject({ retainedEvents: 9, observationHealth: { accepted: 9 } })
    expect(await runtime.close()).toBe(report)
  })

  it('never shuts down a borrowed exporter', async () => {
    const sink = acceptingExporter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider()], observability: {
      exporters: [registered(sink, 'borrowed')],
    } })
    await runtime.close()
    expect(sink.shutdown).not.toHaveBeenCalled()
  })

  it('uses caller abort only to accelerate quiescence and still completes cleanup', async () => {
    const controller = new AbortController()
    controller.abort('PRIVATE_ABORT_REASON')
    const sink = acceptingExporter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider()], observability: {
      exporters: [registered(sink)],
    } })
    const lease = runtime.operations.acquire('agent-run')
    const report = await runtime.close({ signal: controller.signal })
    expect(report).toMatchObject({ state: 'closed', quiescenceEnd: 'caller-abort', deadlineReached: false,
      activeRunsAtClose: 1, abortedRuns: 1, unsettledRuns: 1 })
    expect(sink.shutdown).toHaveBeenCalledTimes(1)
    expect(lease.signal.aborted).toBe(true)
  })

  it('marks cleanup not started by the shared deadline as timed out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const cleanup = vi.fn()
    const sink = acceptingExporter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('slow', cleanup)], closeTimeoutMs: 10,
      observability: { exporters: [registered(sink)] } })
    runtime.operations.acquire('model-catalog')
    const closing = runtime.close()
    await vi.advanceTimersByTimeAsync(10)
    const report = await closing
    expect(report.components).toEqual([
      expect.objectContaining({ kind: 'provider-registration', id: 'provider-0', status: 'timed-out' }),
      expect.objectContaining({ kind: 'observation-exporter', id: 'exporter-0', status: 'timed-out' }),
    ])
    expect(cleanup).not.toHaveBeenCalled()
    expect(report).toMatchObject({ quiescenceEnd: 'timeout', deadlineReached: true })
  })

  it('caps observation shutdown inside the shared runtime close deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const sink = { ...acceptingExporter(), shutdown: vi.fn(() => new Promise<void>(() => undefined)) }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider()], closeTimeoutMs: 1_000,
      observability: { shutdownTimeoutMs: 10, exporters: [registered(sink)] } })
    const closing = runtime.close()
    await vi.advanceTimersByTimeAsync(10)
    await expect(closing).resolves.toMatchObject({ components: expect.arrayContaining([
      expect.objectContaining({ kind: 'observation-exporter', status: 'timed-out' }),
    ]) })
  })
})
