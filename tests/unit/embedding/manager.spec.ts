/**
 * Unit tests for `RuntimeEmbedding`, the runtime-owned manager behind
 * `runtime.embeddingModel()`.
 *
 * **Validates: Requirements 3.1, 3.4, 3.5, 12.6**
 *
 * The manager is a small object with three claims worth defending, and each one
 * is tested against observable behaviour rather than against its own internals:
 *
 * 1. **Synchronous handout, nothing else constructed.** `model()` returns a
 *    usable handle without awaiting anything and without touching an agent, team
 *    or session. The test asserts the returned value is a handle whose `embed()`
 *    reaches the fake adapter, and that admission was checked FIRST — a closing
 *    runtime is rejected even when the options object is unusable garbage, which
 *    is only possible if `assertActive()` runs before options are read.
 * 2. **The per-runtime handle cache is keyed by the whole configuration.** Equal
 *    configuration reuses one handle; any difference — dimensions, a second cache
 *    store with the SAME scope, a fallback group — produces a different one. The
 *    dangerous direction is a wrong hit, so the differing-configuration cases
 *    carry the weight here.
 * 3. **A cached handle never outlives its topology.** A handle closes over the
 *    adapter the registry resolved. Registering, replacing or disposing a
 *    registration must drop the cache, which is asserted by observing that the
 *    handle handed out after a topology change dispatches into the NEW adapter.
 *
 * Real `RuntimeOperations` and a real `EmbeddingRegistry` are used rather than
 * stubs: admission and topology notification are precisely what is under test, so
 * faking either would test the fake.
 *
 * PLACEMENT NOTE. This sits beside `tests/unit/embedding/{planner,order,usage}.spec.ts`
 * for the same reason those files document: the root `vitest.config.ts` collects
 * `tests/**`, and no runner collects `packages/*&#47;tests/`.
 *
 * @module tests/unit/embedding/manager.spec
 */

import { describe, expect, it } from 'vitest'
import { RuntimeEmbedding } from '../../../packages/core/src/composition/embedding/manager.ts'
import { EmbeddingRegistry } from '../../../packages/core/src/composition/embedding/registry.ts'
import type { EmbeddingHandleOptions } from '../../../packages/core/src/composition/embedding/handle.ts'
import { RuntimeOperations } from '../../../packages/core/src/composition/lifecycle/operations.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingCacheEntry,
  EmbeddingCacheStore,
} from '../../../packages/core/src/embedding/handle.ts'
import type { EmbeddingSpaceId } from '../../../packages/core/src/embedding/profile.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { AgentSdkError } from '../../../packages/core/src/errors/agent-sdk-error.ts'
import { FakeEmbeddingAdapter } from '../../fixtures/embedding/fake-adapter.ts'

const ROUTE = 'openai'
const MODEL = 'text-embedding-3-small'

/** A registry with one route served by one fake adapter, plus the live pieces. */
function fixture(options: { readonly maxCachedHandles?: number } = {}) {
  const registry = new EmbeddingRegistry()
  const adapter = new FakeEmbeddingAdapter()
  const registration = registry.registerEmbeddingAdapter([ROUTE], adapter)
  const resources = new RuntimeResources(createRuntimePlatform(globalThis))
  const operations = new RuntimeOperations(resources)
  const manager = new RuntimeEmbedding({
    registry,
    operations,
    ...(options.maxCachedHandles === undefined
      ? {}
      : { options: { maxCachedHandles: options.maxCachedHandles } }),
  })
  return { adapter, manager, operations, registration, registry, resources }
}

function baseOptions(overrides: Partial<EmbeddingHandleOptions> = {}): EmbeddingHandleOptions {
  return { provider: ROUTE, model: MODEL, ...overrides }
}

/** A minimal in-memory store; two instances are two DIFFERENT caches. */
function memoryStore(): EmbeddingCacheStore {
  const entries = new Map<string, EmbeddingCacheEntry>()
  return {
    get: (key: string) => Promise.resolve(entries.get(key)),
    set: (key: string, entry: EmbeddingCacheEntry) => {
      entries.set(key, entry)
      return Promise.resolve()
    },
  }
}

describe('RuntimeEmbedding hands out handles synchronously', () => {
  it('returns a working handle without constructing an agent, team or session', async () => {
    const { adapter, manager } = fixture()

    const handle = manager.model(baseOptions({ dimensions: 8 }))
    expect(typeof handle.embed).toBe('function')
    expect(typeof handle.embedMany).toBe('function')
    // Nothing was dispatched by handing the handle out; only `embed()` dispatches.
    expect(adapter.attempts).toHaveLength(0)

    const result = await handle.embed({ value: 'xin chào', purpose: 'retrieval-document' })
    expect(result.embedding).toHaveLength(8)
    expect(typeof result.space).toBe('string')
    expect(adapter.attempts).toHaveLength(1)
  })

  it('rejects a closing runtime before it reads the options at all', () => {
    const { manager, operations } = fixture()
    void operations.beginClose({ timeoutMs: 50 })

    // Unusable options on purpose: only an admission check that runs FIRST can
    // produce a lifecycle code here instead of a configuration one.
    let captured: unknown
    try {
      manager.model(undefined)
    } catch (error) {
      captured = error
    }
    expect(captured).toBeInstanceOf(AgentSdkError)
    expect((captured as AgentSdkError).code).toBe('RUNTIME_CLOSING')
  })

  it('fails with EMBEDDING_ADAPTER_MISSING for a route no embedding adapter claims', () => {
    const { manager } = fixture()
    try {
      manager.model(baseOptions({ provider: 'gemini' }))
      expect.unreachable('an unclaimed route must not resolve')
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingError)
      expect((error as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.ADAPTER_MISSING)
    }
  })

  it('rejects an unusable options object as a configuration error', () => {
    const { manager } = fixture()
    for (const invalid of [undefined, null, 'openai', { provider: ROUTE }, { provider: '', model: MODEL }]) {
      try {
        manager.model(invalid)
        expect.unreachable('unusable options must not produce a handle')
      } catch (error) {
        expect(error).toBeInstanceOf(EmbeddingError)
        expect((error as EmbeddingError).code).toBe(EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
      }
    }
  })
})

describe('RuntimeEmbedding caches handles per runtime', () => {
  it('reuses one handle for an equal configuration', () => {
    const { manager } = fixture()
    const first = manager.model(baseOptions({ dimensions: 8, truncation: 'allow' }))
    const second = manager.model(baseOptions({ dimensions: 8, truncation: 'allow' }))
    expect(second).toBe(first)
    expect(manager.cachedHandleCount).toBe(1)
  })

  it('never shares a handle across configurations that differ', () => {
    const { manager } = fixture()
    const storeA = memoryStore()
    const storeB = memoryStore()
    const variants: readonly EmbeddingHandleOptions[] = [
      baseOptions(),
      baseOptions({ dimensions: 8 }),
      baseOptions({ dimensions: 16 }),
      baseOptions({ truncation: 'allow' }),
      baseOptions({ concurrency: 2 }),
      baseOptions({ expectedSpace: 'space-1' as EmbeddingSpaceId }),
      baseOptions({ batchLimits: { maxItems: 3 } }),
      // Same scope, different store: still two different caches.
      baseOptions({ cache: { scope: 'tenant-a', store: storeA } }),
      baseOptions({ cache: { scope: 'tenant-a', store: storeB } }),
      baseOptions({ cache: { scope: 'tenant-b', store: storeA } }),
      baseOptions({ model: 'text-embedding-3-large' }),
      baseOptions({
        compatibilityIdentity: 'group-1',
        fallback: [{ model: 'alt', compatibilityIdentity: 'group-1' }],
      }),
    ]
    const handles = variants.map(options => manager.model(options))
    expect(new Set(handles).size).toBe(variants.length)
  })

  it('snapshots the options, so a later caller mutation cannot change the handle', async () => {
    const { adapter, manager } = fixture()
    const mutable = { provider: ROUTE, model: MODEL, dimensions: 8 }
    const handle = manager.model(mutable)

    mutable.dimensions = 16
    await handle.embed({ value: 'tài liệu', purpose: 'retrieval-document' })

    expect(adapter.attempts[0]?.batch.dimensions).toBe(8)
  })

  it('honours the cache bound and evicts the least recently used handle', () => {
    const { manager } = fixture({ maxCachedHandles: 2 })
    const first = manager.model(baseOptions({ dimensions: 1 }))
    const second = manager.model(baseOptions({ dimensions: 2 }))
    // Touch `first` so `second` becomes the eviction candidate.
    expect(manager.model(baseOptions({ dimensions: 1 }))).toBe(first)
    manager.model(baseOptions({ dimensions: 3 }))

    expect(manager.cachedHandleCount).toBe(2)
    expect(manager.model(baseOptions({ dimensions: 1 }))).toBe(first)
    expect(manager.model(baseOptions({ dimensions: 2 }))).not.toBe(second)
  })

  it('caches nothing when the bound is zero', () => {
    const { manager } = fixture({ maxCachedHandles: 0 })
    const first = manager.model(baseOptions())
    expect(manager.model(baseOptions())).not.toBe(first)
    expect(manager.cachedHandleCount).toBe(0)
  })

  it('rejects an unusable cache bound', () => {
    const { operations, registry } = fixture()
    expect(() => new RuntimeEmbedding({
      registry, operations, options: { maxCachedHandles: -1 },
    })).toThrow(EmbeddingError)
  })
})

describe('RuntimeEmbedding drops cached handles when the topology changes', () => {
  it('hands out a handle bound to the adapter registered most recently', async () => {
    const { adapter, manager, registration, registry } = fixture()
    const first = manager.model(baseOptions())
    await first.embed({ value: 'một', purpose: 'retrieval-document' })
    expect(adapter.attempts).toHaveLength(1)

    // Replace the route's registration with a second adapter.
    registration()
    const replacement = new FakeEmbeddingAdapter()
    registry.registerEmbeddingAdapter([ROUTE], replacement)

    const second = manager.model(baseOptions())
    expect(second).not.toBe(first)
    await second.embed({ value: 'hai', purpose: 'retrieval-document' })
    expect(replacement.attempts).toHaveLength(1)
    expect(adapter.attempts).toHaveLength(1)
  })

  it('stops observing the registry after dispose, idempotently', () => {
    const { manager, registry } = fixture()
    manager.model(baseOptions())
    expect(manager.cachedHandleCount).toBe(1)

    manager.dispose()
    manager.dispose()
    expect(manager.cachedHandleCount).toBe(0)

    // The cache still works after dispose; it is simply no longer invalidated.
    const handle = manager.model(baseOptions())
    registry.registerEmbeddingAdapter(['other'], new FakeEmbeddingAdapter())
    expect(manager.model(baseOptions())).toBe(handle)
  })
})
