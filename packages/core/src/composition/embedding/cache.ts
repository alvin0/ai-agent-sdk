/**
 * The optional `Embedding_Cache`: key derivation plus the two gates a read must
 * pass before its vector is reused.
 *
 * DISABLED BY DEFAULT (Requirement 5.1). Nothing here runs unless the caller
 * supplies `EmbeddingModelOptions.cache`, which is what keeps `crypto.subtle`
 * off every mandatory code path of `packages/core` (DD-11).
 *
 * `EmbeddingCacheOptions`, `EmbeddingCacheStore` and `EmbeddingCacheEntry` are
 * declared in `embedding/handle.ts` because `EmbeddingModelOptions.cache` needs
 * them and `embedding/` may not import `composition/` (DD-8). This module
 * CONSUMES those types and redeclares none of them; the only new type here is
 * {@link EmbeddingCacheKeyInput}, which is an input of this module alone.
 *
 * @module ai-agent-sdk/core/composition/embedding/cache
 */

import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type {
  EmbeddingCacheEntry,
  EmbeddingCacheOptions,
} from '../../embedding/handle.ts'
import type { EmbeddingProfile, EmbeddingSpaceId } from '../../embedding/profile.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import type { EmbeddingContentPart } from '../../embedding/request.ts'

/** Version prefix of the canonical pre-image, so key format changes never collide. */
const CACHE_KEY_VERSION = 'embcache:1'

/** Everything a cache key depends on, for exactly one item of one call. */
export interface EmbeddingCacheKeyInput {
  /** REQUIRED security scope from {@link EmbeddingCacheOptions.scope}. */
  readonly scope: string
  /** Resolved profile of the `Prepared_Embedding_Call`. */
  readonly profile: EmbeddingProfile
  /** Purpose of this call; it selects which recipe revision enters the key. */
  readonly purpose: EmbeddingPurpose
  /**
   * The EFFECTIVE input, i.e. the content parts as the adapter normalized them.
   * Hashing anything earlier would key on text the provider never saw.
   */
  readonly contentParts: readonly EmbeddingContentPart[]
}

/** Escapes `|` and `\` so two distinct component tuples cannot join to one string. */
function escapeComponent(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/** Lowercase hex of a SHA-256 digest over the UTF-8 bytes of `value`. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  let hex = ''
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Validates the cache configuration and reports whether the cache is on.
 *
 * `scope` is REQUIRED with no default: there is no safe default answer to "may
 * two tenants share a cache entry", so a missing or empty scope is
 * `EMBEDDING_CONFIGURATION_INVALID` rather than something the runtime fills in
 * (DD-8, Requirement 5.2). Absent options mean the cache is simply off, which is
 * not an error (Requirement 5.1).
 *
 * @throws {EmbeddingError} `EMBEDDING_CONFIGURATION_INVALID` when a cache is
 * supplied without a usable `store` or without a non-empty `scope`.
 */
export function resolveEmbeddingCache(
  options: EmbeddingCacheOptions | undefined,
): EmbeddingCacheOptions | undefined {
  if (options === undefined) return undefined

  if (typeof options.scope !== 'string' || options.scope.length === 0) {
    throw new EmbeddingError(
      'Embedding cache requires a non-empty `scope`; there is no default security scope',
      EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
    )
  }
  if (
    options.store === null
    || typeof options.store !== 'object'
    || typeof options.store.get !== 'function'
    || typeof options.store.set !== 'function'
  ) {
    throw new EmbeddingError(
      'Embedding cache requires a `store` exposing `get` and `set`',
      EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
    )
  }
  return options
}

/**
 * Derives the cache key of one input from the five components of Requirement 5.2:
 *
 * 1. security scope,
 * 2. model identity + model revision + profile revision,
 * 3. purpose + the recipe revision that purpose selects,
 * 4. dimensions + post-processing (kind and revision),
 * 5. the digest of the effective input content.
 *
 * ASYNC on purpose, and the ONLY digest in this design. A cache key must
 * compress an unbounded amount of input content into a fixed-length string, so a
 * hash is required. `deriveSpaceId` is the opposite case: it joins a finite set
 * of short metadata fields, so it stays synchronous and unhashed (DD-11).
 *
 * Changing any one of the five components yields a different key; keeping all
 * five yields an equal key.
 */
export async function embeddingCacheKey(input: EmbeddingCacheKeyInput): Promise<string> {
  const { profile } = input
  const recipeRevision =
    input.purpose === 'retrieval-query'
      ? profile.queryRecipeRevision
      : profile.documentRecipeRevision
  const postProcessing =
    profile.postProcessing === undefined
      ? 'none'
      : `${profile.postProcessing.kind}:${profile.postProcessing.revision}`

  // The effective input is hashed FIRST and separately: it is the only unbounded
  // component, and pre-hashing it keeps the outer pre-image a fixed size.
  const contentDigest = await sha256Hex(
    input.contentParts.map(part => `${part.type}:${escapeComponent(part.text)}`).join('|'),
  )

  const components = [
    CACHE_KEY_VERSION,
    input.scope,
    `${profile.modelIdentity}#${profile.modelRevision ?? 'none'}#${profile.profileRevision}`,
    `${input.purpose}#${recipeRevision}`,
    `${String(profile.dimensions)}#${postProcessing}`,
    contentDigest,
  ]

  return sha256Hex(components.map(escapeComponent).join('|'))
}

/**
 * Reads one entry and applies the SECOND gate: an entry whose `Space_Id` differs
 * from the prepared call's `Space_Id` is ignored, so the item falls through to a
 * new `Physical_Batch` (Requirement 5.3).
 *
 * This defends against a key collision caused by a configuration change that was
 * never reflected in `profileRevision`. A store fault is also treated as a miss:
 * a cache is an optimisation and must not be able to fail a call.
 */
export async function readEmbeddingCacheEntry(
  cache: EmbeddingCacheOptions,
  key: string,
  space: EmbeddingSpaceId,
  dimensions?: number,
): Promise<EmbeddingCacheEntry | undefined> {
  try {
    const entry = await cache.store.get(key)
    if (entry === null || typeof entry !== 'object' || entry.space !== space) return undefined
    const values = entry.values
    if (!Array.isArray(values) || values.length === 0
      || (dimensions !== undefined && dimensions > 0 && values.length !== dimensions)) return undefined
    const snapshot: number[] = []
    for (const value of values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      snapshot.push(value)
    }
    return Object.freeze({ space, values: Object.freeze(snapshot) })
  } catch {
    return undefined
  }
}

/**
 * Writes one vector together with the space it was produced in, so the second
 * gate has something to check on the way back out.
 *
 * A store fault is swallowed for the same reason as on read: a cache write must
 * not turn a successful embedding call into a failure.
 */
export async function writeEmbeddingCacheEntry(
  cache: EmbeddingCacheOptions,
  key: string,
  entry: EmbeddingCacheEntry,
): Promise<void> {
  try {
    await cache.store.set(key, Object.freeze({ space: entry.space, values: Object.freeze([...entry.values]) }))
  } catch {
    // Intentionally ignored: the vector is already computed and returned.
  }
}
