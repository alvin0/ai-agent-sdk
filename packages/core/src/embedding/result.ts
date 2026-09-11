/**
 * Result shapes for embedding batches and logical calls.
 *
 * No type here references `StreamChunk`, messages, tool calls or text deltas:
 * embedding is a separate capability, not a projection of generation.
 *
 * @module ai-agent-sdk/core/embedding/result
 */

import type { UsageCounters } from '../observation/usage.ts'
import type { EmbeddingProfile, EmbeddingSpaceId } from './profile.ts'
import type { EmbeddingUsageReport } from './usage.ts'

/** One vector, mapped back to the input it belongs to. */
export interface EmbeddingVector {
  /** MUST match the `index` of an item in the request. */
  readonly index: number
  /**
   * The values exactly as the provider returned them, apart from a post-processing
   * step recorded in {@link EmbeddingProfile}. Never sliced or padded.
   */
  readonly values: readonly number[]
  /** Provider reported this input was cut; only valid when `truncation === 'allow'`. */
  readonly truncated?: boolean
}

/** What one `Provider_Attempt` produced for one `Physical_Batch`. */
export interface EmbeddingBatchResult {
  readonly vectors: readonly EmbeddingVector[]
  /** Raw provider evidence. The runtime does NOT infer 0 when this is absent. */
  readonly usage?: UsageCounters
  readonly providerRequestId?: string
  readonly warnings?: readonly EmbeddingWarning[]
}

/** A fact worth surfacing that is not a failure. */
export interface EmbeddingWarning {
  readonly code: 'input-truncated' | 'usage-unreported' | 'usage-malformed'
  /** Affected input indexes, in `Logical_Call` numbering. */
  readonly itemIndexes?: readonly number[]
  readonly message: string
}

/** What `embed()` returns for one input. */
export interface EmbeddingResult {
  readonly embedding: readonly number[]
  readonly space: EmbeddingSpaceId
  readonly profile: EmbeddingProfile
  readonly usage: EmbeddingUsageReport
  readonly warnings: readonly EmbeddingWarning[]
}

/** What `embedMany()` returns; `embeddings` follows input order. */
export interface EmbeddingManyResult {
  readonly embeddings: readonly (readonly number[])[]
  readonly space: EmbeddingSpaceId
  readonly profile: EmbeddingProfile
  readonly usage: EmbeddingUsageReport
  readonly warnings: readonly EmbeddingWarning[]
}
