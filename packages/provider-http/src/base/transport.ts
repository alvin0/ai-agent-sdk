/**
 * Generation's transport facade: the catalog helpers, plus the shared primitives
 * at the path existing callers already import.
 *
 * The pipeline-independent half moved to {@link ../transport/http} and
 * {@link ../transport/limits} when the transport layer was split out, so a second
 * pipeline could reuse it without importing the generation pipeline. What stays
 * here is what genuinely belongs to generation: turning an advisory model catalog
 * into model metadata.
 *
 * @module ai-agent-sdk/providers/base/transport
 */

import type { ModelInfo, ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import type { ProviderCatalogModel } from './http-adapter.ts'
import { applyModelContextPolicy } from './context-policy.ts'

/** Shared HTTP primitives live in the transport; re-exported for existing callers. */
export {
  abortError,
  boundedResponseBody,
  cancelResponseBody,
  endpointUrl,
  raceWithSignal,
  readBoundedText,
  redactHeaders,
  rejectProviderRedirect,
  requestLogId,
  safeProviderFailure,
  withAbortSignal,
} from '../transport/http.ts'
/** Bound validation belongs to the transport limits module; re-exported for existing callers. */
export { positiveFinite, positiveInteger } from '../transport/limits.ts'

export function catalogModelInfo(provider: string, model: ProviderCatalogModel): ModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    // Absent, not defaulted to `['text']`: an unconfigured modality is UNKNOWN,
    // not a negative capability claim, and the registry fills the SDK's own
    // permissive default (text + image + document) — see RuntimeDefaults.
    ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
    ...(model.outputModalities === undefined ? {} : { outputModalities: model.outputModalities }),
    ...(model.nativeTools === undefined ? {} : { nativeTools: model.nativeTools }),
  }
}

/**
 * Resolve exact metadata from an advisory catalog without opening a connection.
 *
 * `defaultMaxTokens`/`defaultContextWindow` are the ROUTE's own configured
 * fallbacks (an adapter's `defaultMaxTokens`/`defaultContextWindow` options),
 * not an invented number — omit them and, absent a model-level value too, the
 * field is left off `ResolvedModelInfo` entirely so the registry's own
 * RuntimeDefaults/SDK-constant tier can fill it instead of this adapter guessing.
 */
export function resolvedCatalogModelInfo(
  provider: string,
  modelId: string,
  models: readonly ProviderCatalogModel[],
  defaultMaxTokens?: number,
  defaultContextWindow?: number,
): ResolvedModelInfo {
  const configured = models.find(entry => entry.id === modelId)
  const resolvedMaxTokens = configured?.defaultMaxTokens ?? configured?.maxTokens ?? defaultMaxTokens
  return applyModelContextPolicy({
    ...(configured === undefined
      ? { provider, id: modelId, name: modelId }
      : catalogModelInfo(provider, configured)),
    ...(resolvedMaxTokens === undefined ? {} : { defaultMaxTokens: resolvedMaxTokens }),
    ...(configured?.maxTokens === undefined ? {} : { maxOutputTokens: configured.maxTokens }),
    ...(configured?.reasoning === undefined ? {} : { reasoning: configured.reasoning }),
    ...(configured?.outputModalities === undefined ? {} : { outputModalities: configured.outputModalities }),
    // The ROUTE's own configured fallback rides as `context.defaultContextWindow`
    // rather than as `providerOverride` below, so a model's own (softer)
    // `defaultContextWindow` still outranks it — only the model's exact
    // `contextWindow` outranks the route. Omitted entirely when the route names
    // none, so `applyModelContextPolicy` sees a genuine absence, not a guess.
    ...(defaultContextWindow === undefined ? {} : { context: { defaultContextWindow } }),
  }, undefined, configured)
}
