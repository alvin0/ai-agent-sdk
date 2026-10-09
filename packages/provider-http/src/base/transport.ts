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
  const routeContextWindow = routeWindowFor(configured, defaultContextWindow)
  const info = applyModelContextPolicy({
    ...(configured === undefined
      ? { provider, id: modelId, name: modelId }
      : catalogModelInfo(provider, configured)),
    ...(configured?.maxTokens === undefined ? {} : { maxOutputTokens: configured.maxTokens }),
    ...(configured?.reasoning === undefined ? {} : { reasoning: configured.reasoning }),
    ...(configured?.outputModalities === undefined ? {} : { outputModalities: configured.outputModalities }),
    // The ROUTE's own configured fallback rides as `context.defaultContextWindow`
    // rather than as `providerOverride` below, so a model's own (softer)
    // `defaultContextWindow` still outranks it — only the model's exact
    // `contextWindow` outranks the route. Omitted entirely when the route names
    // none, so `applyModelContextPolicy` sees a genuine absence, not a guess.
    ...(routeContextWindow === undefined ? {} : { context: { defaultContextWindow: routeContextWindow } }),
  }, undefined, configured)
  // A dropped fallback leaves the window unknown, so nothing shows the ceiling
  // leaves input headroom; it then bounds the default as a window would, and
  // only a route default below it stands in per request.
  const fallbackDropped = routeContextWindow === undefined && defaultContextWindow !== undefined
  const resolvedMaxTokens = configured?.defaultMaxTokens ?? inheritedMaxTokens(configured?.maxTokens,
    defaultMaxTokens, fallbackDropped ? configured?.maxTokens : info.context?.contextWindow)
  return resolvedMaxTokens === undefined ? info : { ...info, defaultMaxTokens: resolvedMaxTokens }
}

/**
 * The route's fallback window for one model.
 *
 * The fallback is shared by every model on the route; a model's own declared
 * ceiling is the more specific fact, so the fallback yields to it instead of
 * failing. An explicit `contextWindow`/`defaultContextWindow` is never clamped.
 * A model that declares no window at all but an output ceiling or default the fallback
 * cannot hold with input to spare proves that fallback wrong for it: it is
 * dropped, leaving the window to the registry's own defaults rather than
 * failing every call on a guess the model never made.
 */
function routeWindowFor(configured: ProviderCatalogModel | undefined, fallback?: number): number | undefined {
  if (fallback === undefined || configured === undefined) return fallback
  if (configured.maxContextWindow !== undefined) {
    const clamped = Math.min(fallback, configured.maxContextWindow)
    // A model's explicit per-request default is a fact the route cannot
    // overrule; when the clamped fallback cannot hold it, its own ceiling does.
    const ownDefault = configured.defaultMaxTokens
    return ownDefault !== undefined && ownDefault >= clamped && ownDefault < configured.maxContextWindow
      ? configured.maxContextWindow
      : clamped
  }
  const declaresWindow = configured.contextWindow !== undefined || configured.defaultContextWindow !== undefined
  const declaredOutput = Math.max(configured.maxTokens ?? 0, configured.defaultMaxTokens ?? 0)
  if (!declaresWindow && declaredOutput >= fallback) return undefined
  return fallback
}

/**
 * A legacy catalog `maxTokens` doubles as the per-request default, but only
 * while it still leaves input headroom: a model whose output ceiling fills its
 * operating window falls back to the route default, else names none at all.
 */
function inheritedMaxTokens(ceiling?: number, routeDefault?: number, contextWindow?: number): number | undefined {
  const fits = (value?: number): value is number =>
    value !== undefined && (contextWindow === undefined || value < contextWindow)
  if (ceiling !== undefined && fits(ceiling)) return ceiling
  // The route's default is shared by every model on it, so it too must fit.
  return fits(routeDefault) ? routeDefault : undefined
}
