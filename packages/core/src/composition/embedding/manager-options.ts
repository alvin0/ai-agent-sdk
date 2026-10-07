import type { EmbeddingCacheOptions } from '../../embedding/handle.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { ResolvedEmbeddingBatchLimits } from '../../embedding/limits.ts'
import type { EmbeddingFallbackDeclaration, EmbeddingHandleOptions } from './handle.ts'

export function embeddingConfigurationError(message: string): EmbeddingError {
  return new EmbeddingError(message, EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
}

/** A non-empty string, or a configuration failure naming the field. */
function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw embeddingConfigurationError(`\`embeddingModel()\` requires a non-empty \`${field}\``)
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
export function captureHandleOptions(value: unknown): EmbeddingHandleOptions {
  const source = optionSource(value)
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
    throw embeddingConfigurationError('`batchLimits` must be an object when it is provided')
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
    throw embeddingConfigurationError('`cache` must be an object when it is provided')
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
    throw embeddingConfigurationError('`fallback` must be an array when it is provided')
  }
  return Object.freeze(value.map(entry => {
    if (entry === null || typeof entry !== 'object') {
      throw embeddingConfigurationError('each `fallback` entry must be an object')
    }
    return Object.freeze({ ...entry })
  }))
}

function optionSource(value: unknown): Partial<EmbeddingHandleOptions> {
  if (value === null || typeof value !== 'object') {
    throw embeddingConfigurationError('`embeddingModel()` requires an options object')
  }
  return value as Partial<EmbeddingHandleOptions>
}
