/**
 * `RuntimeEmbedding`: the runtime-owned door between `runtime.embeddingModel()`
 * and one {@link EmbeddingModelHandle}.
 *
 * This manager is the embedding counterpart of `RuntimeModelCatalog`: one
 * instance per runtime, owned by `RuntimeCompositionOwner`, holding the two
 * things that are per-runtime rather than per-call — the {@link EmbeddingRegistry}
 * it resolves through, and a bounded cache of the handles it has already handed
 * out. It deliberately owns nothing else. Batching, concurrency, retry, usage and
 * order restoration all live behind `createEmbeddingModelHandle()`; resolution by
 * route + model lives in the registry.
 *
 * Three properties are the whole point of the module:
 *
 * 1. **Synchronous, and no agent anywhere.** `model()` performs an admission
 *    check, captures the options, resolves an adapter and constructs a handle.
 *    There is no `await`, no session, no agent, no team — a document indexing
 *    service never pays for machinery it does not use (Requirements 3.1, 3.4).
 * 2. **Failures happen at the call that caused them.** A closing runtime, an
 *    unusable options object, and a route with no embedding adapter are all
 *    rejected by `model()` itself rather than at the first `embed()`. A missing
 *    adapter surfaces as the registry's `EMBEDDING_ADAPTER_MISSING`, including
 *    when the route carries only a generation adapter (Requirement 3.5).
 * 3. **The handle cache never outlives the topology it was resolved against.**
 *    A handle closes over the adapter and retry policy that were live when it was
 *    built, so any registration, `replace()` or disposal clears the cache. The
 *    alternative — reusing a handle bound to an adapter that has been torn down —
 *    would keep dispatching into a dead registration.
 *
 * The cache is keyed by the FULL captured configuration, not by route + model:
 * two handles that differ in `dimensions`, `truncation`, `expectedSpace`,
 * concurrency, batch limits, cache scope/store or fallback group are different
 * handles, and collapsing them would silently serve a caller a configuration it
 * did not ask for. Where a configuration cannot be fingerprinted safely, the
 * manager simply does not cache it and builds a fresh handle instead — a cache
 * miss is always correct, a wrong hit never is.
 *
 * @module ai-agent-sdk/core/composition/embedding/manager
 */

import type { EmbeddingCacheOptions, EmbeddingModelHandle } from '../../embedding/handle.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { ResolvedEmbeddingBatchLimits } from '../../embedding/limits.ts'
import type { ObservationResource } from '../../observation/event.ts'
import type { ObservationPort } from '../../observation/port.ts'
import type { ModelInvocationContext } from '../../observation/report.ts'
import {
  createEmbeddingModelHandle,
  type EmbeddingFallbackDeclaration,
  type EmbeddingHandleOptions,
  type EmbeddingOperationScheduler,
} from './handle.ts'
import type { EmbeddingRegistration, EmbeddingRegistry } from './registry.ts'

/** Default upper bound on remembered handles; see {@link RuntimeEmbeddingOptions}. */
const DEFAULT_MAX_CACHED_HANDLES = 64

/**
 * Runtime admission as this manager needs it: the scheduler the handle will use,
 * plus the close-state gate `model()` applies before doing any work.
 *
 * Structural rather than `RuntimeOperations` so a test can drive the manager with
 * a two-method stub, and so nothing here can reach into runtime lifecycle
 * internals it has no business touching.
 */
export interface EmbeddingOperationAdmission extends EmbeddingOperationScheduler {
  /**
   * Throws `RUNTIME_CLOSING` / `RUNTIME_CLOSED` once close has begun
   * (Requirement 12.6).
   */
  assertActive(): void
}

/**
 * The registry surface the manager consumes: resolution, and notification when
 * the embedding topology changed.
 */
export type EmbeddingAdapterResolver = Pick<EmbeddingRegistry, 'resolve' | 'onAdaptersUpdated'>

/** Everything {@link RuntimeEmbedding} needs, all owned by the runtime. */
export interface RuntimeEmbeddingDependencies {
  /** Runtime-owned embedding topology, resolved per route + model id. */
  readonly registry: EmbeddingAdapterResolver
  /** Runtime admission; also supplies the lease each `Logical_Call` runs under. */
  readonly operations: EmbeddingOperationAdmission
  /**
   * Invocation context handed to every handle this manager creates, forwarded
   * untouched to attempt accounting.
   */
  readonly context?: ModelInvocationContext
  /**
   * Runtime observation port, used by a handle whose call carries no context of
   * its own. Without it an embedding call would run correctly but silently, so
   * the runtime forwards its own port here (Requirement 16.1).
   */
  readonly observation?: ObservationPort
  /** Runtime resource identity, paired with {@link observation}. */
  readonly resource?: ObservationResource
  readonly options?: RuntimeEmbeddingOptions
}

/** Tuning of the manager itself; every field has a usable default. */
export interface RuntimeEmbeddingOptions {
  /**
   * Upper bound on remembered handles, evicting least recently used first.
   *
   * Bounded because the key includes caller-supplied strings: an application
   * that varies `expectedSpace` or a cache scope per tenant would otherwise grow
   * this map without limit for the lifetime of the runtime. `0` disables caching.
   */
  readonly maxCachedHandles?: number
}

function configurationError(message: string): EmbeddingError {
  return new EmbeddingError(message, EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
}

/** A non-empty string, or a configuration failure naming the field. */
function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`\`embeddingModel()\` requires a non-empty \`${field}\``)
  }
  return value
}

/**
 * Copies the caller's options into a frozen snapshot of its own.
 *
 * Two reasons this is a copy and not a pass-through. A remembered handle would
 * otherwise share a mutable object with the caller, so a later mutation would
 * change the configuration of a handle that was already validated. And `model()`
 * is the earliest point at which route identity can be checked at all, which is
 * where Requirement 3.1's "fails at the call that made it" comes from.
 *
 * Everything beyond route identity is left to the owners that already validate
 * it: `resolveEmbeddingConcurrency()`, `resolveEmbeddingCache()` and the fallback
 * group check, all reached through `createEmbeddingModelHandle()`.
 */
function captureHandleOptions(value: unknown): EmbeddingHandleOptions {
  if (value === null || typeof value !== 'object') {
    throw configurationError('`embeddingModel()` requires an options object')
  }
  const source = value as Partial<EmbeddingHandleOptions>
  const fallback = source.fallback
  return Object.freeze<EmbeddingHandleOptions>({
    provider: requiredIdentifier(source.provider, 'provider'),
    model: requiredIdentifier(source.model, 'model'),
    ...(source.dimensions === undefined ? {} : { dimensions: source.dimensions }),
    ...(source.truncation === undefined ? {} : { truncation: source.truncation }),
    ...(source.expectedSpace === undefined ? {} : { expectedSpace: source.expectedSpace }),
    ...(source.concurrency === undefined ? {} : { concurrency: source.concurrency }),
    ...(source.batchLimits === undefined
      ? {}
      : { batchLimits: capturedBatchLimits(source.batchLimits) }),
    ...(source.cache === undefined ? {} : { cache: capturedCache(source.cache) }),
    ...(source.compatibilityIdentity === undefined
      ? {}
      : { compatibilityIdentity: requiredIdentifier(source.compatibilityIdentity, 'compatibilityIdentity') }),
    ...(fallback === undefined ? {} : { fallback: capturedFallback(fallback) }),
  })
}

/** Shallow frozen copy; value validation belongs to `resolveBatchLimits()`. */
function capturedBatchLimits(
  value: Partial<ResolvedEmbeddingBatchLimits>,
): Partial<ResolvedEmbeddingBatchLimits> {
  if (value === null || typeof value !== 'object') {
    throw configurationError('`batchLimits` must be an object when it is provided')
  }
  return Object.freeze({ ...value })
}

/**
 * Shallow frozen copy. The `store` reference is kept as given — it is the
 * caller's live cache, not data to clone — while `scope` is validated by
 * `resolveEmbeddingCache()`.
 */
function capturedCache(value: EmbeddingCacheOptions): EmbeddingCacheOptions {
  if (value === null || typeof value !== 'object') {
    throw configurationError('`cache` must be an object when it is provided')
  }
  return Object.freeze({ ...value })
}

/**
 * Frozen copy of a declared fallback group.
 *
 * Only the shape needed to make the copy is checked here; whether the group is a
 * legitimate one — every member declaring the SAME `compatibilityIdentity` — is
 * the handle's decision, so that exactly one place answers Requirement 6.7.
 */
function capturedFallback(
  value: readonly EmbeddingFallbackDeclaration[],
): readonly EmbeddingFallbackDeclaration[] {
  if (!Array.isArray(value)) {
    throw configurationError('`fallback` must be an array when it is provided')
  }
  return Object.freeze(value.map(entry => {
    if (entry === null || typeof entry !== 'object') {
      throw configurationError('each `fallback` entry must be an object')
    }
    return Object.freeze({ ...entry })
  }))
}

/**
 * Runtime-owned factory and cache of {@link EmbeddingModelHandle}s.
 *
 * Construct one per runtime, beside the {@link EmbeddingRegistry} it resolves
 * through. Present even when a runtime carries zero embedding plugins: an empty
 * registry resolves nothing and `model()` fails with `EMBEDDING_ADAPTER_MISSING`,
 * which is a far better answer than a missing manager (Requirement 11.8).
 */
export class RuntimeEmbedding {
  private readonly registry: EmbeddingAdapterResolver
  private readonly operations: EmbeddingOperationAdmission
  private readonly context: ModelInvocationContext | undefined
  private readonly observation: ObservationPort | undefined
  private readonly resource: ObservationResource | undefined
  private readonly maxCachedHandles: number
  /** Insertion-ordered, re-inserted on hit, so the first key is the LRU one. */
  private readonly handles = new Map<string, EmbeddingModelHandle>()
  /** Identity of caller-supplied cache stores, so two stores never share a key. */
  private readonly storeIds = new WeakMap<object, string>()
  private storeSequence = 0
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(dependencies: RuntimeEmbeddingDependencies) {
    this.registry = dependencies.registry
    this.operations = dependencies.operations
    this.context = dependencies.context
    this.observation = dependencies.observation
    this.resource = dependencies.resource
    this.maxCachedHandles = resolveMaxCachedHandles(dependencies.options?.maxCachedHandles)
    // A remembered handle closes over one adapter and one retry policy. The
    // moment the topology changes, every one of them is potentially stale.
    this.unsubscribe = this.registry.onAdaptersUpdated(() => this.handles.clear())
  }

  /**
   * Resolve one route + model into a handle, synchronously.
   *
   * @param optionsValue - the caller's {@link EmbeddingHandleOptions}; validated here.
   * @returns a handle bound to the adapter and retry policy live at this moment.
   * @throws {import('../../errors/agent-sdk-error.ts').AgentSdkError} `RUNTIME_CLOSING`
   *   / `RUNTIME_CLOSED` when the runtime is no longer admitting work.
   * @throws {EmbeddingError} `EMBEDDING_CONFIGURATION_INVALID` for an unusable
   *   options object, or `EMBEDDING_ADAPTER_MISSING` when no embedding adapter
   *   claims the route + model pair.
   */
  model(optionsValue: unknown): EmbeddingModelHandle {
    // FIRST, before any option is read: a closing runtime must not hand out a
    // handle at all, not even one that would fail later (Requirement 12.6).
    this.operations.assertActive()
    const options = captureHandleOptions(optionsValue)
    const key = this.cacheKey(options)
    if (key !== undefined) {
      const cached = this.handles.get(key)
      if (cached !== undefined) {
        // Re-insert to mark it most recently used.
        this.handles.delete(key)
        this.handles.set(key, cached)
        return cached
      }
    }

    const registration: EmbeddingRegistration = this.registry.resolve(options.provider, options.model)
    const handle = createEmbeddingModelHandle({
      operations: this.operations,
      adapter: registration.adapter,
      options,
      // Captured at REGISTRATION time by the registry; absent means the SDK
      // defaults apply, which is not the same as "no retry".
      ...(registration.retryPolicy === undefined ? {} : { retryPolicy: registration.retryPolicy }),
      ...(this.context === undefined ? {} : { context: this.context }),
      ...(this.observation === undefined ? {} : { observation: this.observation }),
      ...(this.resource === undefined ? {} : { resource: this.resource }),
    })
    if (key !== undefined) this.remember(key, handle)
    return handle
  }

  /** Remembered handle count; exists for tests and diagnostics, not for callers. */
  get cachedHandleCount(): number { return this.handles.size }

  /**
   * Release the topology subscription and drop every remembered handle.
   *
   * Idempotent, and safe to call while handles are still in flight: a handle owns
   * its own lease, so dropping the manager's reference cancels nothing.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.handles.clear()
  }

  /** Insert under the bound, evicting the least recently used key first. */
  private remember(key: string, handle: EmbeddingModelHandle): void {
    this.handles.set(key, handle)
    while (this.handles.size > this.maxCachedHandles) {
      const oldest = this.handles.keys().next()
      if (oldest.done === true) break
      this.handles.delete(oldest.value)
    }
  }

  /**
   * The full configuration as one string, or `undefined` when this configuration
   * must not be cached.
   *
   * `JSON.stringify` over a FIXED-LENGTH array is what makes this safe: component
   * order is positional rather than derived from key iteration, and string
   * escaping is the serializer's problem, so no two distinct configurations can
   * join into the same key.
   *
   * A component of an unexpected type yields `undefined` rather than a coerced
   * key. Such a configuration is on its way to being rejected by the handle
   * anyway, and guessing a key for it is the one thing that could produce a wrong
   * hit later.
   */
  private cacheKey(options: EmbeddingHandleOptions): string | undefined {
    if (this.maxCachedHandles === 0) return undefined
    const cache = this.cacheComponent(options.cache)
    if (cache === undefined) return undefined
    const limits = this.limitsComponent(options.batchLimits)
    if (limits === undefined) return undefined
    const fallback = this.fallbackComponent(options.fallback)
    if (fallback === undefined) return undefined
    if (!isOptionalPrimitive(options.dimensions, 'number')) return undefined
    if (!isOptionalPrimitive(options.truncation, 'string')) return undefined
    if (!isOptionalPrimitive(options.expectedSpace, 'string')) return undefined
    if (!isOptionalPrimitive(options.concurrency, 'number')) return undefined

    return JSON.stringify([
      options.provider,
      options.model,
      options.dimensions ?? null,
      options.truncation ?? null,
      options.expectedSpace ?? null,
      options.concurrency ?? null,
      limits,
      cache,
      options.compatibilityIdentity ?? null,
      fallback,
    ])
  }

  /**
   * Batch limits as a positionally fixed tuple.
   *
   * `estimateTokens` is a function, so it is identified by reference the same way
   * a cache store is: two callers passing different estimators must not share a
   * handle whose batching would then use the wrong one.
   */
  private limitsComponent(
    limits: Partial<ResolvedEmbeddingBatchLimits> | undefined,
  ): readonly unknown[] | null | undefined {
    if (limits === undefined) return null
    if (!isOptionalPrimitive(limits.maxItems, 'number')) return undefined
    if (!isOptionalPrimitive(limits.maxTokens, 'number')) return undefined
    if (!isOptionalPrimitive(limits.maxBytes, 'number')) return undefined
    const estimate = limits.estimateTokens
    if (estimate !== undefined && typeof estimate !== 'function') return undefined
    return [
      limits.maxItems ?? null,
      limits.maxTokens ?? null,
      limits.maxBytes ?? null,
      estimate === undefined ? null : this.referenceId(estimate),
    ]
  }

  /**
   * Cache configuration as `[scope, storeReferenceId]`.
   *
   * The store enters the key by REFERENCE, never by shape: two stores with an
   * identical scope are still two different caches, and reusing a handle across
   * them would write vectors into a store the caller did not name.
   */
  private cacheComponent(
    cache: EmbeddingCacheOptions | undefined,
  ): readonly unknown[] | null | undefined {
    if (cache === undefined) return null
    if (typeof cache.scope !== 'string') return undefined
    const store: unknown = cache.store
    if (store === null || (typeof store !== 'object' && typeof store !== 'function')) return undefined
    return [cache.scope, this.referenceId(store as object)]
  }

  /** Fallback group as a tuple per member, in declaration order. */
  private fallbackComponent(
    fallback: readonly EmbeddingFallbackDeclaration[] | undefined,
  ): readonly unknown[] | null | undefined {
    if (fallback === undefined) return null
    const rows: unknown[] = []
    for (const entry of fallback) {
      if (typeof entry.model !== 'string' || typeof entry.compatibilityIdentity !== 'string') {
        return undefined
      }
      rows.push([entry.model, entry.compatibilityIdentity])
    }
    return rows
  }

  /**
   * A stable per-manager id for one object reference.
   *
   * Held in a `WeakMap`, so remembering that a store was seen never keeps it
   * alive: the id disappears with the object it named.
   */
  private referenceId(value: object): string {
    const existing = this.storeIds.get(value)
    if (existing !== undefined) return existing
    const id = `ref-${++this.storeSequence}`
    this.storeIds.set(value, id)
    return id
  }
}

/** `undefined` takes the default; anything unusable is a configuration error. */
function resolveMaxCachedHandles(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_MAX_CACHED_HANDLES
  if (!Number.isInteger(configured) || configured < 0) {
    throw configurationError('`maxCachedHandles` must be a non-negative integer')
  }
  return configured
}

/** Absent, or present with exactly the expected primitive type. */
function isOptionalPrimitive(value: unknown, expected: 'number' | 'string'): boolean {
  return value === undefined || typeof value === expected
}
