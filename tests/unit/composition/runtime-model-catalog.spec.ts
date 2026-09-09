import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type {
  ModelCatalogOptions, ModelCatalogSnapshot, ModelInfo,
} from '../../../packages/core/src/contract/model-info.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { RuntimeModelCatalog } from '../../../packages/core/src/composition/model-catalog/manager.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { RuntimeOperations } from '../../../packages/core/src/composition/lifecycle/operations.ts'
import type { RuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'

class CatalogAdapter extends ModelAdapter {
  calls = 0
  readonly signals: AbortSignal[] = []
  constructor(private readonly load: (call: number, signal?: AbortSignal) => Promise<readonly ModelInfo[]>) { super() }
  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    this.calls++
    if (signal !== undefined) this.signals.push(signal)
    return await this.load(this.calls, signal).then(models => models.map(model => ({ ...model, provider })))
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class StaticCatalogAdapter extends ModelAdapter {
  calls = 0
  override async modelCatalog(provider: string, _options?: ModelCatalogOptions): Promise<ModelCatalogSnapshot> {
    this.calls++
    return { provider: { id: provider, name: 'Static' }, state: 'static', revision: 'source-static',
      models: [{ provider, id: 'fixed', name: 'Fixed' }], observedAt: '2026-09-05T00:00:00.000Z' }
  }
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

class RawListAdapter extends ModelAdapter {
  constructor(private readonly models: readonly ModelInfo[]) { super() }
  override listModels(): Promise<readonly ModelInfo[]> { return Promise.resolve(this.models) }
  async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
}

function model(id: string): ModelInfo { return { provider: 'replaced', id, name: id.toUpperCase() } }

function provider(id: string, route: string, adapter: ModelAdapter): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id, family: 'catalog-family',
    displayName: `Provider ${id}`, routes: [route],
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter([route], adapter) } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('runtime model catalog', () => {
  it('publishes enriched fresh/empty snapshots, caches them and refreshes on force', async () => {
    const full = new CatalogAdapter(async call => call === 1 ? [model('one')] : [model('two')])
    const second = new CatalogAdapter(async () => [model('account-b-model')])
    const runtime = await createRuntimeCompositionOwner({ providers: [
      provider('account-a', 'route-a', full), provider('account-b', 'route-b', second),
    ] })
    const first = await runtime.modelCatalog('route-a')
    expect(first).toMatchObject({ state: 'fresh', revision: 'catalog-1',
      provider: { route: 'route-a', pluginId: 'account-a', family: 'catalog-family' },
      models: [{ provider: 'route-a', id: 'one' }] })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.models)).toBe(true)
    expect(await runtime.modelCatalog('route-a')).toBe(first)
    expect(full.calls).toBe(1)
    const refreshed = await runtime.modelCatalog('route-a', { refresh: 'force' })
    expect(refreshed).toMatchObject({ state: 'fresh', revision: 'catalog-2', models: [{ id: 'two' }] })
    await expect(runtime.modelCatalog('route-b')).resolves.toMatchObject({ state: 'fresh',
      provider: { route: 'route-b', pluginId: 'account-b', family: 'catalog-family' },
      models: [{ provider: 'route-b', id: 'account-b-model' }],
    })
    expect(second.calls).toBe(1)
    await runtime.close()
  })

  it('never refreshes an already published static catalog, including on force', async () => {
    const adapter = new StaticCatalogAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('static-account', 'static-route', adapter)] })
    const first = await runtime.modelCatalog('static-route')
    expect(first).toMatchObject({ state: 'static', models: [{ id: 'fixed' }] })
    expect(first).not.toHaveProperty('expiresAt')
    expect(await runtime.modelCatalog('static-route', { refresh: 'force' })).toBe(first)
    expect(adapter.calls).toBe(1)
    await runtime.close()
  })

  it('keeps failure distinct from empty and applies retry backoff unless forced', async () => {
    const adapter = new CatalogAdapter(async () => { throw new Error('PRIVATE_CATALOG/BODY~SENTINEL%') })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('failed-account', 'failed-route', adapter)] })
    const first = await runtime.modelCatalog('failed-route')
    expect(first).toMatchObject({ state: 'unavailable', models: [],
      error: { code: 'MODEL_CATALOG_UNAVAILABLE', stage: 'model-catalog' } })
    expect(JSON.stringify(first)).not.toContain('PRIVATE_CATALOG/BODY~SENTINEL%')
    expect(await runtime.modelCatalog('failed-route')).toBe(first)
    expect(adapter.calls).toBe(1)
    const forced = await runtime.modelCatalog('failed-route', { refresh: 'force' })
    expect(forced.revision).not.toBe(first.revision)
    expect(adapter.calls).toBe(2)
    await expect(runtime.agent({ id: 'explicit-despite-catalog',
      model: { provider: 'failed-route', id: 'manual-model' }, instructions: 'Run explicitly.',
      compaction: false }).generate('go')).resolves.toMatchObject({ report: { status: 'success' } })
    await runtime.close()
  })

  it('recovers from cached failure only when a permitted refresh succeeds', async () => {
    const adapter = new CatalogAdapter(async call => {
      if (call === 1) throw new Error('first discovery failed')
      return [model('recovered')]
    })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('recovery-account', 'recovery-route', adapter)] })
    const failed = await runtime.modelCatalog('recovery-route')
    expect(failed.state).toBe('unavailable')
    expect(await runtime.modelCatalog('recovery-route')).toBe(failed)
    await expect(runtime.modelCatalog('recovery-route', { refresh: 'force' })).resolves.toMatchObject({
      state: 'fresh', models: [{ id: 'recovered' }],
    })
    expect(adapter.calls).toBe(2)
    await runtime.close()
  })

  it.each([
    ['wrong route', () => [model('wrong')]],
    ['too many rows', () => Array.from({ length: 2_049 }, (_value, index) => ({
      provider: 'bounded-route', id: `model-${index}`, name: `Model ${index}`,
    }))],
    ['too many bytes', () => [{ provider: 'bounded-route', id: 'large', name: 'x'.repeat(4 * 1024 * 1024) }]],
  ] as const)('turns %s discovery into unavailable without publishing entries', async (_label, rows) => {
    const runtime = await createRuntimeCompositionOwner({
      providers: [provider('bounded-account', 'bounded-route', new RawListAdapter(rows()))],
    })
    await expect(runtime.modelCatalog('bounded-route')).resolves.toMatchObject({
      state: 'unavailable', models: [], error: { code: 'MODEL_CATALOG_UNAVAILABLE' },
    })
    await runtime.close()
  })

  it('retains last-good models as stale without overwriting them on refresh failure', async () => {
    const adapter = new CatalogAdapter(async call => {
      if (call === 1) return [model('retained')]
      throw new Error('refresh failed')
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['retained-route'], adapter)
    let now = 1_000
    const base = createRuntimePlatform()
    const platform: RuntimePlatform = Object.freeze({ ...base, wallNow: () => now })
    const resources = new RuntimeResources(platform)
    const operations = new RuntimeOperations(resources)
    const catalogs = new RuntimeModelCatalog(registry, operations, resources, [Object.freeze({
      id: 'retained-route', route: 'retained-route', name: 'Retained',
      pluginId: 'retained-account', family: 'catalog-family',
    })], { freshTtlMs: 10, staleTtlMs: 20 })
    await expect(catalogs.get('retained-route')).resolves.toMatchObject({ state: 'fresh' })
    now = 1_015
    const stale = await catalogs.get('retained-route', { refresh: 'force' })
    expect(stale).toMatchObject({ state: 'stale', models: [{ id: 'retained' }] })
    now = 1_031
    await expect(catalogs.get('retained-route', { refresh: 'force' })).resolves.toMatchObject({
      state: 'unavailable', models: [],
    })
    resources.close()
  })

  it('isolates waiter cancellation and aborts shared discovery only after every waiter detaches', async () => {
    const pending = deferred<readonly ModelInfo[]>()
    const adapter = new CatalogAdapter(async (_call, signal) => await new Promise((resolve, reject) => {
      const release = (): void => signal?.removeEventListener('abort', abort)
      const abort = (): void => { release(); reject(new Error('provider aborted')) }
      signal?.addEventListener('abort', abort, { once: true })
      pending.promise.then(value => { release(); resolve(value) }, reject)
    }))
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('shared-account', 'shared-route', adapter)] })
    const firstAbort = new AbortController(), secondAbort = new AbortController()
    const first = runtime.modelCatalog('shared-route', { signal: firstAbort.signal })
    const second = runtime.modelCatalog('shared-route', { signal: secondAbort.signal })
    firstAbort.abort()
    await expect(first).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    expect(adapter.signals[0]?.aborted).toBe(false)
    pending.resolve([model('shared')])
    await expect(second).resolves.toMatchObject({ state: 'fresh', models: [{ id: 'shared' }] })
    expect(adapter.calls).toBe(1)
    await runtime.close()
  })

  it('cancels shared discovery when all waiters detach and contains the provider rejection', async () => {
    const adapter = new CatalogAdapter(async (_call, signal) => await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT_REJECTION')), { once: true })
    }))
    const runtime = await createRuntimeCompositionOwner({ providers: [provider('detach-account', 'detach-route', adapter)] })
    const a = new AbortController(), b = new AbortController()
    const one = runtime.modelCatalog('detach-route', { signal: a.signal })
    const two = runtime.modelCatalog('detach-route', { signal: b.signal })
    await vi.waitFor(() => expect(adapter.calls).toBe(1))
    a.abort(); b.abort()
    await expect(one).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    await expect(two).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    await vi.waitFor(() => expect(adapter.signals[0]?.aborted).toBe(true))
    await runtime.close()
  })

  it('seals an uncooperative refresh at close so late completion cannot publish', async () => {
    const pending = deferred<readonly ModelInfo[]>()
    const adapter = new CatalogAdapter(async () => await pending.promise)
    const runtime = await createRuntimeCompositionOwner({ closeTimeoutMs: 5,
      providers: [provider('late-account', 'late-route', adapter)] })
    const catalog = runtime.modelCatalog('late-route')
    await vi.waitFor(() => expect(adapter.calls).toBe(1))
    const closing = runtime.close()
    await expect(catalog).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    const report = await closing
    expect(report.operations.find(row => row.kind === 'model-catalog')).toMatchObject({
      activeAtClose: 1, aborted: 1, unsettled: 1,
    })
    pending.resolve([model('too-late')])
    await Promise.resolve()
    expect(() => runtime.modelCatalog('late-route')).toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSED' }))
  })
})
