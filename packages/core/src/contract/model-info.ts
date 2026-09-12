/**
 * Metadata an adapter reports about the routes and models it serves.
 *
 * @module ai-agent-sdk/core/contract/model-info
 */

import type { ReasoningEffortId } from '../primitives/brand.ts'
import type { NativeToolName } from './tool.ts'
import type { SupportSafeError } from '../support-safe/error.ts'

/** Display metadata for one registered provider route. */
export interface ProviderInfo {
  /** Route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}

/** Merge-extensible model input-modality vocabulary. */
export interface ModelModalityMap {
  text: 'text'
  image: 'image'
  document: 'document'
}

/** Any declared model input modality. */
export type ModelModality = ModelModalityMap[keyof ModelModalityMap]

/**
 * One model an adapter can advertise.
 *
 * Catalog membership is ADVISORY. An adapter may accept an id it does not list —
 * new models ship faster than this package can — so a consumer must never turn
 * absence from this list into a request rejection.
 */
export interface ModelInfo {
  /** Provider route that owns this entry. */
  provider: string
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string
  /** Human-readable name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string
  /**
   * Accepted request modalities.
   *
   * Absent means UNKNOWN; an explicit list that omits a modality is a negative
   * capability claim, and the registry acts on it by projecting images and
   * documents to text.
   */
  inputModalities?: readonly ModelModality[]
  /** Modalities this model route may return, directly or through native tools. */
  outputModalities?: readonly ModelModality[]
  /** Provider-native tools explicitly supported; omission means unknown. */
  nativeTools?: readonly NativeToolName[]
}

/** Provider-owned context capacity for one exact model route. */
export interface ModelContext {
  /** Operating budget for combined request and response tokens. */
  contextWindow: number
  /** Known technical ceiling, independent of the operating budget. */
  maxContextWindow?: number
  /** Provider/model operating default before an explicit override. */
  defaultContextWindow?: number
  /** Input-token threshold above which long-context pricing may apply. */
  standardPriceInputTokens?: number
  /** Advisory warning, not a prediction of actual billed token counts. */
  pricingWarning?: 'extended-context-may-cost-more'
}

/** Display metadata for one adapter-owned reasoning effort. */
export interface ReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId
  /** Human-readable effort name. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}

/** Selectable reasoning efforts for one exact model route. */
export interface ModelReasoningInfo {
  /** Supported efforts, in adapter-preferred display order. */
  efforts: readonly ReasoningEffortInfo[]
  /**
   * Effort materialized into requests when the caller omits one.
   * Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId
}

/** Exact-route model metadata, resolved by the adapter that owns the route. */
export interface ResolvedModelInfo extends ModelInfo {
  /** Provider-owned context capacity, when known. */
  context?: ModelContext
  /** Per-request output cap materialized when the caller omits one. */
  defaultMaxTokens?: number
  /** Hard provider/model output ceiling; explicit requests above it are rejected. */
  maxOutputTokens?: number
  /** Selectable reasoning levels, when the route exposes any. */
  reasoning?: ModelReasoningInfo
}

export type ModelCatalogState = 'static' | 'fresh' | 'empty' | 'stale' | 'unavailable'

export interface ModelCatalogOptions {
  readonly signal?: AbortSignal
  readonly refresh?: 'if-stale' | 'force'
}

export interface ModelCatalogSnapshot {
  readonly provider: ProviderInfo
  readonly state: ModelCatalogState
  readonly revision: string
  readonly models: readonly ModelInfo[]
  readonly observedAt: string
  readonly expiresAt?: string
  readonly retryAt?: string
  readonly error?: SupportSafeError
}
