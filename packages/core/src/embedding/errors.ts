/**
 * The stable embedding failure taxonomy, and the error the embedding layers throw.
 *
 * Codes here are owned by two layers only: `Embedding_Runtime` before dispatch
 * (dimensions, limits, space, configuration) and `Embedding_Adapter` when it
 * validates a response (vector count, index, values, width). Transport-level
 * faults keep using `MODEL_ERROR_CODES`, so a caller can tell "the provider is
 * rate limiting us" apart from "the provider returned a vector of the wrong
 * width" without parsing any message.
 *
 * Both provider adapters emit the SAME codes for mapping, dimensions and vector
 * faults. That is what lets one contract-test suite run against both.
 *
 * @module ai-agent-sdk/core/embedding/errors
 */

import { AgentSdkError } from '../errors/agent-sdk-error.ts'
import type { EmbeddingSpaceId } from './profile.ts'

/**
 * Codes produced by the embedding contract and runtime.
 *
 * A frozen object rather than a TS enum, matching `MODEL_ERROR_CODES`, so a
 * third-party embedding adapter can emit its own code without this union having
 * to know about it. Values are prefixed `EMBEDDING_` because they travel beside
 * generation codes in the same failure envelopes.
 */
export const EMBEDDING_ERROR_CODES = Object.freeze({
  /** No `Embedding_Adapter` is registered for the requested route/model. */
  ADAPTER_MISSING: 'EMBEDDING_ADAPTER_MISSING',
  /** Malformed at the SDK boundary: missing purpose, empty values, empty item. */
  REQUEST_INVALID: 'EMBEDDING_REQUEST_INVALID',
  /** `dimensions` is not among the widths the route declares support for. */
  DIMENSIONS_UNSUPPORTED: 'EMBEDDING_DIMENSIONS_UNSUPPORTED',
  /** Input exceeds the declared max input tokens; carries `itemIndexes` and `limit`. */
  INPUT_TOO_LARGE: 'EMBEDDING_INPUT_TOO_LARGE',
  /** The expected `Space_Id` is incompatible with the `Prepared_Embedding_Call`. */
  SPACE_INCOMPATIBLE: 'EMBEDDING_SPACE_INCOMPATIBLE',
  /** The route has no way to express this purpose and the caller demands the distinction. */
  PURPOSE_UNSUPPORTED: 'EMBEDDING_PURPOSE_UNSUPPORTED',
  /** The caller asked for truncation but the provider has no equivalent parameter. */
  TRUNCATION_UNSUPPORTED: 'EMBEDDING_TRUNCATION_UNSUPPORTED',
  /** The response carried a different number of vectors than inputs sent. */
  VECTOR_COUNT_MISMATCH: 'EMBEDDING_VECTOR_COUNT_MISMATCH',
  /** A vector index is duplicated, missing, or out of range. */
  VECTOR_INDEX_INVALID: 'EMBEDDING_VECTOR_INDEX_INVALID',
  /** A vector contains `NaN` or `Infinity`. */
  VECTOR_VALUE_INVALID: 'EMBEDDING_VECTOR_VALUE_INVALID',
  /** A vector's width differs from the requested `dimensions`. */
  VECTOR_DIMENSIONS_MISMATCH: 'EMBEDDING_VECTOR_DIMENSIONS_MISMATCH',
  /** The response does not satisfy the embedding contract structurally. */
  RESPONSE_MALFORMED: 'EMBEDDING_RESPONSE_MALFORMED',
  /** The caller's signal or a runtime close aborted the call. */
  ABORTED: 'EMBEDDING_ABORTED',
  /** Invalid handle configuration: cache enabled without scope, fallback outside the group. */
  CONFIGURATION_INVALID: 'EMBEDDING_CONFIGURATION_INVALID',
  /** Nothing in this taxonomy classified the embedding failure. */
  UNKNOWN: 'EMBEDDING_UNKNOWN',
} as const)

/** Any value of {@link EMBEDDING_ERROR_CODES}; a foreign adapter may still use its own `string`. */
export type EmbeddingErrorCode = typeof EMBEDDING_ERROR_CODES[keyof typeof EMBEDDING_ERROR_CODES]

/** Structured embedding facts and cause accepted by {@link EmbeddingError}. */
export interface EmbeddingErrorOptions extends ErrorOptions {
  /**
   * Zero-based indexes of the request items this failure belongs to.
   *
   * Present only when the fault is attributable to specific inputs, which is
   * what lets a caller drop or re-chunk those items instead of the whole call.
   */
  itemIndexes?: readonly number[]
  /** The limit that was applied, when the failure is a limit violation. */
  limit?: number
  /** Provider id of the route that produced the failure. */
  provider?: string
  /** Model id of the route that produced the failure. */
  model?: string
  /** The embedding space involved, when the failure concerns space compatibility. */
  space?: EmbeddingSpaceId
}

/**
 * Typed error for embedding failures, carrying a stable `code` plus the facts a
 * caller needs to act without re-deriving them.
 *
 * The constructor validates rather than trusts: `itemIndexes` must be
 * non-negative integers and `limit` a positive finite number. A negative index
 * or a `limit` of `-1` means a caller upstream miscomputed a bound, and letting
 * it through would surface a nonsense limit in a message that reads as
 * authoritative. Indexes are copied and frozen so the array cannot be mutated
 * after the error is thrown.
 *
 * No field carries raw input text or vector values: redaction rules keep those
 * out of errors and traces alike.
 */
export class EmbeddingError extends AgentSdkError {
  /** Request item indexes this failure belongs to, when input-specific. */
  readonly itemIndexes?: readonly number[]
  /** The applied limit, when the failure is a limit violation. */
  readonly limit?: number
  /** Provider id of the failing route. */
  readonly provider?: string
  /** Model id of the failing route. */
  readonly model?: string
  /** The embedding space involved in the failure. */
  readonly space?: EmbeddingSpaceId

  /**
   * @param message - non-empty human-readable failure summary, free of credentials and raw input.
   * @param code - non-empty stable machine code, normally from {@link EMBEDDING_ERROR_CODES}.
   * @param options - optional cause and validated embedding facts.
   */
  constructor(message: string, code: string, options?: EmbeddingErrorOptions) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('EmbeddingError message must be a non-empty string')
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('EmbeddingError code must be a non-empty string')
    }
    if (options?.itemIndexes !== undefined
      && (!Array.isArray(options.itemIndexes)
        || options.itemIndexes.some(index => !Number.isInteger(index) || index < 0))) {
      throw new Error('EmbeddingError itemIndexes must be an array of non-negative integers')
    }
    if (options?.limit !== undefined
      && (!Number.isFinite(options.limit) || options.limit <= 0)) {
      throw new Error('EmbeddingError limit must be a positive finite number')
    }
    if (options?.provider !== undefined
      && (typeof options.provider !== 'string' || options.provider.length === 0)) {
      throw new Error('EmbeddingError provider must be a non-empty string')
    }
    if (options?.model !== undefined
      && (typeof options.model !== 'string' || options.model.length === 0)) {
      throw new Error('EmbeddingError model must be a non-empty string')
    }
    if (options?.space !== undefined
      && (typeof options.space !== 'string' || options.space.length === 0)) {
      throw new Error('EmbeddingError space must be a non-empty string')
    }
    super(message, code, options)
    this.name = 'EmbeddingError'
    if (options?.itemIndexes !== undefined) {
      this.itemIndexes = Object.freeze([...options.itemIndexes])
    }
    if (options?.limit !== undefined) this.limit = options.limit
    if (options?.provider !== undefined) this.provider = options.provider
    if (options?.model !== undefined) this.model = options.model
    if (options?.space !== undefined) this.space = options.space
  }
}
