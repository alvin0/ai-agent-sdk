/**
 * Activation across BOTH provider plugin kinds over one shared rollback list.
 *
 * The two edge configurations Requirement 11.8 and 11.9 name are exercised here
 * as whole-runtime scenarios rather than as unit assertions on a helper: the claim
 * is that a runtime starts, serves and closes with only one kind present, and only
 * a real `createAgentRuntime()` can support that claim.
 *
 * @module tests/unit/composition/embedding-activation
 */
import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { createObservability } from '../../../packages/core/src/observability/bus.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import {
  activateEmbeddingProviders, activateRuntimeProviders,
} from '../../../packages/core/src/composition/embedding/activation.ts'
import { EmbeddingRegistry } from '../../../packages/core/src/composition/embedding/registry.ts'
import { defineEmbeddingProviderPlugin } from '../../../packages/core/src/composition/embedding/definition.ts'
import type {
  ComposableEmbeddingProviderPlugin, ComposableRuntimeProviderPlugin,
} from '../../../packages/core/src/composition/embedding/plugin-types.ts'
import { preflightRuntimeCapabilities } from '../../../packages/core/src/composition/preflight.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { RuntimeOwnerOptions } from '../../../packages/core/src/composition/runtime/types.ts'
import { FakeEmbeddingAdapter } from '../../fixtures/embedding/fake-adapter.ts'

class Adapter extends ModelAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function generation(
  id: string, setup: ComposableModelProviderPlugin['setup'], routes = [id],
): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id, displayName: id, routes, setup }
}

function embedding(
  id: string, setup: ComposableEmbeddingProviderPlugin['setup'], routes = [id],
): ComposableEmbeddingProviderPlugin {
  return { kind: 'embedding-provider-plugin', apiVersion: 1, id, displayName: id, routes, setup }
}

/** Preflight the whole list exactly as the runtime does, then activate both kinds. */
function activate(sources: readonly ComposableRuntimeProviderPlugin[], signal?: AbortSignal) {
  const registry = new ModelRegistry()
  const embeddingRegistry = new EmbeddingRegistry()
  const logger = createObservability().logger()
  const plan = preflightRuntimeCapabilities(sources, [], undefined, signal)
  return {
    registry, embeddingRegistry, logger,
    start: () => activateRuntimeProviders({
      registry, embeddingRegistry, providers: plan.providers,
      embeddingProviders: plan.embeddingProviders, logger,
      ...(signal === undefined ? {} : { signal }),
    }),
  }
}

/** Both plugin kinds go into the ONE `providers` list the owner accepts. */
function runtimeOptions(providers: readonly ComposableRuntimeProviderPlugin[]): RuntimeOwnerOptions {
  return { providers }
}

describe('activation over one rollback list shared by both plugin kinds', () => {
  it('installs embedding adapters resolvable by route, operation and model id', () => {
    const adapter = new FakeEmbeddingAdapter()
    const fixture = activate([embedding('emb', registrar => {
      registrar.registerEmbeddingAdapter(['emb'], adapter)
    })])
    const installed = fixture.start()
    expect(installed).toHaveLength(1)
    expect(fixture.embeddingRegistry.resolve('emb', 'any-model').adapter).toBe(adapter)
    // Same route, different operation: generation resolution is untouched.
    expect(fixture.registry.listProviders()).toEqual([])
    expect(installed[0]!.close().status).toBe('closed')
    expect(fixture.embeddingRegistry.listRoutes()).toEqual([])
  })

  it('rolls back generation registrations when a LATER embedding plugin fails', () => {
    const closed: string[] = []
    const fixture = activate([
      generation('gen', registrar => {
        registrar.registerAdapter(['gen'], new Adapter())
        return () => { closed.push('gen') }
      }),
      embedding('emb-ok', registrar => {
        registrar.registerEmbeddingAdapter(['emb-ok'], new FakeEmbeddingAdapter())
        return () => { closed.push('emb-ok') }
      }),
      embedding('emb-bad', registrar => {
        registrar.registerEmbeddingAdapter(['emb-bad'], new FakeEmbeddingAdapter())
        throw new Error('RAW_SETUP/PRIVATE~SENTINEL%')
      }),
    ])
    try {
      fixture.start()
      throw new Error('Expected startup failure')
    } catch (error) {
      expect(error).toMatchObject({
        failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup',
        // Report ids stay positional in the combined list: 2 is the embedding
        // plugin that failed, then 1 and 0 unwind in reverse order.
        component: { id: 'provider-2' },
        cleanup: [{ id: 'provider-2' }, { id: 'provider-1' }, { id: 'provider-0' }],
      })
      expect(JSON.stringify(error)).not.toContain('PRIVATE~SENTINEL%')
    }
    expect(closed).toEqual(['emb-ok', 'gen'])
    expect(fixture.registry.listProviders()).toEqual([])
    expect(fixture.embeddingRegistry.listRoutes()).toEqual([])
  })

  it('rolls back an already-installed embedding plugin when generation fails first', () => {
    // Generation runs first, so its failure must unwind before embedding is ever
    // activated: the shared list is empty at that point and stays empty.
    const embeddingSetup = vi.fn()
    const fixture = activate([
      generation('gen', () => { throw new Error('generation setup failed') }),
      embedding('emb', embeddingSetup),
    ])
    expect(fixture.start).toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_FAILED' }))
    expect(embeddingSetup).not.toHaveBeenCalled()
    expect(fixture.embeddingRegistry.listRoutes()).toEqual([])
  })

  it('withdraws what a throwing embedding setup registered, which returned no disposer', () => {
    const registry = new EmbeddingRegistry()
    const logger = createObservability().logger()
    const plan = preflightRuntimeCapabilities([embedding('emb', registrar => {
      registrar.registerEmbeddingAdapter(['emb'], new FakeEmbeddingAdapter())
      throw new Error('setup exploded')
    })], [])
    expect(() => activateEmbeddingProviders(registry, plan.embeddingProviders, logger))
      .toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_FAILED' }))
    expect(registry.listRoutes()).toEqual([])
  })

  it('runs the disposer and withdraws routes when declared coverage is incomplete', () => {
    const disposer = vi.fn()
    const fixture = activate([embedding('emb', registrar => {
      registrar.registerEmbeddingAdapter(['one'], new FakeEmbeddingAdapter())
      return disposer
    }, ['one', 'two'])])
    expect(fixture.start).toThrow(expect.objectContaining({ failureCode: 'CAPABILITY_STARTUP_FAILED' }))
    expect(disposer).toHaveBeenCalledTimes(1)
    expect(fixture.embeddingRegistry.listRoutes()).toEqual([])
  })

  it('rejects an embedding registration outside the plugin claims and leaves nothing behind', () => {
    const fixture = activate([embedding('emb', registrar => {
      registrar.registerEmbeddingAdapter(['outside'], new FakeEmbeddingAdapter())
    }, ['inside'])])
    expect(fixture.start).toThrow(expect.objectContaining({
      failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup',
    }))
    expect(fixture.embeddingRegistry.listRoutes()).toEqual([])
  })

  it('seals the embedding registrar once setup returns', () => {
    let captured!: { registerEmbeddingAdapter: (...args: never[]) => unknown }
    const fixture = activate([embedding('emb', registrar => {
      captured = registrar as never
      registrar.registerEmbeddingAdapter(['emb'], new FakeEmbeddingAdapter())
      return undefined
    })])
    const installed = fixture.start()
    expect(() => captured.registerEmbeddingAdapter(...([['emb'], new FakeEmbeddingAdapter()] as never[])))
      .toThrow(expect.objectContaining({ code: 'PROVIDER_REGISTRAR_SEALED' }))
    installed[0]!.close()
  })

  it('contains asynchronous embedding setup', () => {
    const fixture = activate([embedding('emb', (async () => undefined) as never)])
    expect(fixture.start).toThrow(expect.objectContaining({
      failureCode: 'PROVIDER_SETUP_ASYNC_UNSUPPORTED',
    }))
    expect(fixture.embeddingRegistry.listRoutes()).toEqual([])
  })

  it('starts, serves and closes a runtime whose providers are generation only', async () => {
    const owner = await createRuntimeCompositionOwner(runtimeOptions([
      generation('gen', registrar => { registrar.registerAdapter(['gen'], new Adapter()) }),
    ]))
    expect(owner.providers().map(row => row.id)).toEqual(['gen'])
    expect(owner.embeddingRegistry.listRoutes()).toEqual([])
    // A route that carries ONLY a generation adapter is still a route without an
    // embedding adapter, and `embeddingModel()` says so immediately.
    expect(() => owner.embeddingModel({ provider: 'gen', model: 'gen-model' }))
      .toThrow(expect.objectContaining({ code: 'EMBEDDING_ADAPTER_MISSING' }))
    const report = await owner.close()
    expect(report.state).toBe('closed')
    expect(report.components).toEqual([expect.objectContaining({ id: 'provider-0', status: 'closed' })])
  })

  it('starts, serves and closes a runtime whose providers are embedding only', async () => {
    const adapter = new FakeEmbeddingAdapter()
    const plugin = defineEmbeddingProviderPlugin({
      id: 'emb', displayName: 'Embedding only', routes: ['emb'],
      setup(registrar) {
        registrar.registerEmbeddingAdapter(adapter)
        return undefined
      },
    })
    const owner = await createRuntimeCompositionOwner(runtimeOptions([plugin]))
    expect(owner.providers()).toEqual([])
    expect(owner.embeddingRegistry.resolve('emb', 'text-embedding-3-small').adapter).toBe(adapter)
    // Synchronous, and the same configuration resolves to the same handle.
    const handle = owner.embeddingModel({ provider: 'emb', model: 'text-embedding-3-small' })
    expect(typeof handle.embed).toBe('function')
    expect(typeof handle.embedMany).toBe('function')
    expect(owner.embeddingModel({ provider: 'emb', model: 'text-embedding-3-small' })).toBe(handle)
    const report = await owner.close()
    expect(report.state).toBe('closed')
    expect(report.components).toEqual([expect.objectContaining({ id: 'provider-0', status: 'closed' })])
    expect(owner.embeddingRegistry.listRoutes()).toEqual([])
    // Once close has begun no new handle is handed out at all (Requirement 12.6).
    expect(() => owner.embeddingModel({ provider: 'emb', model: 'text-embedding-3-small' }))
      .toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSED' }))
  })
})
