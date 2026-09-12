/**
 * Vector payloads that are broken in their VALUES rather than their mapping.
 *
 * Placement and shape follow `./bad-mapping.ts`: see the note there for why these
 * live under `tests/negative-fixtures/embedding/` (Requirement 17.11) instead of
 * the `packages/core/tests/...` path named in task 6.6. The case type and the
 * batch builders are reused from that module so both tables can be driven by one
 * loop in the consuming spec.
 *
 * The rule every case here encodes: an invalid vector is an ERROR, never data to
 * repair. Nothing is sliced to fit a requested width, nothing is padded, no
 * `NaN` is dropped, no non-finite value is clamped. A vector the SDK "fixed"
 * would still be published as if the provider had produced it.
 *
 * @module tests/negative-fixtures/embedding/bad-vector
 */

import { EMBEDDING_ERROR_CODES } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingBatchResult, EmbeddingVector,
} from '../../../packages/core/src/embedding/result.ts'
import type { BadResponseCase } from './bad-mapping.ts'
import { embeddingBatch, vector } from './bad-mapping.ts'

/** Off-contract vector shapes only a cast can express. */
function malformedVector(index: number, values: unknown): EmbeddingVector {
  return { index, values } as unknown as EmbeddingVector
}

const BATCH_TWO = embeddingBatch(2)
const BATCH_TWO_WIDE = embeddingBatch(2, { dimensions: 3 })
const BATCH_TWO_ALLOWS_TRUNCATION = embeddingBatch(2, { truncation: 'allow' })

/** Value-level and width-level breaks, with the code each must produce. */
export const BAD_VECTOR_CASES: readonly BadResponseCase[] = Object.freeze([
  {
    name: 'NaN component',
    why: 'a NaN component makes every distance involving this vector NaN',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, [0.1, Number.NaN, 0.3])] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  },
  {
    name: 'positive Infinity component',
    why: 'an infinite component dominates any similarity ranking it enters',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, [0.1, Number.POSITIVE_INFINITY, 0.3])] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  },
  {
    name: 'negative Infinity component',
    why: 'same fault, opposite sign; the code must not depend on the sign',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, [Number.NEGATIVE_INFINITY, 0.2, 0.3])] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  },
  {
    name: 'string component',
    why: '"0.2" is not a number; coercing it would invent a value',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, [0.1, '0.2', 0.3])] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  },
  {
    name: 'null component',
    why: 'a hole in a vector is not a zero',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, [0.1, null, 0.3])] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
  },
  {
    name: 'values is not an array',
    why: 'structurally not a vector, so it fails before any value is inspected',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, { 0: 0.1, 1: 0.2, length: 2 })] },
    expectedCode: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'values is a string',
    why: 'an iterable of characters is not a vector of numbers',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, '0.1,0.2,0.3')] },
    expectedCode: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'values is null',
    why: 'no payload at all, reported as if it were one',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), malformedVector(1, null)] },
    expectedCode: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
  {
    name: 'narrower than the requested width',
    why: 'padding to 3 would publish two invented components',
    batch: BATCH_TWO_WIDE,
    result: { vectors: [vector(0, 3), vector(1, 2)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
  },
  {
    name: 'wider than the requested width',
    why: 'slicing to 3 would silently move the vector out of its space',
    batch: BATCH_TWO_WIDE,
    result: { vectors: [vector(0, 3), vector(1, 5)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
  },
  {
    name: 'empty vector against a requested width',
    why: 'zero components answer the input with nothing',
    batch: BATCH_TWO_WIDE,
    result: { vectors: [vector(0, 3), malformedVector(1, [])] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
  },
  {
    name: 'inconsistent widths within one response',
    why: 'two widths in one batch cannot both be the space the caller asked for',
    batch: BATCH_TWO_WIDE,
    result: { vectors: [vector(0, 4), vector(1, 3)] },
    expectedCode: EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
  },
  {
    name: 'truncation reported although truncation was rejected',
    why: 'the caller asked for refusal, so a cut input is a contract break, not data',
    batch: BATCH_TWO,
    result: { vectors: [vector(0), { ...vector(1), truncated: true }] },
    expectedCode: EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
  },
])

/**
 * Responses that MUST be accepted, held as controls beside the rejections.
 *
 * An unrequested width is not a mismatch (there was no claim to contradict), and
 * `truncated: true` under `truncation: 'allow'` is a reportable fact rather than a
 * failure. A suite that rejects either of these is rejecting on inference.
 */
export const ACCEPTABLE_VECTOR_CASES: readonly {
  readonly name: string
  readonly batch: ReturnType<typeof embeddingBatch>
  readonly result: EmbeddingBatchResult
}[] = Object.freeze([
  {
    name: 'mixed widths with no requested dimensions',
    batch: BATCH_TWO,
    result: { vectors: [vector(0, 4), vector(1, 3)] },
  },
  {
    name: 'truncation reported when truncation was allowed',
    batch: BATCH_TWO_ALLOWS_TRUNCATION,
    result: { vectors: [vector(0), { ...vector(1), truncated: true }] },
  },
])
