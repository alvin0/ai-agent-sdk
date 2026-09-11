/**
 * Lazy batch planner: splits one `Logical_Call` into `Physical_Batch` plans.
 *
 * The planner consumes {@link ResolvedEmbeddingBatchLimits} from
 * `embedding/limits.ts` and defines NO limit type of its own. That is what keeps
 * the dependency direction `composition/embedding/` → `embedding/` one-way
 * (DD-12, Requirements 1.6 and 19.6).
 *
 * @module ai-agent-sdk/core/composition/embedding/planner
 */

import {
  EMBEDDING_BATCH_DEFAULTS,
  type ResolvedEmbeddingBatchLimits,
} from '../../embedding/limits.ts'
import type { EmbeddingItem } from '../../embedding/request.ts'

/**
 * One planned `Physical_Batch`.
 *
 * `batchIndex` is the position of the batch in the plan, in input order. It is a
 * plan coordinate, not an item coordinate: item order is restored from
 * {@link EmbeddingItem.index}, which survives batching and retries.
 */
export interface EmbeddingBatchPlan {
  readonly batchIndex: number
  readonly items: readonly EmbeddingItem[]
  /** Estimated tokens of this batch, measured with `limits.estimateTokens`. */
  readonly estimatedTokens: number
  /** UTF-8 byte size of this batch's text. */
  readonly bytes: number
}

const ENCODER = new TextEncoder()

/** A usable positive integer bound, or `undefined` when there is none. */
function usable(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value <= 0) return undefined
  return value
}

/** Measured size of a single item, using the caller's shared estimator. */
function measure(
  item: EmbeddingItem,
  estimateTokens: (text: string) => number,
): { tokens: number; bytes: number } {
  let tokens = 0
  let bytes = 0
  for (const part of item.contentParts) {
    tokens += estimateTokens(part.text)
    bytes += ENCODER.encode(part.text).byteLength
  }
  return { tokens, bytes }
}

/**
 * Yields `Physical_Batch` plans in input order, closing the current batch as soon
 * as adding the next item would exceed ANY of the three limits. The three bounds
 * apply simultaneously, not as a choice of one (Requirement 4.4).
 *
 * Invariants: every batch is within every limit; every item appears exactly once
 * in exactly one batch; a batch is never empty.
 *
 * Deliberate exception: an item that alone exceeds `maxTokens` or `maxBytes`
 * still becomes a one-item batch. Cutting content is something the SDK does not
 * do — the provider rejects it and that error is the honest answer.
 *
 * Lazy by construction: at most one batch is held at a time, so peak memory is
 * bounded by the limits, not by the size of the corpus (Requirement 17.4).
 * `items` may be any iterable, so a streaming corpus is never materialised.
 */
export function* planEmbeddingBatches(
  items: Iterable<EmbeddingItem>,
  limits: ResolvedEmbeddingBatchLimits,
): Generator<EmbeddingBatchPlan> {
  // A capability the catalog left `unknown` (or an unusable override) falls back
  // to EMBEDDING_BATCH_DEFAULTS: batching always needs a finite upper bound.
  const maxItems = usable(limits.maxItems) ?? EMBEDDING_BATCH_DEFAULTS.maxItems
  const maxTokens = usable(limits.maxTokens) ?? EMBEDDING_BATCH_DEFAULTS.maxTokens
  const maxBytes = usable(limits.maxBytes) ?? EMBEDDING_BATCH_DEFAULTS.maxBytes
  const estimateTokens = limits.estimateTokens

  let batchIndex = 0
  let current: EmbeddingItem[] = []
  let tokens = 0
  let bytes = 0

  for (const item of items) {
    const size = measure(item, estimateTokens)

    // Close on the FIRST limit the next item would breach. Only a non-empty
    // batch can be closed, which is what makes the one-item overflow batch the
    // single deliberate exception instead of an infinite loop.
    if (
      current.length > 0
      && (current.length + 1 > maxItems
        || tokens + size.tokens > maxTokens
        || bytes + size.bytes > maxBytes)
    ) {
      yield { batchIndex, items: current, estimatedTokens: tokens, bytes }
      batchIndex += 1
      current = []
      tokens = 0
      bytes = 0
    }

    current.push(item)
    tokens += size.tokens
    bytes += size.bytes
  }

  if (current.length > 0) {
    yield { batchIndex, items: current, estimatedTokens: tokens, bytes }
  }
}
