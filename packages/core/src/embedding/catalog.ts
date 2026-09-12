/**
 * `Embedding_Catalog`: embedding-specific model metadata, kept entirely separate
 * from {@link ResolvedModelInfo}.
 *
 * Generation metadata and embedding metadata answer different questions, so this
 * module adds NO field to the generation catalog. Every capability that is not
 * declared explicitly is `unknown`, and `unknown` is never a reason to reject a
 * request: an id outside the catalog stays usable and the provider decides
 * (Requirements 10.1, 10.3, 10.4, 10.5).
 *
 * @module ai-agent-sdk/core/embedding/catalog
 */

import type { EmbeddingNormalization, EmbeddingRepresentation } from './profile.ts'
import type { EmbeddingPurposeHandling } from './purpose.ts'

/**
 * A single catalog capability in one of exactly three states.
 *
 * `'unsupported'` is a positive negative claim — the route states it does not
 * have the thing. `'unknown'` states nothing at all. Collapsing the two would
 * let a missing declaration masquerade as a denial, which is what Requirement
 * 10.4 rules out.
 */
export type EmbeddingCapability<T> =
  | { readonly state: 'supported'; readonly value: T }
  | { readonly state: 'unsupported' }
  | { readonly state: 'unknown' }

/**
 * Accepted input kinds. v1 declares exactly one.
 *
 * There is no value here for images, audio or any other modality, so the v1
 * text-only scope is readable from the type rather than from prose
 * (Requirements 8.6, 8.8).
 */
export type EmbeddingInputType = 'text'

/** The `unknown` capability, shared so descriptors need not re-allocate it. */
const UNKNOWN: EmbeddingCapability<never> = Object.freeze({ state: 'unknown' })

/**
 * One embedding model a route can advertise.
 *
 * Catalog membership is ADVISORY, exactly as it is for generation: an adapter
 * may accept an id it does not list.
 */
export interface EmbeddingModelInfo {
  /** Provider route that owns this entry. */
  readonly provider: string
  /** Model id passed to `embed()`/`embedMany()`. */
  readonly id: string
  /** Human-readable name for selectors. */
  readonly name: string
  /** Optional user-facing distinction from otherwise similar models. */
  readonly description?: string
  /** Accepted input kinds; v1 has only {@link EmbeddingInputType}. */
  readonly inputTypes: EmbeddingCapability<readonly EmbeddingInputType[]>
  /** Output shape; v1 has only `'dense-float32'`, one dense vector per item. */
  readonly representation: EmbeddingCapability<EmbeddingRepresentation>
  /** Selectable vector widths. */
  readonly dimensions: EmbeddingCapability<readonly number[]>
  /** Width used when the caller requests none. */
  readonly defaultDimensions: EmbeddingCapability<number>
  /** Per-input token ceiling. Only a `supported` value may reject an input. */
  readonly maxInputTokens: EmbeddingCapability<number>
  /** Items accepted in one physical batch. */
  readonly maxBatchItems: EmbeddingCapability<number>
  /** Estimated tokens accepted in one physical batch. */
  readonly maxBatchTokens: EmbeddingCapability<number>
  /** Payload bytes accepted in one physical batch. */
  readonly maxBatchBytes: EmbeddingCapability<number>
  /** How the route expresses purpose on the wire. */
  readonly purposeHandling: EmbeddingCapability<EmbeddingPurposeHandling>
  /** Whether vectors arrive normalized. Never inferred from dimension count. */
  readonly normalization: EmbeddingCapability<EmbeddingNormalization>
  /** The provider's own declaration about the embedding space. */
  readonly compatibilityIdentity: EmbeddingCapability<string>
}

/** Exact-route embedding metadata, resolved by the adapter that owns the route. */
export interface ResolvedEmbeddingModelInfo extends EmbeddingModelInfo {
  /** Provider-declared model revision, when the route exposes one. */
  readonly modelRevision?: string
}

/**
 * The minimal descriptor for an id the catalog does not describe: identity only,
 * every capability `unknown`.
 *
 * This is what keeps an unlisted model id usable (Requirement 10.3). Consumers
 * then split by intent: validation must NOT reject on `unknown`, while batching
 * falls back to `EMBEDDING_BATCH_DEFAULTS` so memory stays bounded (DD-6).
 */
export function unknownEmbeddingModel(
  provider: string,
  model: string,
): ResolvedEmbeddingModelInfo {
  return {
    provider,
    id: model,
    name: model,
    inputTypes: UNKNOWN,
    representation: UNKNOWN,
    dimensions: UNKNOWN,
    defaultDimensions: UNKNOWN,
    maxInputTokens: UNKNOWN,
    maxBatchItems: UNKNOWN,
    maxBatchTokens: UNKNOWN,
    maxBatchBytes: UNKNOWN,
    purposeHandling: UNKNOWN,
    normalization: UNKNOWN,
    compatibilityIdentity: UNKNOWN,
  }
}
