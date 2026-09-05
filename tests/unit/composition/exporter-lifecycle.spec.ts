import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntimeConstructionError } from '../../../packages/core/src/composition/common/errors.ts'
import { RuntimeExporters } from '../../../packages/core/src/composition/exporter/lifecycle.ts'
import { captureExporterMethods, preflightExporterIdentities } from '../../../packages/core/src/composition/exporter/preflight.ts'
import { deferred, exporter, provider, registration, startupFixture } from './exporter-fixtures.ts'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function fakeTime() { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) }
beforeEach(fakeTime)

describe('transactional runtime capability startup', () => {
  it('publishes installed capability handles only after readiness and closes owned exporters once', async () => {
    const pending = deferred<void>(), started = deferred<void>()
    const first = exporter('first'), borrowed = exporter('borrowed')
    const ready = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); started.resolve(); await pending.promise })
    const fixture = startupFixture([registration({ ...first, ready }), registration(borrowed, 'borrowed')])
    let returned = false
    const startup = fixture.start().then(value => { returned = true; return value })
    await started.promise
    expect(returned).toBe(false)
    expect(fixture.registry.listProviders()).toHaveLength(1)
    pending.resolve()
    const activated = await startup
    expect(borrowed.ready).toHaveBeenCalledTimes(1)
    expect(first.export).not.toHaveBeenCalled()
    const firstClose = activated.exporters.close(fixture.resources.platform.monotonicNow() + 100)
    expect(activated.exporters.close(Number.NaN)).toBe(firstClose)
    expect(await firstClose).toEqual([{ kind: 'observation-exporter', id: 'exporter-0', status: 'closed' }])
    expect(first.shutdown).toHaveBeenCalledTimes(1)
    expect(borrowed.shutdown).not.toHaveBeenCalled()
    for (const entry of [...activated.providers].reverse()) entry.close()
    expect(fixture.resources.pendingTimers).toBe(0)
    expect(fixture.resources.pendingListeners).toBe(0)
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it.each(['owned', 'borrowed'] as const)('readiness failure rolls back every owned registration, including not-yet-ready (%s failure)', async ownership => {
    const order: string[] = []
    const a = { ...exporter('a'), shutdown: vi.fn(async () => { order.push('a') }) }
    const b = { ...exporter('b'), ready: vi.fn(async () => { throw new Error('PRIVATE_READY/REASON~SENTINEL%') }),
      shutdown: vi.fn(async () => { order.push('b') }) }
    const c = { ...exporter('c'), shutdown: vi.fn(async () => { order.push('c') }) }
    const fixture = startupFixture([registration(a), registration(b, ownership), registration(c)], [
      provider('one', vi.fn(() => { order.push('provider-one') })),
      provider('two', vi.fn(() => { order.push('provider-two') })),
    ])
    const error = await fixture.start().catch(error => error as unknown)
    expect(error).toBeInstanceOf(AgentRuntimeConstructionError)
    expect(error).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'exporter-ready', reason: 'failed',
      component: { kind: 'observation-exporter', id: 'exporter-1' } })
    expect(JSON.stringify(error)).not.toContain('PRIVATE_READY/REASON~SENTINEL%')
    expect(order).toEqual(['provider-two', 'provider-one', 'c', ...ownership === 'owned' ? ['b'] : [], 'a'])
    expect(c.ready).not.toHaveBeenCalled()
    expect(fixture.registry.listProviders()).toEqual([])
    expect(fixture.resources.pendingTimers).toBe(0)
    expect(fixture.resources.pendingListeners).toBe(0)
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it.each(['owned', 'borrowed'] as const)('bounds noncooperative readiness by the startup deadline (%s)', async ownership => {
    fakeTime()
    const pending = deferred<void>(), entered = deferred<void>()
    const source = exporter()
    let readySignal!: AbortSignal
    const ready = vi.fn(async (signal: AbortSignal) => { readySignal = signal; entered.resolve(); await pending.promise })
    const fixture = startupFixture([registration({ ...source, ready }, ownership)])
    const failed = fixture.start().catch(error => error as unknown)
    await entered.promise
    await vi.advanceTimersByTimeAsync(20)
    const error = await failed
    expect(error).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_TIMEOUT', reason: 'timed-out', stage: 'exporter-ready' })
    expect(readySignal.aborted).toBe(true)
    expect(source.shutdown).toHaveBeenCalledTimes(ownership === 'owned' ? 1 : 0)
    expect(fixture.registry.listProviders()).toEqual([])
    expect(fixture.resources.pendingTimers).toBe(0)
    expect(fixture.resources.pendingListeners).toBe(0)
    pending.reject(new Error('PRIVATE_LATE_READY_FAILURE'))
    await Promise.resolve()
    fixture.resources.close()
    await fixture.bus.shutdown()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['owned', 'borrowed'] as const)('caller cancellation rolls back without forwarding it to cleanup (%s)', async ownership => {
    fakeTime()
    const caller = new AbortController(), entered = deferred<void>(), pending = deferred<void>()
    const source = exporter()
    const shutdown = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false) })
    const fixture = startupFixture([registration({ ...source,
      ready: async () => { entered.resolve(); await pending.promise }, shutdown,
    }, ownership)], undefined, caller.signal)
    const failed = fixture.start().catch(error => error as unknown)
    await entered.promise
    caller.abort('PRIVATE_ABORT/REASON~SENTINEL%')
    const error = await failed
    expect(error).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_ABORTED', reason: 'aborted' })
    expect(JSON.stringify(error)).not.toContain('PRIVATE_ABORT/REASON~SENTINEL%')
    expect(shutdown).toHaveBeenCalledTimes(ownership === 'owned' ? 1 : 0)
    pending.resolve()
    expect(fixture.resources.pendingTimers).toBe(0)
    expect(fixture.resources.pendingListeners).toBe(0)
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('cleans transferred exporters when provider setup fails before any exporter readiness', async () => {
    const source = exporter(), borrowed = exporter('borrowed')
    const plugin = { ...provider(), setup() { throw new Error('PRIVATE_SETUP_REASON') } }
    const fixture = startupFixture([registration(source), registration(borrowed, 'borrowed')], [plugin])
    await expect(fixture.start()).rejects.toMatchObject({ failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup',
      cleanup: [{ kind: 'observation-exporter', id: 'exporter-0', status: 'closed' }] })
    expect(source.ready).not.toHaveBeenCalled()
    expect(source.shutdown).toHaveBeenCalledTimes(1)
    expect(borrowed.shutdown).not.toHaveBeenCalled()
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('retains primary failure and all cleanup failures even when cleanup aborts the caller', async () => {
    const caller = new AbortController()
    const source = { ...exporter(), ready: async () => { throw new Error('PRIVATE_READY/REASON~SENTINEL%') },
      shutdown: async () => { caller.abort(); throw new Error('PRIVATE_SHUTDOWN/REASON~SENTINEL%') } }
    const fixture = startupFixture([registration(source)], [provider('p', vi.fn(() => {
      throw new Error('PRIVATE_PROVIDER/CLEANUP~SENTINEL%')
    }))], caller.signal)
    const error = await fixture.start().catch(error => error as unknown)
    expect(error).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_FAILED', reason: 'failed', cleanup: [
      { kind: 'provider-registration', status: 'failed' }, { kind: 'observation-exporter', status: 'failed' },
    ] })
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('PRIVATE_READY/REASON~SENTINEL%')
    expect(serialized).not.toContain('PRIVATE_SHUTDOWN/REASON~SENTINEL%')
    expect(serialized).not.toContain('PRIVATE_PROVIDER/CLEANUP~SENTINEL%')
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('shares one startup deadline across providers and sequential exporters', async () => {
    fakeTime()
    const a = exporter('a'), b = exporter('b'), entered = deferred<void>(), pending = deferred<void>()
    const readyA = async () => { await new Promise(resolve => setTimeout(resolve, 12)) }
    const readyB = async () => { entered.resolve(); await pending.promise }
    const fixture = startupFixture([registration({ ...a, ready: readyA }), registration({ ...b, ready: readyB })])
    const failed = fixture.start().catch(error => error as unknown)
    await vi.advanceTimersByTimeAsync(12)
    await entered.promise
    await vi.advanceTimersByTimeAsync(8)
    expect(await failed).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_TIMEOUT', component: { id: 'exporter-1' } })
    pending.resolve()
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('uses a separate bounded rollback budget and contains late cleanup rejection', async () => {
    fakeTime()
    const entered = deferred<void>(), pending = deferred<void>(), later = exporter('later')
    const slow = { ...exporter('slow'), ready: async () => { throw new Error('PRIVATE_READY/REASON~SENTINEL%') },
      shutdown: async () => { entered.resolve(); await pending.promise } }
    // Reverse cleanup visits slow first. Once its shared budget is used, later is reported but not invoked.
    const fixture = startupFixture([registration(later), registration(slow)])
    const failed = fixture.start().catch(error => error as unknown)
    await entered.promise
    await vi.advanceTimersByTimeAsync(30)
    const error = await failed
    expect(error).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_FAILED', cleanup: [
      { kind: 'provider-registration', status: 'closed' },
      { id: 'exporter-1', status: 'timed-out', error: { code: 'CAPABILITY_CLEANUP_TIMEOUT' } },
      { id: 'exporter-0', status: 'timed-out' },
    ] })
    expect(later.shutdown).not.toHaveBeenCalled()
    pending.reject(new Error('PRIVATE_LATE_CLEANUP'))
    await Promise.resolve()
    expect(fixture.resources.pendingListeners).toBe(0)
    expect(fixture.resources.pendingTimers).toBe(0)
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('captures shutdown and ownership so mutation after preflight cannot redirect rollback', async () => {
    const source = exporter(), input = { ...registration(source) }
    const entered = deferred<void>(), pending = deferred<void>()
    Object.assign(source, { ready: async () => { entered.resolve(); await pending.promise } })
    const shutdown = source.shutdown
    const fixture = startupFixture([input])
    const failed = fixture.start().catch(error => error as unknown)
    await entered.promise
    Object.assign(source, { id: 'changed', shutdown: vi.fn() })
    input.ownership = 'borrowed'
    pending.reject(new Error('ready failure'))
    expect(await failed).toMatchObject({ cleanup: expect.arrayContaining([{ kind: 'observation-exporter', id: 'exporter-0', status: 'closed' }]) })
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(source.shutdown).not.toHaveBeenCalled()
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('joins a close triggered reentrantly while readiness is aborted', async () => {
    const fixture = startupFixture([]), entered = deferred<void>(), pending = deferred<void>()
    let nested: ReturnType<RuntimeExporters['close']> | undefined
    const source = { ...exporter(), ready: async (signal: AbortSignal) => {
      signal.addEventListener('abort', () => { nested = owner.close(Number.NaN) }, { once: true })
      entered.resolve(); await pending.promise
    } }
    const owner = new RuntimeExporters(captureExporterMethods(preflightExporterIdentities([registration(source)])), fixture.resources)
    const ready = owner.ready(fixture.resources.platform.monotonicNow() + 100).catch(error => error as unknown)
    await entered.promise
    const close = owner.close(fixture.resources.platform.monotonicNow() + 100)
    expect(nested).toBe(close)
    expect(await close).toMatchObject([{ status: 'closed' }])
    expect(await ready).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_ABORTED' })
    pending.resolve()
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('does not transfer ownership if cancellation arrives between preflight and activation', async () => {
    const caller = new AbortController(), source = exporter(), plugin = provider()
    const fixture = startupFixture([registration(source)], [plugin], caller.signal)
    caller.abort()
    await expect(fixture.start()).rejects.toMatchObject({ failureCode: 'CAPABILITY_STARTUP_ABORTED', cleanup: [] })
    expect(source.shutdown).not.toHaveBeenCalled()
    expect(plugin.setup).not.toHaveBeenCalled()
    expect(fixture.resources.pendingTimers).toBe(0)
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('classifies cancellation at the final activation boundary as activation, not inert preflight', async () => {
    const caller = new AbortController(), source = provider(), setup = source.setup
    const fixture = startupFixture([], [{ ...source, setup(registrar: Parameters<typeof setup>[0]) {
      const cleanup = setup(registrar)
      queueMicrotask(() => caller.abort())
      return cleanup
    } }], caller.signal)
    await expect(fixture.start()).rejects.toMatchObject({
      failureCode: 'CAPABILITY_STARTUP_ABORTED', reason: 'aborted', stage: 'activation',
      cleanup: [{ kind: 'provider-registration', status: 'closed' }],
    })
    expect(fixture.registry.listProviders()).toEqual([])
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it('does not start another provider after synchronous setup consumes the startup budget', async () => {
    fakeTime()
    const first = provider('first'), second = provider('second'), source = exporter()
    const setup = first.setup
    const fixture = startupFixture([registration(source)], [{ ...first, setup(registrar: Parameters<typeof setup>[0]) {
      const cleanup = setup(registrar)
      vi.advanceTimersByTime(25)
      return cleanup
    } }, second])
    await expect(fixture.start()).rejects.toMatchObject({
      failureCode: 'CAPABILITY_STARTUP_TIMEOUT', reason: 'timed-out', stage: 'provider-setup',
      component: { id: 'provider-1' },
    })
    expect(second.setup).not.toHaveBeenCalled()
    expect(source.ready).not.toHaveBeenCalled()
    expect(source.shutdown).toHaveBeenCalledTimes(1)
    expect(fixture.registry.listProviders()).toEqual([])
    fixture.resources.close()
    await fixture.bus.shutdown()
  })

  it.each(['provider-setup', 'exporter-ready'])('shares one rollback budget through provider cleanup and exporter shutdown after %s fails', async failureStage => {
    fakeTime()
    const firstCleanup = vi.fn(() => undefined)
    const secondCleanup = vi.fn(() => { vi.advanceTimersByTime(40) })
    const source = exporter()
    const plugins = [provider('first', firstCleanup), provider('second', secondCleanup)]
    if (failureStage === 'provider-setup') plugins.push({ ...provider('broken'), setup() { throw new Error('PRIVATE_FAILURE') } })
    const fixture = startupFixture([registration({ ...source, ready: async () => { throw new Error('PRIVATE_FAILURE') } })], plugins)
    const error = await fixture.start().catch(error => error as unknown)
    expect(error).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_FAILED', stage: failureStage, cleanup: [
      { id: 'provider-1', status: 'closed' },
      { id: 'provider-0', status: 'timed-out', error: { code: 'CAPABILITY_CLEANUP_TIMEOUT' } },
      { id: 'exporter-0', status: 'timed-out' },
    ] })
    expect(secondCleanup).toHaveBeenCalledTimes(1)
    expect(firstCleanup).not.toHaveBeenCalled()
    expect(source.shutdown).not.toHaveBeenCalled()
    expect(fixture.registry.listProviders()).toEqual([])
    fixture.resources.close()
    await fixture.bus.shutdown()
  })
})
