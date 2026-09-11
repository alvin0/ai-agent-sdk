/**
 * Public barrel of the `@alvin0/ai-agent-sdk-core/embedding` entry point.
 *
 * This is the whole `Embedding_Contract`: what an `Embedding_Adapter`
 * implements, the request/result vocabulary, profile and space identity,
 * purpose, catalog capabilities, batch limits, the error taxonomy, and the
 * validation helpers.
 *
 * Nothing reachable from here imports `composition/`. The runtime that consumes
 * this contract lives in `composition/embedding/`, so the dependency runs one
 * way only (Requirements 1.6, 19.6). The root entry point re-exports just the
 * type surface of `AgentRuntime.embeddingModel()`; everything else is here.
 *
 * @module ai-agent-sdk/core/embedding
 */

export { EmbeddingAdapter } from './adapter.ts'
export type { PrepareEmbeddingOptions, PreparedEmbeddingCall } from './adapter.ts'

export { unknownEmbeddingModel } from './catalog.ts'
export type {
  EmbeddingCapability, EmbeddingInputType, EmbeddingModelInfo, ResolvedEmbeddingModelInfo,
} from './catalog.ts'

export { EMBEDDING_ERROR_CODES, EmbeddingError } from './errors.ts'
export type { EmbeddingErrorCode, EmbeddingErrorOptions } from './errors.ts'

export type {
  EmbedManyInput, EmbedOneInput, EmbeddingCacheEntry, EmbeddingCacheOptions,
  EmbeddingCacheStore, EmbeddingModelHandle, EmbeddingModelOptions,
} from './handle.ts'

export { EMBEDDING_BATCH_DEFAULTS, estimateTokens, resolveBatchLimits } from './limits.ts'
export type { ResolvedEmbeddingBatchLimits } from './limits.ts'

export { defaultEmbeddingProfile, deriveSpaceId, isSpaceCompatible } from './profile.ts'
export type {
  EmbeddingNormalization, EmbeddingPostProcessing, EmbeddingProfile, EmbeddingProfileInput,
  EmbeddingRepresentation, EmbeddingSpaceId,
} from './profile.ts'

export type { EmbeddingPurpose, EmbeddingPurposeHandling } from './purpose.ts'

export { DEFAULT_EMBEDDING_TRUNCATION } from './request.ts'
export type {
  EmbeddingBatchRequest, EmbeddingContentPart, EmbeddingItem, EmbeddingTruncation,
} from './request.ts'

export type {
  EmbeddingBatchResult, EmbeddingManyResult, EmbeddingResult, EmbeddingVector, EmbeddingWarning,
} from './result.ts'

export {
  classifyEmbeddingUsageStatus, hasEmbeddingUsage, validateEmbeddingUsage,
} from './usage.ts'
export type {
  EmbeddingCounterKey, EmbeddingTokenUsage, EmbeddingUsageReport, EmbeddingUsageStatus,
  EmbeddingUsageValidation,
} from './usage.ts'

export { validateBatchResult, validatePreDispatch } from './validation.ts'
export type { PreDispatchRequest } from './validation.ts'
