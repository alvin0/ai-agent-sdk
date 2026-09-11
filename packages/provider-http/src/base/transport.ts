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
    inputModalities: model.inputModalities ?? ['text'],
    ...(model.outputModalities === undefined ? {} : { outputModalities: model.outputModalities }),
    ...(model.nativeTools === undefined ? {} : { nativeTools: model.nativeTools }),
  }
}

/** Resolve exact metadata from an advisory catalog without opening a connection. */
export function resolvedCatalogModelInfo(
  provider: string,
  modelId: string,
  models: readonly ProviderCatalogModel[],
  defaultMaxTokens: number,
  defaultContextWindow: number,
): ResolvedModelInfo {
  const configured = models.find(entry => entry.id === modelId)
  return {
    ...(configured === undefined
      ? { provider, id: modelId, name: modelId, inputModalities: ['text' as const] }
      : catalogModelInfo(provider, configured)),
    context: { contextWindow: configured?.contextWindow ?? defaultContextWindow },
    defaultMaxTokens: configured?.maxTokens ?? defaultMaxTokens,
    maxOutputTokens: configured?.maxTokens ?? defaultMaxTokens,
    ...(configured?.reasoning === undefined ? {} : { reasoning: configured.reasoning }),
    ...(configured?.outputModalities === undefined ? {} : { outputModalities: configured.outputModalities }),
  }
}
