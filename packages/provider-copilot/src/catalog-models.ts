import type { ModelModality } from '@alvin0/ai-agent-sdk-core/provider'
import type {
  CopilotEndpoint, WireCopilotModel, CopilotGenerationModel, CopilotEmbeddingModel,
} from './catalog-types.ts'

/** Modalities claimed when — and only when — a vision signal was actually present. */
export const TEXT_AND_IMAGE: readonly ModelModality[] = Object.freeze(['text', 'image'])

/**
 * Translate one `type: 'chat'` entry, filling only what the endpoint supplied.
 *
 * `name` is not defaulted to `id`: a display label the endpoint did not send is a
 * label this layer would be inventing, and the layer that renders a selector
 * already falls back to the id.
 */
export function generationModel(id: string, entry: WireCopilotModel): CopilotGenerationModel {
  const limits = entry.capabilities?.limits
  const supports = entry.capabilities?.supports
  const vision = entry.vision === true || supports?.vision === true
  return Object.freeze({
    model: Object.freeze({
      id,
      ...(hasDisplayName(entry.name) ? { name: entry.name } : {}),
      ...generationCapacity(limits),
      // No vision signal ⇒ ABSENT. `['text']` would be a negative claim about
      // image input that the endpoint never made.
      ...(vision ? { inputModalities: TEXT_AND_IMAGE } : {}),
    }),
    declaredEndpoint: declaredEndpointOf(supports),
  })
}

/** Translate one `type: 'embeddings'` entry, under the same fill-only-what-was-said rule. */
export function embeddingModel(id: string, entry: WireCopilotModel): CopilotEmbeddingModel {
  const capabilities = entry.capabilities
  const limits = capabilities?.limits
  const dimensions = capabilities?.supports?.dimensions
  const family = capabilities?.family
  return Object.freeze({
    id,
    ...(hasDisplayName(entry.name) ? { name: entry.name } : {}),
    ...(hasDisplayName(family)
      ? { family }
      : {}),
    ...embeddingCapacity(limits),
    ...(typeof dimensions === 'boolean' ? { supportsDimensions: dimensions } : {}),
  })
}

/**
 * Read the endpoint disclosure, and only a disclosure.
 *
 * `supports.responses === true` says `/responses`; `false` says `/chat/completions`
 * — the endpoint stated something either way. Anything else, including the field
 * being absent or holding a non-boolean, is UNKNOWN and stays `undefined`, which
 * is a different state from "not supported" (Requirement 8.6).
 */
export function declaredEndpointOf(
  supports: Readonly<Record<string, unknown>> | undefined,
): CopilotEndpoint | undefined {
  const responses = supports?.responses
  if (responses === true) return 'responses'
  if (responses === false) return 'chat-completions'
  return undefined
}

/** Accept a numeric metadata field only when it can serve as a capacity. */
export function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function hasDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function generationCapacity(limits: NonNullable<WireCopilotModel['capabilities']>['limits']) {
  const contextWindow = positiveInteger(limits?.max_context_window_tokens)
  const maxTokens = positiveInteger(limits?.max_output_tokens)
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
  }
}

function embeddingCapacity(limits: NonNullable<WireCopilotModel['capabilities']>['limits']) {
  const maxInputTokens = positiveInteger(limits?.max_context_window_tokens)
  const maxInputs = positiveInteger(limits?.max_inputs)
  return {
    ...maxInputTokens === undefined ? {} : { maxInputTokens },
    ...maxInputs === undefined ? {} : { maxInputs },
  }
}
