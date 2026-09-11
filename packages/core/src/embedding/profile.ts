/**
 * `Embedding_Profile` and the derived `Space_Id`.
 *
 * Two vectors with the same dimension count are NOT compatible for that reason
 * alone. This module owns the one place where compatibility is decided.
 *
 * @module ai-agent-sdk/core/embedding/profile
 */

import type { ResolvedEmbeddingModelInfo } from './catalog.ts'

/** Output representation of a vector. v1 declares exactly one. */
export type EmbeddingRepresentation = 'dense-float32'

/**
 * Whether vectors arrive normalized.
 *
 * `'unknown'` is a first-class value: a route that has not documented its
 * normalization must say so rather than have `'none'` assumed for it.
 */
export type EmbeddingNormalization = 'unit-l2' | 'none' | 'unknown'

/** Post-processing is version-managed; it is never an implicit slice or pad. */
export interface EmbeddingPostProcessing {
  readonly kind: 'l2-renormalize'
  readonly revision: string
}

/** Everything about one call configuration that a vector's meaning depends on. */
export interface EmbeddingProfile {
  /** `${route}:${modelId}` — a model identity, NOT a space identity. */
  readonly modelIdentity: string
  readonly modelRevision?: string
  readonly dimensions: number
  readonly representation: EmbeddingRepresentation
  readonly normalization: EmbeddingNormalization
  readonly postProcessing?: EmbeddingPostProcessing
  /** Recorded for traceability; excluded from the `Space_Id` derivation (DD-7). */
  readonly documentRecipeRevision: string
  /** Recorded for traceability; excluded from the `Space_Id` derivation (DD-7). */
  readonly queryRecipeRevision: string
  /** The provider's declaration about the embedding space. Declared by adapter/route. */
  readonly compatibilityIdentity: string
  readonly profileRevision: string
}

/** Canonical identifier of an embedding space. */
export type EmbeddingSpaceId = string & { readonly __brand: 'EmbeddingSpaceId' }

/**
 * Call configuration a caller supplies on top of resolved catalog metadata.
 *
 * Every field is optional: an adapter that knows nothing beyond the model id
 * still gets a usable profile out of {@link defaultEmbeddingProfile}.
 */
export interface EmbeddingProfileInput {
  /** Requested dimensions; absent means the model default. */
  readonly dimensions?: number
  /** Revision of the rule turning a document's content parts into wire input. */
  readonly documentRecipeRevision?: string
  /** Revision of the rule turning a query's content parts into wire input. */
  readonly queryRecipeRevision?: string
  /** Bumped when any profile-affecting configuration changes. */
  readonly profileRevision?: string
}

/** Version prefix of the canonical `Space_Id` string. */
const SPACE_ID_VERSION = 'emb:1'

/** Revision used when the caller declares none. */
const DEFAULT_REVISION = '1'

/**
 * Dimensions recorded when neither the caller nor the catalog declares a count.
 *
 * `0` is not a legal vector width, so it cannot collide with a real declaration.
 */
const UNDECLARED_DIMENSIONS = 0

/**
 * Escapes `|` and `\` so no two distinct component tuples can join to the same
 * string.
 */
function escapeComponent(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/** The post-processing component, present or explicitly absent. */
function postProcessingComponent(
  postProcessing: EmbeddingPostProcessing | undefined,
): string {
  if (postProcessing === undefined) return 'none'
  return `${escapeComponent(postProcessing.kind)}:${escapeComponent(postProcessing.revision)}`
}

/** The exact component tuple that decides space identity, in fixed order. */
function spaceComponents(profile: EmbeddingProfile): readonly string[] {
  return [
    escapeComponent(profile.compatibilityIdentity),
    String(profile.dimensions),
    escapeComponent(profile.representation),
    escapeComponent(profile.normalization),
    postProcessingComponent(profile.postProcessing),
    escapeComponent(profile.profileRevision),
  ]
}

/**
 * Derives the `Space_Id` from what decides whether two vectors are comparable.
 *
 * SYNCHRONOUS and UNHASHED: a `Space_Id` is a canonical string, not a digest.
 * It is an identifier for comparison, not a secret to hide, so no hash function
 * is needed and `packages/core` takes on no `crypto.subtle` dependency (DD-11).
 * Being synchronous, `prepareEmbeddingCall` calls it directly without `await`.
 *
 * Format: `emb:1|{compatibilityIdentity}|{dimensions}|{representation}|
 * {normalization}|{postProcessing.kind}:{postProcessing.revision}|{profileRevision}`,
 * where each component has `|` and `\` escaped before joining, so two different
 * component tuples cannot produce the same string.
 *
 * NOTE: `documentRecipeRevision` and `queryRecipeRevision` are recorded on the
 * profile but take NO part in the derivation. That is exactly what puts a query
 * and a document in the same `Space_Id` when they share a retrieval profile.
 */
export function deriveSpaceId(profile: EmbeddingProfile): EmbeddingSpaceId {
  return [SPACE_ID_VERSION, ...spaceComponents(profile)].join('|') as EmbeddingSpaceId
}

/**
 * Space compatibility is its own concept: decided by the declared compatibility
 * identity, independent of comparing model names and independent of comparing
 * dimension counts.
 */
export function isSpaceCompatible(a: EmbeddingProfile, b: EmbeddingProfile): boolean {
  const left = spaceComponents(a)
  const right = spaceComponents(b)
  return left.every((component, index) => component === right[index])
}

/**
 * A usable default for `EmbeddingAdapter.embeddingProfile()`: compatibility
 * identity derived from `${route}:${modelId}` when the catalog declares none,
 * normalization `'unknown'`, no post-processing. This default is what keeps
 * `EmbeddingAdapter` at exactly one abstract method (Requirement 1.2); an adapter
 * that knows what its provider declares about the embedding space MUST override
 * to state the real identity.
 */
export function defaultEmbeddingProfile(
  model: ResolvedEmbeddingModelInfo,
  request: EmbeddingProfileInput,
): EmbeddingProfile {
  const modelIdentity = `${model.provider}:${model.id}`
  const compatibilityIdentity =
    model.compatibilityIdentity.state === 'supported'
      ? model.compatibilityIdentity.value
      : modelIdentity
  const representation =
    model.representation.state === 'supported'
      ? model.representation.value
      : 'dense-float32'
  const declaredDefault =
    model.defaultDimensions.state === 'supported'
      ? model.defaultDimensions.value
      : undefined

  return {
    modelIdentity,
    ...(model.modelRevision === undefined ? {} : { modelRevision: model.modelRevision }),
    dimensions: request.dimensions ?? declaredDefault ?? UNDECLARED_DIMENSIONS,
    representation,
    // Never inferred from the dimension count or the provider's reputation.
    normalization: 'unknown',
    documentRecipeRevision: request.documentRecipeRevision ?? DEFAULT_REVISION,
    queryRecipeRevision: request.queryRecipeRevision ?? DEFAULT_REVISION,
    compatibilityIdentity,
    profileRevision: request.profileRevision ?? DEFAULT_REVISION,
  }
}
