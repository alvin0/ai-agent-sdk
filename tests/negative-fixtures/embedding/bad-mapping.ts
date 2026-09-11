/**
 * Responses whose index mapping is not a valid permutation of the batch sent.
 *
 * PLACEMENT NOTE (deviation from the task-named path). Task 6.6 names
 * `packages/core/tests/negative-fixtures/embedding/`, which does not exist and is
 * collected by no vitest project. Requirement 17.11 states the layout actually in
 * force — `tests/fixtures/` and `tests/negative-fixtures/` — so these files live
 * at `tests/negative-fixtures/embedding/` beside the existing negative fixtures.
 *
 * Unlike the architecture negative fixtures next door (`graph-cycle/`,
 * `runtime-safe/`), which are fake package trees a scanner walks, these are DATA:
 * off-contract provider responses that `validateBatchResult` must reject with a
 * NAMED code. Each case therefore carries the code it must produce, so one table
 * drives the core validation spec and both provider contract suites, and a
 * provider that reports a different code for the same malformation fails.
 *
 * Nothing here is "nearly right". A mapping that is not a bijection cannot be
 * repaired by sorting or by falling back to response order — restoring input
 * order from it would be guesswork, so it is a protocol error.
 *
 * @module tests/negative-fixtures/embedding/bad-mapping
 */

import { EMBEDDING_ERROR_CODES } from '../../../packages/core/src/embedding/errors.ts'
import type { EmbeddingErrorCode } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingBatchRequest, EmbeddingItem, EmbeddingTruncation,
} from '../../../packages/core/src/embedding/request.ts'
import type {
  EmbeddingBatchResult, EmbeddingVector,
} from '../../../packages/core/src/embedding/result.ts'

/** One off-contract response, with the code it must be rejected with. */
export interface BadResponseCase {
  /** Stable name used in test output. */
  readonly name: string
  /** Why this is a contract break rather than data to repair. */
  readonly why: string
  readonly batch: EmbeddingBatchRequest
  readonly result: EmbeddingBatchResult
  readonly expectedCode: EmbeddingErrorCode
}

/** One text item at a given `Logical_Call` index. */
export function embeddingItem(index: number, text = `input-${String(index)}`): EmbeddingItem {
  return { index, contentParts: [{ type: 'text', text }] }
}

/** A batch of `count` text items, optionally with a requested width. */
export function embeddingBatch(
  count: number,
  overrides: {
    readonly provider?: string
    readonly model?: string
    readonly dimensions?: number
    readonly truncation?: EmbeddingTruncation
    readonly startIndex?: number
  } = {},
): EmbeddingBatchRequest {
  const start = overrides.startIndex ?? 0
  return {
    provider: overrides.provider ?? 'fake',
    model: overrides.model ?? 'fake-embed',
    purpose: 'retrieval-document',
    items: Array.from({ length: count }, (_unused, offset) => embeddingItem(start + offset)),
    ...(overrides.dimensions === undefined ? {} : { dimensions: overrides.dimensions }),
    truncation: overrides.truncation ?? 'reject',
  }
}

/** A well-formed vector of `width` constant values, carrying `index`. */
export function vector(index: number, width = 3, value = 0.5): EmbeddingVector {
  return { index, values: Array.from({ length: width }, () => value) }
}

const BATCH_THREE = embeddingBatch(3)

/**
 * Mapping breaks, one per distinct way a provider can lose the correspondence
 * between inputs and vectors.
 */
export const BAD_MAPPING_CASES: readonly BadResponseCase[] = Object.freeze([
  {
    name: 'fewer vectors than inputs',
    why: 'a missing vector is a dropped input, not an input worth re-deriving',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
  },
  {
    name: 'more vectors than inputs',
    why: 'an extra vector belongs to no input the caller sent',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1), vector(2), vector(2)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
  },
  {
    name: 'empty response for a non-empty batch',
    why: 'zero vectors is still a count mismatch, not an empty success',
    batch: BATCH_THREE,
    result: { vectors: [] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
  },
  {
    name: 'duplicate index',
    why: 'two vectors claiming one input leave another input unanswered',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1), vector(1)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  },
  {
    name: 'index above range',
    why: 'the batch has no item 7; the vector maps to nothing',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1), vector(7)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  },
  {
    name: 'negative index',
    why: 'a negative index is not an item position',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1), vector(-1)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  },
  {
    name: 'non-integer index',
    why: '1.5 sits between two inputs; rounding would silently pick one',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1), vector(1.5)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  },
  {
    name: 'NaN index',
    why: 'NaN answers nothing and equals nothing, including itself',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1), vector(Number.NaN)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  },
  {
    name: 'batch-local indexes instead of logical-call indexes',
    why: 'the second physical batch renumbered from 0, so its vectors would '
      + 'overwrite the first batch on order restoration',
    batch: embeddingBatch(2, { startIndex: 4 }),
    result: { vectors: [vector(0), vector(1)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  },
  {
    name: 'right count, wrong index set',
    why: 'the count check passes, so only the bijection check catches this',
    batch: BATCH_THREE,
    result: { vectors: [vector(0), vector(1), vector(3)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
  },
])

/**
 * A reordered but VALID response, held here as the control.
 *
 * A permutation is legal — indexes travel with the vectors — so a suite that
 * rejects this one is over-strict, and this case is what proves the mapping
 * checks reject malformation rather than mere reordering.
 */
export const REORDERED_VALID_CASE: {
  readonly batch: EmbeddingBatchRequest
  readonly result: EmbeddingBatchResult
} = Object.freeze({
  batch: BATCH_THREE,
  result: { vectors: [vector(2), vector(0), vector(1)] },
})
