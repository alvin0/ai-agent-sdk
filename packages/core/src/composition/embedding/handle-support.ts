import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { PreparedEmbeddingCall } from '../../embedding/adapter.ts'
import type { EmbeddingCacheOptions } from '../../embedding/handle.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import type { EmbeddingContentPart, EmbeddingItem, EmbeddingTruncation } from '../../embedding/request.ts'
import type { EmbeddingWarning } from '../../embedding/result.ts'
import { normalizeModelFailure } from '../../errors/failure.ts'
import { MODEL_ERROR_CODES } from '../../errors/model-error.ts'
import type { OperationStatus } from '../../observation/event.ts'
import type { EmbeddingHandleOptions } from './handle-types.ts'
import { embeddingCacheKey, readEmbeddingCacheEntry } from './cache.ts'

interface CachePartitionState {
  readonly purpose: EmbeddingPurpose
  readonly results: (readonly number[] | undefined)[]
  readonly keys: Map<number, string>
}

export function configurationError(message: string): EmbeddingError {
  return new EmbeddingError(message, EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
}

/** Codes that mean the caller or the runtime stopped this, not that it broke. */
const ABORT_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.ABORTED,
  MODEL_ERROR_CODES.ABORTED,
  'RUNTIME_OPERATION_ABORTED',
  'RUNTIME_CLOSING',
  'RUNTIME_CLOSED',
])

/**
 * Terminal status of one failed span.
 *
 * A cancellation is reported as `aborted` rather than `error` so an operator
 * reading a trace can tell a broken provider from a caller that changed its mind
 * — the two have very different follow-ups.
 */
export function terminalStatus(error: unknown): OperationStatus {
  return ABORT_CODES.has(normalizeModelFailure(error).code) ? 'aborted' : 'error'
}

/** A non-empty string, or a configuration failure naming the field. */
export function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`embedding handle requires a non-empty \`${field}\``)
  }
  return value
}

/**
 * Validates a declared fallback group and reduces it to the ONE identity every
 * member must share.
 *
 * Rejecting at construction rather than at failure time is deliberate: a group
 * that spans two embedding spaces is misconfigured whether or not the primary
 * model ever fails, and discovering it only during an incident is the worst
 * possible moment (Requirement 6.7).
 */
export function resolveFallbackIdentity(options: EmbeddingHandleOptions): string | undefined {
  const declared = options.compatibilityIdentity === undefined
    ? undefined
    : requireIdentifier(options.compatibilityIdentity, 'compatibilityIdentity')
  const fallback = options.fallback
  if (fallback === undefined) return declared
  if (!Array.isArray(fallback) || fallback.length === 0) {
    throw configurationError('embedding fallback declaration must be a non-empty array')
  }

  let identity = declared
  for (const entry of fallback) {
    if (entry === null || typeof entry !== 'object') {
      throw configurationError('each embedding fallback entry must declare a model and an identity')
    }
    requireIdentifier(entry.model, 'fallback.model')
    const entryIdentity = requireIdentifier(entry.compatibilityIdentity, 'fallback.compatibilityIdentity')
    if (identity === undefined) identity = entryIdentity
    else if (identity !== entryIdentity) {
      // Two identities in one group means at least one member produces vectors
      // in a different space, so the group is not a fallback group at all.
      throw configurationError(
        'embedding fallback models must all declare the same compatibilityIdentity',
      )
    }
  }
  return identity
}

/** Normalises one caller value into the content parts of a single item. */
function toContentParts(
  value: string | readonly EmbeddingContentPart[],
  index: number,
): readonly EmbeddingContentPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (Array.isArray(value)) {
    const parts: EmbeddingContentPart[] = []
    for (const part of value) {
      if (part === null || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
        throw new EmbeddingError(
          'embedding content parts must have type "text" and a string text value',
          EMBEDDING_ERROR_CODES.REQUEST_INVALID,
          { itemIndexes: [index] },
        )
      }
      parts.push(Object.freeze({ type: 'text', text: part.text }))
    }
    return Object.freeze(parts)
  }
  throw new EmbeddingError(
    'embedding input must be a string or an array of content parts',
    EMBEDDING_ERROR_CODES.REQUEST_INVALID,
    { itemIndexes: [index] },
  )
}

/**
 * Builds the items of one `Logical_Call`.
 *
 * `index` is the caller's position and is the ONLY coordinate that matters
 * downstream: batching, retry and out-of-order settlement all preserve it, and
 * output order is restored from it.
 */
export function toItems(
  values: readonly (string | readonly EmbeddingContentPart[])[],
): readonly EmbeddingItem[] {
  if (!Array.isArray(values)) {
    throw new EmbeddingError(
      'embedding input values must be an array',
      EMBEDDING_ERROR_CODES.REQUEST_INVALID,
    )
  }
  return Array.from(values, (value, index) => ({ index, contentParts: toContentParts(value, index) }))
}

/** The truncation warning of one batch, when the caller allowed truncation. */
export function truncationWarnings(
  truncation: EmbeddingTruncation,
  indexes: readonly number[],
): readonly EmbeddingWarning[] {
  if (truncation !== 'allow' || indexes.length === 0) return []
  return [Object.freeze<EmbeddingWarning>({
    code: 'input-truncated',
    itemIndexes: Object.freeze([...indexes]),
    message: 'provider reported that it truncated the input before embedding it',
  })]
}

export async function partitionByCache(
  active: EmbeddingCacheOptions,
  items: readonly EmbeddingItem[],
  prepared: PreparedEmbeddingCall,
  state: CachePartitionState,
): Promise<readonly EmbeddingItem[]> {
  const misses: EmbeddingItem[] = []
  for (const item of items) {
    const key = await embeddingCacheKey({
      scope: active.scope,
      profile: prepared.profile,
      purpose: state.purpose,
      contentParts: item.contentParts,
    })
    const entry = await readEmbeddingCacheEntry(active, key, prepared.spaceId, prepared.profile.dimensions)
    if (entry === undefined) {
      state.keys.set(item.index, key)
      misses.push(item)
      continue
    }
    state.results[item.index] = entry.values
  }
  return misses
}

