import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { createObservability } from '../../../packages/core/src/observability/bus.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import type { AdapterRegistrationHandle, ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { activateProviders, type RuntimeProviderRegistrar } from '../../../packages/core/src/composition/provider/activation.ts'
import { captureProviderMethods, preflightProviderIdentities } from '../../../packages/core/src/composition/provider/preflight.ts'
import { resolveAgentModel } from '../../../packages/core/src/composition/provider/model-selection.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { defineModelProviderPlugin } from '../../../packages/core/src/composition/provider/definition.ts'
import { RuntimeOperations } from '../../../packages/core/src/composition/lifecycle/operations.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'

class Adapter extends ModelAdapter {
  requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(id: string, setup: ComposableModelProviderPlugin['setup'], routes = [id]): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id, displayName: id, routes, setup }
}

function activate(sources: readonly ComposableModelProviderPlugin[], signal?: AbortSignal) {
  const registry = new ModelRegistry()
  const logger = createObservability().logger()
  const plan = preflightProviderIdentities(sources, undefined, signal)
  const captured = captureProviderMethods(plan, signal)
  return { registry, logger, plan, start: () => activateProviders(registry, captured, logger, signal) }
}

describe('claim-scoped provider activation on the real registry', () => {
  it('admits a structurally complete adapter without ModelAdapter inheritance', async () => {
    const requests: GenerateOptions[] = []
    const stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const adapter: ModelAdapter = {
      providerInfo: route => ({ id: route, name: 'Structural adapter' }),
      providerRetryPolicy: () => undefined,
      listModels: () => Promise.resolve([]),
      modelCatalog: route => Promise.resolve({
        provider: { id: route, name: 'Structural adapter' }, state: 'empty',
        revision: 'structural-v1', models: [], observedAt: new Date(0).toISOString(),
      }),
      resolveModel: (route, model) => Promise.resolve({ provider: route, id: model, name: model }),
      prepareCall: (route, model) => Promise.resolve({
        model: { provider: route, id: model, name: model }, stream,
      }),
      stream,
    }
    expect(adapter).not.toBeInstanceOf(ModelAdapter)
    const fixture = activate([provider('structural', registrar => {
      registrar.registerAdapter(['structural'], adapter)
    })])
    const registrations = fixture.start()
    const handle = fixture.registry.stream({ provider: 'structural', model: 'm', messages: [] })
    for await (const _chunk of handle) { /* drain */ }
    expect(requests).toHaveLength(1)
    expect(await handle.report).toMatchObject({ status: 'success', reported: { totalTokens: 2 } })
    registrations[0]!.close()
  })

  it('lets a helper-defined one-adapter provider use all claims without repeating routes', async () => {
    const adapter = new Adapter()
    const setup = vi.fn(function (this: { calls: number }, registrar) {
      this.calls++
      registrar.registerAdapter(adapter)
      return undefined
    })
    const replacement = vi.fn()
    const definition = { id: 'helper', displayName: 'Helper', routes: ['helper'], calls: 0, setup }
    const plugin = defineModelProviderPlugin(definition)
    definition.setup = replacement
    const fixture = activate([plugin])
    const registrations = fixture.start()
    const handle = fixture.registry.stream({ provider: 'helper', model: 'model', messages: [] })
    for await (const _chunk of handle) { /* drain */ }
    expect(adapter.requests).toHaveLength(1)
    expect(definition.calls).toBe(1)
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ logger: fixture.logger }))
    expect(replacement).not.toHaveBeenCalled()
    expect(Object.isFrozen(plugin)).toBe(true)
    expect(Object.isFrozen(definition)).toBe(false)
    registrations[0]!.close()
  })

  it('scopes helper explicit registrations to claims and enforces exact coverage transactionally', () => {
    const valid = defineModelProviderPlugin({
      id: 'multi', displayName: 'Multi', routes: ['one', 'two'],
      setup(registrar) {
        registrar.registerAdapter(new Adapter(), ['one'])
        registrar.registerAdapter(new Adapter(), ['two'])
        return undefined
      },
    })
    const fixture = activate([valid])
    const [registration] = fixture.start()
    expect(fixture.registry.listProviders().map(row => row.id).sort()).toEqual(['one', 'two'])
    registration!.close()

    const invalid = defineModelProviderPlugin({
      id: 'invalid', displayName: 'Invalid', routes: ['inside'],
      setup(registrar) {
        registrar.registerAdapter(new Adapter(), ['outside'])
        return undefined
      },
    })
    expect(activate([invalid]).start).toThrow(expect.objectContaining({
      failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup',
    }))
  })

  it('routes two installations in one provider family independently with matching call evidence', async () => {
    const a = new Adapter(), b = new Adapter()
    const fixture = activate([
      { ...provider('a', registrar => { registrar.registerAdapter(['a'], a) }), family: 'openai',
        defaultModel: { provider: 'a', id: 'default-a' } },
      { ...provider('b', registrar => { registrar.registerAdapter(['b'], b) }), family: 'openai' },
    ])
    const registrations = fixture.start()
    const targetA = resolveAgentModel(fixture.plan, { provider: 'a', id: 'account-a-model' })
    const targetB = resolveAgentModel(fixture.plan, { provider: 'b', id: 'specialist' })
    const handleA = fixture.registry.stream({ provider: targetA.provider, model: targetA.id, messages: [] })
    const handleB = fixture.registry.stream({ provider: targetB.provider, model: targetB.id, messages: [] })
    for await (const _chunk of handleA) { /* drain through the real call handle */ }
    for await (const _chunk of handleB) { /* drain through the real call handle */ }
    expect(b.requests).toHaveLength(1)
    expect(a.requests).toHaveLength(1)
    expect(await handleA.report).toMatchObject({ provider: 'a', providerFamily: 'openai',
      providerPluginId: 'a', model: 'account-a-model', status: 'success' })
    expect(await handleB.report).toMatchObject({ provider: 'b', providerFamily: 'openai',
      providerPluginId: 'b', model: 'specialist', status: 'success' })
    for (const registration of [...registrations].reverse()) registration.close()
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('injects the supplied logger and seals every mutation/disposal path until cleanup', () => {
    let registrar!: ModelProviderRegistrar
    let handle!: AdapterRegistrationHandle
    let removeMiddleware!: () => void
    const cleanup = vi.fn(() => { handle(); removeMiddleware() })
    const fixture = activate([provider('a', input => {
      registrar = input
      handle = input.registerAdapter(['a'], new Adapter())
      removeMiddleware = input.use((_options, next) => next())
      return cleanup
    })])
    const [registration] = fixture.start()
    expect((registrar as RuntimeProviderRegistrar).logger).toBe(fixture.logger)
    for (const mutate of [
      () => registrar.registerAdapter(['a'], new Adapter()),
      () => registrar.use((_options, next) => next()),
      () => handle.replace(['a']), () => handle(), () => removeMiddleware(),
    ]) expect(mutate).toThrow(expect.objectContaining({ code: 'PROVIDER_REGISTRAR_SEALED' }))
    const report = registration!.close()
    expect(report.status).toBe('closed')
    expect(registration!.close()).toBe(report)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('permits setup-time replacement only within claims and exact final coverage', () => {
    const fixture = activate([provider('a', registrar => {
      const adapter = new Adapter()
      const first = registrar.registerAdapter(['one'], adapter)
      first.replace(['two'])
      registrar.registerAdapter(['one'], adapter)
    }, ['one', 'two'])])
    const [registration] = fixture.start()
    expect(fixture.registry.listProviders().map(row => row.id).sort()).toEqual(['one', 'two'])
    registration!.close()
  })

  it.each(['missing', 'duplicate', 'undeclared', 'replacement', 'released'])('rejects %s route claims transactionally', variant => {
    const cleanup = vi.fn()
    const fixture = activate([provider('a', registrar => {
      const handle = registrar.registerAdapter(['one'], new Adapter())
      if (variant === 'duplicate') registrar.registerAdapter(['one'], new Adapter())
      if (variant === 'undeclared') registrar.registerAdapter(['outside'], new Adapter())
      if (variant === 'replacement') handle.replace(['outside'])
      if (variant === 'released') handle()
      return cleanup
    }, ['one', 'two'])])
    expect(fixture.start).toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup' }))
    expect(fixture.registry.listProviders()).toEqual([])
    // Only a successfully returned disposer transfers cleanup responsibility to core.
    expect(cleanup).toHaveBeenCalledTimes(variant === 'missing' || variant === 'released' ? 1 : 0)
  })

  it('rolls back earlier registrations in reverse order and retains cleanup failures', () => {
    const closed: string[] = []
    const fixture = activate([
      provider('a', registrar => {
        registrar.registerAdapter(['a'], new Adapter())
        return () => { closed.push('a'); throw new Error('RAW_CLEANUP/PRIVATE~SENTINEL%') }
      }),
      provider('b', registrar => {
        registrar.registerAdapter(['b'], new Adapter())
        return () => { closed.push('b') }
      }),
      provider('c', () => { throw new Error('RAW_SETUP/PRIVATE~SENTINEL%') }),
    ])
    try { fixture.start(); throw new Error('Expected startup failure') } catch (error) {
      expect(error).toMatchObject({ failureCode: 'CAPABILITY_STARTUP_FAILED', cleanup: [
        { id: 'provider-1', status: 'closed' }, { id: 'provider-0', status: 'failed' },
      ] })
      expect(JSON.stringify(error)).not.toContain('PRIVATE~SENTINEL%')
    }
    expect(closed).toEqual(['b', 'a'])
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('contains rejected async setup and rejects late registrar use', async () => {
    let late: (() => unknown) | undefined
    const fixture = activate([provider('a', (async (registrar: ModelProviderRegistrar) => {
      registrar.registerAdapter(['a'], new Adapter())
      late = () => registrar.registerAdapter(['a'], new Adapter())
      await Promise.resolve()
      throw new Error('ASYNC_SETUP/PRIVATE~SENTINEL%')
    }) as unknown as ComposableModelProviderPlugin['setup'])])
    expect(fixture.start).toThrow(expect.objectContaining({ failureCode: 'PROVIDER_SETUP_ASYNC_UNSUPPORTED' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(late).toThrow(expect.objectContaining({ code: 'PROVIDER_REGISTRAR_SEALED' }))
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('contains async cleanup without leaving routes or unhandled rejections', async () => {
    const fixture = activate([provider('a', registrar => {
      registrar.registerAdapter(['a'], new Adapter())
      return async () => { throw new Error('ASYNC_CLEANUP/PRIVATE~SENTINEL%') }
    })])
    const [registration] = fixture.start()
    const report = registration!.close()
    expect(report).toMatchObject({ status: 'failed', error: { code: 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED' } })
    expect(registration!.close()).toBe(report)
    expect(fixture.registry.listProviders()).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('preserves the async-cleanup code in construction rollback', async () => {
    const fixture = activate([
      provider('a', registrar => {
        registrar.registerAdapter(['a'], new Adapter())
        return async () => { throw new Error('PRIVATE_ASYNC_CLEANUP') }
      }),
      provider('b', () => { throw new Error('PRIVATE_STARTUP') }),
    ])
    expect(fixture.start).toThrow(expect.objectContaining({
      failureCode: 'CAPABILITY_STARTUP_FAILED',
      cleanup: [expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'PROVIDER_CLEANUP_ASYNC_UNSUPPORTED' }) })],
    }))
    expect(fixture.registry.listProviders()).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('removes topology before cleanup, after operation quiescence has sealed late writes', async () => {
    const resources = new RuntimeResources(createRuntimePlatform())
    const operations = new RuntimeOperations(resources)
    const lease = operations.acquire('model-catalog')
    const order: string[] = []
    lease.signal.addEventListener('abort', () => { order.push('abort') }, { once: true })
    const fixture = activate(['a', 'b'].map(id => provider(id, registrar => {
      registrar.registerAdapter([id], new Adapter())
      return () => {
        expect(lease.publish(() => { throw new Error('late cache write') })).toBe(false)
        expect(fixture.registry.listProviders().some(row => row.id === id)).toBe(false)
        order.push(`cleanup-${id}`)
      }
    })))
    const installed = fixture.start()
    const caller = new AbortController()
    const close = operations.beginClose({ timeoutMs: 1_000, signal: caller.signal })
    expect(order).toEqual(['abort'])
    expect(fixture.registry.listProviders()).toHaveLength(2)
    caller.abort()
    expect((await close).quiescenceEnd).toBe('caller-abort')
    order.push('sealed')
    for (const registration of [...installed].reverse()) expect(registration.close().status).toBe('closed')
    operations.finishClose()
    expect(order).toEqual(['abort', 'sealed', 'cleanup-b', 'cleanup-a'])
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
  })

  it('rolls back when setup aborts and does not access later providers', () => {
    const controller = new AbortController()
    const cleanup = vi.fn()
    const later = vi.fn()
    const fixture = activate([
      provider('a', registrar => {
        registrar.registerAdapter(['a'], new Adapter())
        controller.abort('RAW_ABORT/PRIVATE~SENTINEL%')
        return cleanup
      }),
      provider('b', later),
    ], controller.signal)
    expect(fixture.start).toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_ABORTED', reason: 'aborted' }))
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('does not replace a primary setup failure with cancellation triggered during rollback', () => {
    const controller = new AbortController()
    const fixture = activate([
      provider('a', registrar => {
        registrar.registerAdapter(['a'], new Adapter())
        return () => { controller.abort() }
      }),
      provider('b', () => { throw new Error('primary') }),
    ], controller.signal)
    expect(fixture.start).toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_FAILED', reason: 'failed' }))
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('preserves a coverage failure when that same provider cleanup aborts the caller', () => {
    const controller = new AbortController()
    const fixture = activate([provider('a', registrar => {
      registrar.registerAdapter(['one'], new Adapter())
      return () => { controller.abort() }
    }, ['one', 'two'])], controller.signal)
    expect(fixture.start).toThrow(expect.objectContaining({
      failureCode: 'CAPABILITY_STARTUP_FAILED', reason: 'failed',
      cleanup: [expect.objectContaining({ status: 'closed' })],
    }))
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('retains successful cleanup evidence when registry commit validation fails after setup', () => {
    const controller = new AbortController()
    let reads = 0
    class ChangingAdapter extends Adapter {
      override providerInfo(route: string) {
        if (++reads > 1) throw new Error('metadata changed during commit')
        return super.providerInfo(route)
      }
    }
    const cleanup = vi.fn(() => { controller.abort() })
    const fixture = activate([provider('a', registrar => {
      registrar.registerAdapter(['a'], new ChangingAdapter())
      return cleanup
    })], controller.signal)
    expect(fixture.start).toThrow(expect.objectContaining({
      failureCode: 'CAPABILITY_STARTUP_FAILED', reason: 'failed',
      cleanup: [expect.objectContaining({ status: 'closed' })],
    }))
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(fixture.registry.listProviders()).toEqual([])
  })

  it('skips an expired disposer but still removes topology and seals its registration', () => {
    const cleanup = vi.fn()
    const fixture = activate([provider('a', registrar => {
      registrar.registerAdapter(['a'], new Adapter())
      return cleanup
    })])
    const [registration] = fixture.start()
    const report = registration!.close({ at: 10, now: () => 10 })
    expect(report).toMatchObject({ status: 'timed-out', error: { code: 'CAPABILITY_CLEANUP_TIMEOUT' } })
    expect(fixture.registry.listProviders()).toEqual([])
    expect(cleanup).not.toHaveBeenCalled()
    expect(registration!.close({ at: 100, now: () => 0 })).toBe(report)
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('does not claim synchronous cleanup was preempted after it starts within its budget', () => {
    let now = 0
    const cleanup = vi.fn(() => { now = 100 })
    const fixture = activate([provider('a', registrar => {
      registrar.registerAdapter(['a'], new Adapter())
      return cleanup
    })])
    const [registration] = fixture.start()
    expect(registration!.close({ at: 10, now: () => now }).status).toBe('closed')
    expect(now).toBe(100)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
