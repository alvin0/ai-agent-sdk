/**
 * Request shapes for one physical embedding batch.
 *
 * @module ai-agent-sdk/core/embedding/request
 */

import type { EmbeddingPurpose } from './purpose.ts'

/**
 * One component of a single object to embed.
 *
 * v1 scope is text only; the union exists so multimodal parts can be added later
 * without changing the surrounding contract.
 */
export type EmbeddingContentPart =
  | { readonly type: 'text'; readonly text: string }

/** One object embedded independently of the others in the same call. */
export interface EmbeddingItem {
  /**
   * Index within the `Logical_Call`, NOT the index within the `Physical_Batch`.
   *
   * Result order is restored from this value, so it survives batching, retries and
   * out-of-order settlement.
   */
  readonly index: number
  /** Components of the SAME object; a provider returns exactly one vector per item. */
  readonly contentParts: readonly EmbeddingContentPart[]
}

/**
 * Whether the caller accepts provider-side input truncation.
 *
 * `'reject'` means an over-length input is a structured error, not data to cut.
 */
export type EmbeddingTruncation = 'reject' | 'allow'

/**
 * SDK default truncation.
 *
 * Stays `'reject'` even where the provider default is on: silently shortening an
 * input changes the vector without telling the caller.
 */
export const DEFAULT_EMBEDDING_TRUNCATION: EmbeddingTruncation = 'reject'

/** Exactly one physical embedding request handed to an adapter. */
export interface EmbeddingBatchRequest {
  /** Provider route key that owns this call. */
  readonly provider: string
  /** Model id as passed by the caller. */
  readonly model: string
  readonly purpose: EmbeddingPurpose
  readonly items: readonly EmbeddingItem[]
  /** Requested dimensions; absent means the model default. */
  readonly dimensions?: number
  /** Resolved from the caller, defaulting to {@link DEFAULT_EMBEDDING_TRUNCATION}. */
  readonly truncation: EmbeddingTruncation
  readonly signal?: AbortSignal
}
