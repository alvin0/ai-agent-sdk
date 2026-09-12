/**
 * Batch limits and the one shared token estimator.
 *
 * These are contract DATA, not a composition detail: `prepareEmbeddingCall()`
 * and `PreparedEmbeddingCall` both carry them. Putting them in
 * `composition/embedding/planner.ts` would force `embedding/` to import from
 * `composition/`, the exact reversed dependency Requirements 1.6 and 19.6
 * forbid (DD-12). So they live here, and the planner consumes them.
 *
 * @module ai-agent-sdk/core/embedding/limits
 */

import type { EmbeddingCapability, ResolvedEmbeddingModelInfo } from './catalog.ts'

/**
 * Safe fallbacks used for BATCHING when a catalog capability is not a declared
 * number.
 *
 * Batching always needs a finite upper bound, otherwise the memory of one
 * `Logical_Call` is unbounded (Requirement 17.4). Validation is the opposite
 * case: an `unknown` capability is NEVER a reason to reject a request, so these
 * values must not be read as limits the provider claimed (DD-6).
 */
export const EMBEDDING_BATCH_DEFAULTS = Object.freeze({
  maxItems: 96,
  maxTokens: 100_000,
  maxBytes: 1024 * 1024,
} as const)

/** Fully decided batch bounds plus the estimator that measures against them. */
export interface ResolvedEmbeddingBatchLimits {
  readonly maxItems: number
  readonly maxTokens: number
  readonly maxBytes: number
  readonly estimateTokens: (text: string) => number
}

const ENCODER = new TextEncoder()

/** Bytes per estimated token in the default heuristic. */
const BYTES_PER_TOKEN = 4

/**
 * Shared token estimate for batching and for input-length checks.
 *
 * Default `ceil(utf8Bytes / 4)`. This is an ESTIMATE, not a provider tokenizer:
 * it is used only to split batches and to reject an input when `maxInputTokens`
 * is `supported` and the estimate already exceeds it. An adapter with a closer
 * estimator passes it through `limits.estimateTokens`.
 *
 * There is exactly ONE owner of this heuristic — this function — so a batch
 * split and a length check can never disagree about the size of the same text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(ENCODER.encode(text).byteLength / BYTES_PER_TOKEN)
}

/** A declared positive integer bound, or `undefined` when there is none to use. */
function declared(capability: EmbeddingCapability<number>): number | undefined {
  if (capability.state !== 'supported') return undefined
  return override(capability.value)
}

/** A caller override wins outright, when it is a usable positive integer. */
function override(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

/**
 * Merges caller overrides over the catalog's declared bounds, falling back to
 * {@link EMBEDDING_BATCH_DEFAULTS} for anything the catalog leaves `unknown`.
 *
 * Precedence is override → catalog → default. Because the fallback is total, the
 * result is always finite, which is what lets a model id outside the catalog be
 * batched without being rejected.
 */
export function resolveBatchLimits(
  model: ResolvedEmbeddingModelInfo,
  overrides?: Partial<ResolvedEmbeddingBatchLimits>,
): ResolvedEmbeddingBatchLimits {
  return {
    maxItems:
      override(overrides?.maxItems)
      ?? declared(model.maxBatchItems)
      ?? EMBEDDING_BATCH_DEFAULTS.maxItems,
    maxTokens:
      override(overrides?.maxTokens)
      ?? declared(model.maxBatchTokens)
      ?? EMBEDDING_BATCH_DEFAULTS.maxTokens,
    maxBytes:
      override(overrides?.maxBytes)
      ?? declared(model.maxBatchBytes)
      ?? EMBEDDING_BATCH_DEFAULTS.maxBytes,
    estimateTokens: overrides?.estimateTokens ?? estimateTokens,
  }
}
