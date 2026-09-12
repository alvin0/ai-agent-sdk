/**
 * Public runtime surface of `Embedding_Runtime`, declared as TYPES ONLY.
 *
 * `AgentRuntime.embeddingModel()` lives at the root entry point, so its option
 * and handle shapes must be nameable without importing anything from
 * `composition/`. Nothing in this file has a value-level dependency: it is a
 * pure declaration boundary, which is what keeps the one-way dependency of
 * Requirements 1.6 and 19.6 true by construction.
 *
 * Ownership note on the cache option (DD-8): `EmbeddingCacheOptions` reads most
 * naturally next to `embeddingCacheKey()` in `composition/embedding/cache.ts`,
 * but `EmbeddingModelOptions.cache` needs the type here — and `embedding/`
 * importing `composition/` is the exact reversed dependency the design forbids.
 * So the option shape is declared here, and the cache implementation in
 * `composition/embedding/cache.ts` CONSUMES it rather than redeclaring it.
 * `scope` is REQUIRED with no default: there is no safe default answer to
 * "may two tenants share a cache entry".
 *
 * `batchLimits` takes its element type from `embedding/limits.ts` for the same
 * reason — batch bounds are contract data, not a composition detail (DD-12).
 *
 * @module ai-agent-sdk/core/embedding/handle
 */

import type { ResolvedEmbeddingBatchLimits } from './limits.ts'
import type { EmbeddingSpaceId } from './profile.ts'
import type { EmbeddingPurpose } from './purpose.ts'
import type { EmbeddingContentPart, EmbeddingTruncation } from './request.ts'
import type { EmbeddingManyResult, EmbeddingResult } from './result.ts'

/** One cached vector, stored with the space identity it was produced in. */
export interface EmbeddingCacheEntry {
  readonly values: readonly number[]
  /**
   * `Space_Id` at the time of writing. A read whose space does not match the
   * current `PreparedEmbeddingCall` is discarded rather than trusted.
   */
  readonly space: EmbeddingSpaceId
}

/**
 * Caller-supplied cache backing. Sync or async implementations are both
 * accepted so an in-process `Map` needs no promise ceremony.
 */
export interface EmbeddingCacheStore {
  get(key: string): Promise<EmbeddingCacheEntry | undefined> | EmbeddingCacheEntry | undefined
  set(key: string, entry: EmbeddingCacheEntry): Promise<void> | void
}

/** Opt-in embedding cache. Disabled unless supplied. */
export interface EmbeddingCacheOptions {
  readonly store: EmbeddingCacheStore
  /**
   * REQUIRED security scope, no default (DD-8). It is the first component of
   * every cache key, so a missing scope is a configuration error rather than
   * something the runtime silently fills in.
   */
  readonly scope: string
}

/** Configuration of one `EmbeddingModelHandle`. */
export interface EmbeddingModelOptions {
  /** Provider route key that must own an `Embedding_Adapter`. */
  readonly provider: string
  readonly model: string
  /** Requested dimensions; absent means the model default. */
  readonly dimensions?: number
  /** SDK default is `'reject'`, even where the provider default is to cut. */
  readonly truncation?: EmbeddingTruncation
  /** Expected `Space_Id`; an incompatible resolution rejects the call. */
  readonly expectedSpace?: EmbeddingSpaceId
  /** Upper bound on in-flight `Physical_Batch`es of one `Logical_Call`. */
  readonly concurrency?: number
  readonly batchLimits?: Partial<ResolvedEmbeddingBatchLimits>
  readonly cache?: EmbeddingCacheOptions
}

/** Input of {@link EmbeddingModelHandle.embed}: exactly one object to embed. */
export interface EmbedOneInput {
  readonly value: string | readonly EmbeddingContentPart[]
  readonly purpose: EmbeddingPurpose
  readonly signal?: AbortSignal
  readonly expectedSpace?: EmbeddingSpaceId
}

/** Input of {@link EmbeddingModelHandle.embedMany}; output follows this order. */
export interface EmbedManyInput {
  readonly values: readonly (string | readonly EmbeddingContentPart[])[]
  readonly purpose: EmbeddingPurpose
  readonly signal?: AbortSignal
  readonly expectedSpace?: EmbeddingSpaceId
}

/**
 * What `runtime.embeddingModel()` hands back.
 *
 * Both methods are one `Logical_Call` each: batching, retry, concurrency and
 * order restoration happen behind them and are never the caller's concern.
 */
export interface EmbeddingModelHandle {
  embed(input: EmbedOneInput): Promise<EmbeddingResult>
  embedMany(input: EmbedManyInput): Promise<EmbeddingManyResult>
}
