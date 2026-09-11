/**
 * Pre-dispatch request validation and provider-response validation.
 *
 * Two rules shape everything here:
 *
 * 1. **Declared-only rejection (DD-6).** A check rejects ONLY when the matching
 *    catalog capability makes a positive claim and the value violates it. An
 *    `unknown` capability states nothing, so it can never become a reason to
 *    reject — that is what keeps a model id outside the catalog usable
 *    (Requirements 9.1, 9.2, 10.3).
 * 2. **Zero provider attempts.** Every failure raised by
 *    {@link validatePreDispatch} happens before the first `Physical_Batch` is
 *    dispatched, and carries `itemIndexes` plus the applied `limit` so a caller
 *    can re-chunk the offending inputs instead of the whole call (Requirement 3.6).
 *
 * `estimateTokens` is deliberately NOT defined in this module. The length check
 * reads `prepared.limits.estimateTokens` — the exact function the batch planner
 * uses — so a split and a length check can never disagree about the size of the
 * same text.
 *
 * @module ai-agent-sdk/core/embedding/validation
 */

import type { PreparedEmbeddingCall } from './adapter.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from './errors.ts'
import type { EmbeddingCapability } from './catalog.ts'
import type { EmbeddingProfile, EmbeddingSpaceId } from './profile.ts'
import { isSpaceCompatible } from './profile.ts'
import type { EmbeddingPurpose } from './purpose.ts'
import type { EmbeddingBatchRequest, EmbeddingItem, EmbeddingTruncation } from './request.ts'
import type { EmbeddingBatchResult } from './result.ts'

/** The two legal {@link EmbeddingPurpose} values, as a runtime guard set. */
const VALID_PURPOSES: readonly string[] = Object.freeze([
  'retrieval-query',
  'retrieval-document',
])

/**
 * One `Logical_Call` as it stands just before the first dispatch.
 *
 * Deliberately NOT an {@link EmbeddingBatchRequest}: validation runs once per
 * logical call, over ALL items, before any batch exists.
 */
export interface PreDispatchRequest {
  readonly purpose: EmbeddingPurpose
  /** Every item of the logical call, in input order. */
  readonly items: readonly EmbeddingItem[]
  /** Caller-requested width; absent means the model default. */
  readonly dimensions?: number
  /** Resolved truncation preference. */
  readonly truncation: EmbeddingTruncation
  /** Space the caller demands; incompatibility is a rejection. */
  readonly expectedSpace?: EmbeddingSpaceId
  /**
   * The profile behind {@link expectedSpace}, when the caller has it.
   *
   * Present ⇒ compatibility is decided by {@link isSpaceCompatible}; absent ⇒ by
   * canonical `Space_Id` equality. Both answer the same question, since the
   * `Space_Id` is derived from exactly the components that decide compatibility.
   */
  readonly expectedProfile?: EmbeddingProfile
  /**
   * Whether the route has a truncation parameter at all.
   *
   * `'unsupported'` is the route positively stating the provider exposes no such
   * parameter, which is the only state that rejects `truncation: 'allow'`.
   * `'unknown'` never rejects.
   */
  readonly truncationSupport?: EmbeddingCapability<boolean>
}

/** Concatenated effective text of one item, in content-part order. */
function itemText(item: EmbeddingItem): string {
  let text = ''
  for (const part of item.contentParts) {
    if (part.type === 'text') text += part.text
  }
  return text
}

/** Rejects a purpose outside the two declared values (Requirement 7.2). */
function checkPurpose(request: PreDispatchRequest, prepared: PreparedEmbeddingCall): void {
  if (VALID_PURPOSES.includes(request.purpose)) return
  throw new EmbeddingError(
    'Embedding purpose must be "retrieval-query" or "retrieval-document"',
    EMBEDDING_ERROR_CODES.REQUEST_INVALID,
    routeFacts(prepared),
  )
}

/**
 * Rejects an empty call, an item with no content parts, and an item whose
 * effective text is empty. All three are malformed at the SDK boundary, not
 * questions for the provider.
 */
function checkItems(request: PreDispatchRequest, prepared: PreparedEmbeddingCall): void {
  if (request.items.length === 0) {
    throw new EmbeddingError(
      'Embedding request carries no input values',
      EMBEDDING_ERROR_CODES.REQUEST_INVALID,
      routeFacts(prepared),
    )
  }
  const empty: number[] = []
  for (const item of request.items) {
    if (item.contentParts.length === 0 || itemText(item).length === 0) empty.push(item.index)
  }
  if (empty.length > 0) {
    throw new EmbeddingError(
      `Embedding input is empty at ${empty.length} item(s)`,
      EMBEDDING_ERROR_CODES.REQUEST_INVALID,
      { ...routeFacts(prepared), itemIndexes: empty },
    )
  }
}

/**
 * Rejects a requested width the route declares it does not offer.
 *
 * A non-integer or non-positive width is malformed regardless of the catalog; a
 * width outside a `supported` list is a capability violation. When the catalog
 * says `unknown`, the width goes to the provider unchallenged (DD-6).
 */
function checkDimensions(request: PreDispatchRequest, prepared: PreparedEmbeddingCall): void {
  const requested = request.dimensions
  if (requested === undefined) return
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new EmbeddingError(
      'Embedding dimensions must be a positive integer',
      EMBEDDING_ERROR_CODES.REQUEST_INVALID,
      routeFacts(prepared),
    )
  }
  const declared = prepared.model.dimensions
  if (declared.state !== 'supported') return
  if (declared.value.includes(requested)) return
  throw new EmbeddingError(
    `Embedding model does not support ${requested} dimensions`,
    EMBEDDING_ERROR_CODES.DIMENSIONS_UNSUPPORTED,
    routeFacts(prepared),
  )
}

/**
 * Rejects inputs longer than a DECLARED per-input token ceiling.
 *
 * The estimate comes from `prepared.limits.estimateTokens`, the planner's own
 * function. The check runs only when `maxInputTokens` is `supported`: with an
 * `unknown` ceiling there is no bound to measure against, and the estimator's
 * batching fallbacks are not a claim the provider made.
 */
function checkInputLength(request: PreDispatchRequest, prepared: PreparedEmbeddingCall): void {
  const declared = prepared.model.maxInputTokens
  if (declared.state !== 'supported') return
  const limit = declared.value
  if (!Number.isFinite(limit) || limit <= 0) return
  const oversized: number[] = []
  for (const item of request.items) {
    if (prepared.limits.estimateTokens(itemText(item)) > limit) oversized.push(item.index)
  }
  if (oversized.length === 0) return
  throw new EmbeddingError(
    `Embedding input exceeds the declared limit of ${limit} tokens`,
    EMBEDDING_ERROR_CODES.INPUT_TOO_LARGE,
    { ...routeFacts(prepared), itemIndexes: oversized, limit },
  )
}

/**
 * Rejects a call whose vectors would not land in the space the caller expects.
 *
 * Compatibility is the declared identity's business, never a comparison of
 * dimension counts or model names.
 */
function checkSpace(request: PreDispatchRequest, prepared: PreparedEmbeddingCall): void {
  const expected = request.expectedSpace
  const expectedProfile = request.expectedProfile
  if (expected === undefined && expectedProfile === undefined) return
  const compatible =
    expectedProfile === undefined
      ? expected === prepared.spaceId
      : isSpaceCompatible(expectedProfile, prepared.profile)
  if (compatible) return
  throw new EmbeddingError(
    'Expected embedding space is incompatible with the prepared call',
    EMBEDDING_ERROR_CODES.SPACE_INCOMPATIBLE,
    { ...routeFacts(prepared), space: prepared.spaceId },
  )
}

/**
 * Rejects `truncation: 'allow'` on a route that states it has no truncation
 * parameter. Accepting it would mean promising a behaviour nothing on the wire
 * can express (Requirement 9.7).
 */
function checkTruncation(request: PreDispatchRequest, prepared: PreparedEmbeddingCall): void {
  if (request.truncation !== 'allow') return
  if (request.truncationSupport?.state !== 'unsupported') return
  throw new EmbeddingError(
    'Provider route exposes no truncation parameter',
    EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED,
    routeFacts(prepared),
  )
}

/** Route identity attached to every failure, omitted rather than left `undefined`. */
function routeFacts(prepared: PreparedEmbeddingCall): { provider: string; model: string } {
  return { provider: prepared.model.provider, model: prepared.model.id }
}

/**
 * Validates one `Logical_Call` against the SAME `PreparedEmbeddingCall` that will
 * dispatch it, BEFORE any `Physical_Batch` goes out.
 *
 * Every rejection here happens with 0 `Provider_Attempt`. Checks run cheapest
 * first, so a malformed request never pays for token estimation.
 *
 * @param request - the logical call as resolved from the caller.
 * @param prepared - the generation whose metadata, profile and limits will be used.
 * @throws EmbeddingError with a code from `EMBEDDING_ERROR_CODES` on any violation.
 */
export function validatePreDispatch(
  request: PreDispatchRequest,
  prepared: PreparedEmbeddingCall,
): void {
  checkPurpose(request, prepared)
  checkItems(request, prepared)
  checkDimensions(request, prepared)
  checkTruncation(request, prepared)
  checkSpace(request, prepared)
  // Last: the only check that walks every input's text.
  checkInputLength(request, prepared)
}

/** Rejects a vector count that does not match the batch that was sent. */
function checkVectorCount(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): void {
  if (result.vectors.length === batch.items.length) return
  throw new EmbeddingError(
    `Provider returned ${result.vectors.length} vectors for ${batch.items.length} inputs`,
    EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
    { provider: batch.provider, model: batch.model },
  )
}

/**
 * Rejects an index set that is not a permutation of the batch's item indexes.
 *
 * Duplicates, gaps and out-of-range values all land here: without a bijection,
 * restoring input order would be guesswork.
 */
function checkVectorIndexes(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): void {
  const expected = new Set(batch.items.map(item => item.index))
  const seen = new Set<number>()
  for (const vector of result.vectors) {
    if (!Number.isInteger(vector.index) || !expected.has(vector.index) || seen.has(vector.index)) {
      throw new EmbeddingError(
        'Provider returned a duplicate, missing or out-of-range vector index',
        EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
        { provider: batch.provider, model: batch.model },
      )
    }
    seen.add(vector.index)
  }
}

/** Rejects a non-array payload, `NaN`, and `Infinity`: never silently repaired. */
function checkVectorValues(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): void {
  for (const vector of result.vectors) {
    if (!Array.isArray(vector.values)) {
      throw new EmbeddingError(
        'Provider returned a vector whose values are not an array',
        EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
        { provider: batch.provider, model: batch.model, itemIndexes: [vector.index] },
      )
    }
    if (vector.values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new EmbeddingError(
        'Provider returned a vector containing a non-finite value',
        EMBEDDING_ERROR_CODES.VECTOR_VALUE_INVALID,
        { provider: batch.provider, model: batch.model, itemIndexes: [vector.index] },
      )
    }
  }
}

/**
 * Rejects a width that differs from the REQUESTED one.
 *
 * Only checked when the request named a width: with no request there is nothing
 * the provider contradicted, and the SDK never slices or pads to fit.
 */
function checkVectorWidth(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): void {
  const expected = batch.dimensions
  if (expected === undefined) return
  for (const vector of result.vectors) {
    if (vector.values.length === expected) continue
    throw new EmbeddingError(
      `Provider returned a ${vector.values.length}-dimensional vector, expected ${expected}`,
      EMBEDDING_ERROR_CODES.VECTOR_DIMENSIONS_MISMATCH,
      {
        provider: batch.provider,
        model: batch.model,
        itemIndexes: [vector.index],
        limit: expected,
      },
    )
  }
}

/**
 * Rejects a truncation report the caller never authorised.
 *
 * `truncated: true` under `truncation: 'reject'` means the provider shortened an
 * input the caller asked to have refused instead — a contract break, not data.
 */
function checkTruncationReports(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): void {
  if (batch.truncation !== 'reject') return
  const truncated = result.vectors.filter(vector => vector.truncated === true)
  if (truncated.length === 0) return
  throw new EmbeddingError(
    'Provider reported truncation although truncation was rejected',
    EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
    {
      provider: batch.provider,
      model: batch.model,
      itemIndexes: truncated.map(vector => vector.index),
    },
  )
}

/**
 * Validates one `Provider_Attempt`'s response against the batch that produced it.
 *
 * Order is fixed — count, indexes, values, width, truncation reports — so the
 * SAME malformed response yields the SAME code across providers, which is what
 * lets one contract-test suite run against all of them. Nothing here infers or
 * repairs: a response that breaks the contract is a protocol error.
 *
 * @param batch - the physical batch that was dispatched.
 * @param result - what the adapter parsed out of exactly one provider attempt.
 * @throws EmbeddingError with a vector- or response-level code on any violation.
 */
export function validateBatchResult(
  batch: EmbeddingBatchRequest,
  result: EmbeddingBatchResult,
): void {
  checkVectorCount(batch, result)
  checkVectorIndexes(batch, result)
  checkVectorValues(batch, result)
  checkVectorWidth(batch, result)
  checkTruncationReports(batch, result)
}
