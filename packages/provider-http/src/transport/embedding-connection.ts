/**
 * Embedding's half of a connection snapshot, plus the one translation from a
 * declared route catalog into `Embedding_Catalog` capabilities.
 *
 * This module sits on top of {@link HttpTransportConnection} rather than inside
 * it: the transport and the JSON pipeline know nothing about embedding
 * vocabulary, and they must not, or a second pipeline could not exist without
 * dragging the first one's catalog along. What embedding adds is a catalog with
 * its own semantics — vector widths, batch ceilings, purpose handling, and a
 * declaration about which embedding space the vectors belong to.
 *
 * The translation rule has exactly one shape and it runs in one direction: a
 * field the configuration DECLARES becomes `supported`, a field it OMITS becomes
 * `unknown` (Requirement 10.5). Nothing here manufactures a `supported` value
 * from a default, because a default is the SDK's opinion, not the route's claim,
 * and `unknown` is never a reason to reject a request.
 *
 * Two things are deliberately NOT here:
 *
 *  - Cleartext HTTP handling. `EmbeddingHttpConnection` extends the transport
 *    snapshot, so `allowInsecureHttp` is the same field the same `endpointUrl()`
 *    already enforces for generation — a self-hosted `http://` endpoint is
 *    rejected unless the caller opts in explicitly, and embedding gets that for
 *    free rather than through a second copy of the rule (Requirement 15.5).
 *  - The generation catalog. `models`, `defaultMaxTokens` and
 *    `defaultContextWindow` stay on `HttpConnection`; folding the two catalogs
 *    into one shape is the conflation Requirement 10.1 rules out.
 *
 * @module ai-agent-sdk/providers/transport/embedding-connection
 */

import {
  type EmbeddingCapability,
  type EmbeddingModelInfo,
  type EmbeddingNormalization,
  type EmbeddingPurposeHandling,
  type ResolvedEmbeddingModelInfo,
  unknownEmbeddingModel,
} from '@alvin0/ai-agent-sdk-core/embedding'
import type { HttpTransportConnection } from './connection.ts'

/**
 * One embedding model an HTTP route declares.
 *
 * Every capability field is optional but one: {@link compatibilityIdentity}. A
 * vector is only meaningful next to another vector from the same space, and no
 * amount of matching dimension counts establishes that. Requiring the claim in
 * the type means a self-hosted "OpenAI-compatible" endpoint is a tested profile
 * someone declared, not an assumption drawn from the endpoint having an
 * `/embeddings` path (Requirement 15.3).
 */
export interface EmbeddingCatalogModel {
  /** Wire model id, passed to the provider verbatim. */
  readonly id: string
  /** Selector label; defaults to {@link id}. */
  readonly name?: string
  /** Optional detail distinguishing similar variants. */
  readonly description?: string
  /** Selectable vector widths this route accepts. */
  readonly dimensions?: readonly number[]
  /** Width used when the caller requests none. */
  readonly defaultDimensions?: number
  /** Per-input token ceiling. Only a declared value may reject an input. */
  readonly maxInputTokens?: number
  /** Items accepted in one physical batch. */
  readonly maxBatchItems?: number
  /** Estimated tokens accepted in one physical batch. */
  readonly maxBatchTokens?: number
  /** Payload bytes accepted in one physical batch. */
  readonly maxBatchBytes?: number
  /**
   * How this route expresses purpose on the wire.
   *
   * `'unsupported'` is the positive negative claim — the route states it has no
   * mechanism, which is what OpenAI's embeddings API is — and it is distinct
   * from omitting the field, which claims nothing. Either way the adapter sends
   * the text verbatim and never invents an undocumented prefix.
   */
  readonly purposeHandling?: EmbeddingPurposeHandling | 'unsupported'
  /** Whether vectors arrive normalized. Never inferred from dimension count. */
  readonly normalization?: EmbeddingNormalization
  /**
   * The route's explicit declaration about the embedding space.
   *
   * Required, including for a self-hosted endpoint. Models sharing a declared
   * space share this string; a new model generation gets a new one even when the
   * vector width is unchanged.
   */
  readonly compatibilityIdentity: string
}

/**
 * Everything needed to issue ONE embedding request, captured as a single snapshot.
 *
 * The transport half — endpoint, headers, bounds, cleartext opt-in, retry
 * policy — is {@link HttpTransportConnection} and is shared with the generation
 * pipeline verbatim. Both `OpenAI_Embedding_Adapter` and
 * `Gemini_Embedding_Adapter` are configured through this one shape.
 */
export interface EmbeddingHttpConnection extends HttpTransportConnection {
  /** Advisory catalog; requests are never restricted to it. */
  readonly models: readonly EmbeddingCatalogModel[]
}

/** The `unknown` capability, shared so translations need not re-allocate it. */
const UNKNOWN: EmbeddingCapability<never> = Object.freeze({ state: 'unknown' })

/** The `unsupported` capability, for a route's positive negative claim. */
const UNSUPPORTED: EmbeddingCapability<never> = Object.freeze({ state: 'unsupported' })

/** Declared value becomes `supported`; omission stays `unknown`. */
function declared<T>(value: T | undefined): EmbeddingCapability<T> {
  return value === undefined ? UNKNOWN : Object.freeze({ state: 'supported' as const, value })
}

/** The one place `'unsupported'` is separated from an omitted declaration. */
function declaredPurpose(
  value: EmbeddingCatalogModel['purposeHandling'],
): EmbeddingCapability<EmbeddingPurposeHandling> {
  if (value === undefined) return UNKNOWN
  return value === 'unsupported' ? UNSUPPORTED : Object.freeze({ state: 'supported', value })
}

/**
 * Translate one declared catalog entry into `Embedding_Catalog` metadata.
 *
 * `inputTypes` and `representation` come out `unknown` rather than filled in
 * from the v1 scope: the scope is already readable from the types
 * (`EmbeddingInputType` is `'text'`, `EmbeddingRepresentation` is
 * `'dense-float32'`), and stating `supported` on the route's behalf would be
 * the SDK asserting a claim the route never made.
 * @param provider - route that owns the entry.
 * @param model - the declared catalog entry.
 * @returns advisory embedding metadata for this entry.
 */
export function embeddingCatalogModelInfo(
  provider: string,
  model: EmbeddingCatalogModel,
): EmbeddingModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputTypes: UNKNOWN,
    representation: UNKNOWN,
    dimensions: declared(model.dimensions),
    defaultDimensions: declared(model.defaultDimensions),
    maxInputTokens: declared(model.maxInputTokens),
    maxBatchItems: declared(model.maxBatchItems),
    maxBatchTokens: declared(model.maxBatchTokens),
    maxBatchBytes: declared(model.maxBatchBytes),
    purposeHandling: declaredPurpose(model.purposeHandling),
    normalization: declared(model.normalization),
    compatibilityIdentity: declared(model.compatibilityIdentity),
  }
}

/**
 * Resolve exact embedding metadata for a model id from an advisory catalog.
 *
 * An id the catalog does not describe stays usable: the caller gets an
 * identity-only descriptor with every capability `unknown` and the provider
 * decides (Requirement 10.3). The catalog restricting the request would make
 * membership authoritative, which it is not.
 * @param provider - route being resolved.
 * @param modelId - requested model id.
 * @param models - the route's declared catalog.
 * @returns exact metadata for the id, or the identity-only descriptor.
 */
export function resolvedEmbeddingCatalogModelInfo(
  provider: string,
  modelId: string,
  models: readonly EmbeddingCatalogModel[],
): ResolvedEmbeddingModelInfo {
  const configured = models.find(entry => entry.id === modelId)
  if (configured === undefined) return unknownEmbeddingModel(provider, modelId)
  return embeddingCatalogModelInfo(provider, configured)
}
