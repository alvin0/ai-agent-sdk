import { describe, expect, it, vi } from 'vitest'
import { COMPOSITION_LIMITS } from '../../../packages/core/src/composition/common/config.ts'
import { preflightRuntimeCapabilities } from '../../../packages/core/src/composition/preflight.ts'
import { defineObservationExporter } from '../../../packages/core/src/composition/exporter/definition.ts'
import { captureExporterMethods, preflightExporterIdentities } from '../../../packages/core/src/composition/exporter/preflight.ts'
import type { ObservationDeliveryBatch } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import { exporter, provider, registration } from './exporter-fixtures.ts'

describe('whole-runtime exporter identity preflight', () => {
  it('rejects exporter conflicts before looking up ANY provider/exporter behavior', () => {
    const plugin = provider(), left = exporter('duplicate'), right = exporter('duplicate')
    const get = vi.fn(() => { throw new Error('PRIVATE_GETTER_DETAIL') })
    Object.defineProperty(plugin, 'setup', { get })
    for (const source of [left, right]) for (const key of ['export', 'ready', 'stage', 'shutdown']) {
      Object.defineProperty(source, key, { get })
    }
    expect(() => preflightRuntimeCapabilities([plugin], [registration(left), registration(right)])).toThrow(
      expect.objectContaining({ failureCode: 'CAPABILITY_ID_CONFLICT', cleanup: [], conflict: {
        namespace: 'observation-exporter-id', key: '[redacted]', firstIndex: 0, secondIndex: 1,
      } }),
    )
    expect(get).not.toHaveBeenCalled()
  })

  it('rejects provider conflicts without looking up exporter behavior', () => {
    const source = exporter()
    const get = vi.fn()
    Object.defineProperty(source, 'export', { get })
    expect(() => preflightRuntimeCapabilities([provider('a'), provider('a')], [registration(source)]))
      .toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_ID_CONFLICT' }))
    expect(get).not.toHaveBeenCalled()
  })

  it('uses separate provider and exporter namespaces', () => {
    const plan = preflightRuntimeCapabilities([provider('same')], [registration(exporter('same'))])
    expect(plan.providers[0]!.id).toBe(plan.exporters[0]!.exporter.id)
    expect(Object.isFrozen(plan)).toBe(true)
  })

  it.each([
    [{ kind: 'memory-store' }, 'CAPABILITY_KIND_MISMATCH'],
    [{ apiVersion: 2 }, 'CAPABILITY_API_UNSUPPORTED'],
    [{ supportedBoundaries: ['local-durable'] }, 'OBSERVATION_BOUNDARY_UNSUPPORTED'],
  ])('rejects markers and unsupported selected boundaries before method access %#', (patch, failureCode) => {
    const source = { ...exporter(), ...patch }
    const get = vi.fn()
    Object.defineProperty(source, 'ready', { get })
    expect(() => preflightExporterIdentities([{ ...registration(), exporter: source }]))
      .toThrow(expect.objectContaining({ failureCode, cleanup: [] }))
    expect(get).not.toHaveBeenCalled()
  })

  it.each([
    { ownership: undefined }, { ownership: 'auto' }, { requirement: 'automatic' }, { boundary: 'durable' },
    { exporter: { ...exporter(), supportedBoundaries: [] } },
    { exporter: { ...exporter(), supportedBoundaries: ['none', 'none'] } },
    { exporter: { ...exporter(), supportedBoundaries: ['none', 'durable'] } },
    { exporter: { ...exporter(), id: ' ' } },
    { exporter: { ...exporter(), id: 'é'.repeat(COMPOSITION_LIMITS.identityBytes / 2 + 1) } },
  ])('rejects invalid inert registration data %#', patch => {
    expect(() => preflightExporterIdentities([{ ...registration(), ...patch }])).toThrow(
      expect.objectContaining({ code: 'RUNTIME_CONSTRUCTION_FAILED', stage: 'preflight', cleanup: [] }),
    )
  })

  it('rejects accessors, sparse arrays and oversized input without executing getters', () => {
    const input = registration(), get = vi.fn()
    Object.defineProperty(input, 'ownership', { get })
    expect(() => preflightExporterIdentities([input])).toThrow()
    const array = new Array(COMPOSITION_LIMITS.exporters + 1)
    Object.defineProperty(array, '0', { get })
    expect(() => preflightExporterIdentities(array)).toThrow()
    expect(() => preflightExporterIdentities(new Array(1))).toThrow()
    expect(get).not.toHaveBeenCalled()
  })

  it('checks an already-aborted signal before input reflection', () => {
    const controller = new AbortController()
    controller.abort('PRIVATE_ABORT_DETAIL')
    const getOwnPropertyDescriptor = vi.fn()
    const input = new Proxy([], { getOwnPropertyDescriptor })
    expect(() => preflightRuntimeCapabilities(input, input, undefined, controller.signal))
      .toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_ABORTED', cleanup: [] }))
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
  })
})

describe('captured exporter behavior and author helper', () => {
  it('reads each metadata/method field once and preserves class receivers plus live operational state', async () => {
    class Exporter {
      kind = 'observation-exporter'
      apiVersion = 1
      id = 'original'
      supportedBoundaries = ['none']
      calls = 0
      ready() { this.calls++; return Promise.resolve() }
      shutdown() { this.calls++; return Promise.resolve() }
      export(batch: ObservationDeliveryBatch) {
        this.calls++
        return Promise.resolve({ batchId: batch.id, acceptedEventIds: [], acceptedRunIds: [] })
      }
    }
    const source = new Exporter(), metadata: string[] = [], methods: string[] = []
    const input = new Proxy(source, {
      getOwnPropertyDescriptor(target, key) { metadata.push(String(key)); return Reflect.getOwnPropertyDescriptor(target, key) },
      get(target, key, receiver) { if (['ready', 'stage', 'export', 'shutdown'].includes(String(key))) methods.push(String(key)); return Reflect.get(target, key, receiver) },
    })
    const plan = preflightExporterIdentities([{ ...registration(), exporter: input }])
    expect(methods).toEqual([])
    const captured = captureExporterMethods(plan)
    expect(captureExporterMethods(plan)).toBe(captured)
    expect(metadata).toEqual(['kind', 'apiVersion', 'id', 'supportedBoundaries'])
    expect(methods).toEqual(['ready', 'stage', 'export', 'shutdown'])
    source.id = 'changed'
    source.supportedBoundaries.push('local-durable')
    source.ready = () => { throw new Error('replaced') }
    source.export = () => { throw new Error('replaced') }
    source.shutdown = () => { throw new Error('replaced') }
    const view = captured[0]!.exporter
    await view.ready!(new AbortController().signal)
    await view.export({} as ObservationDeliveryBatch, new AbortController().signal)
    await view.shutdown!(new AbortController().signal)
    expect(source.calls).toBe(3)
    expect(view.id).toBe('original')
    expect(view.supportedBoundaries).toEqual(['none'])
    expect(Object.isFrozen(source)).toBe(false)
    expect(Object.isFrozen(view)).toBe(true)
  })

  it.each(['ready', 'stage', 'export', 'shutdown'])('contains a throwing %s lookup and never retries a partial capture', key => {
    const source = exporter(), get = vi.fn(() => { throw new Error('PRIVATE_METHOD/DETAIL~SENTINEL%') })
    const shutdown = source.shutdown
    Object.defineProperty(source, key, { get })
    const plan = preflightExporterIdentities([registration(source)])
    for (let attempt = 0; attempt < 2; attempt++) {
      try { captureExporterMethods(plan); throw new Error('Expected failure') } catch (error) {
        expect(error).toMatchObject({ code: 'RUNTIME_CONSTRUCTION_FAILED', cleanup: [] })
        expect(String(error)).not.toContain('PRIVATE_METHOD/DETAIL~SENTINEL%')
        expect((error as Error).cause).toBeUndefined()
      }
    }
    expect(get).toHaveBeenCalledTimes(1)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('keeps all captured lifecycle references after caller deletion', async () => {
    const source = exporter(), plan = preflightExporterIdentities([registration(source)])
    const [captured] = captureExporterMethods(plan)
    const ready = source.ready!, send = source.export, shutdown = source.shutdown!
    Reflect.deleteProperty(source, 'ready')
    Reflect.deleteProperty(source, 'export')
    Reflect.deleteProperty(source, 'shutdown')
    await captured!.exporter.ready!(new AbortController().signal)
    await captured!.exporter.export({} as ObservationDeliveryBatch, new AbortController().signal)
    await captured!.exporter.shutdown!(new AbortController().signal)
    expect(ready).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('stamps a separate frozen wrapper without invoking lifecycle or freezing caller state', async () => {
    const source = exporter()
    const wrapped = defineObservationExporter(source)
    expect(wrapped).not.toBe(source)
    expect(wrapped).toMatchObject({ kind: 'observation-exporter', apiVersion: 1 })
    expect(Object.isFrozen(wrapped)).toBe(true)
    expect(Object.isFrozen(source)).toBe(false)
    expect(source.ready).not.toHaveBeenCalled()
    expect(source.export).not.toHaveBeenCalled()
    expect(source.shutdown).not.toHaveBeenCalled()
    await wrapped.ready!(new AbortController().signal)
    expect(source.ready).toHaveBeenCalledTimes(1)
  })

  it('stops method capture immediately if a method getter aborts construction', () => {
    const source = exporter(), controller = new AbortController(), later = vi.fn()
    Object.defineProperty(source, 'ready', { get() { controller.abort(); return async () => undefined } })
    Object.defineProperty(source, 'export', { get: later })
    const plan = preflightExporterIdentities([registration(source)])
    expect(() => captureExporterMethods(plan, controller.signal))
      .toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_ABORTED', cleanup: [] }))
    expect(later).not.toHaveBeenCalled()
    expect(source.shutdown).not.toHaveBeenCalled()
  })

  it.each(['ready', 'stage', 'export', 'shutdown'])('rejects non-callable %s before ownership transfer', key => {
    const source = { ...exporter(), [key]: null }
    const plan = preflightExporterIdentities([{ ...registration(), exporter: source }])
    expect(() => captureExporterMethods(plan)).toThrow(expect.objectContaining({ stage: 'preflight', cleanup: [] }))
  })
})
