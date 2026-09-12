import type { ModelAdapter } from '../contract/adapter.ts'
import type { CallConfig } from '../contract/call-config.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import type {
  ModelCatalogSnapshot,
  ModelContext,
  ModelInfo,
  ResolvedModelInfo,
} from '../contract/model-info.ts'
import { ModelError, REGISTRY_ERROR_CODES } from '../errors/model-error.ts'
import { freezeMessage, type Message } from '../message/message.ts'
import { deepFreeze } from '../primitives/freeze.ts'

export function validateCatalogModels(
  provider: string,
  models: readonly ModelInfo[],
  maxModels: number,
  maxBytes: number,
): ModelInfo[] {
  if (!Array.isArray(models)) {
    throw new ModelError(
      `route "${provider}" returned a catalog that is not an array`,
      REGISTRY_ERROR_CODES.INVALID_CATALOG,
    )
  }
  if (models.length > maxModels
    || serializedBytes(models, REGISTRY_ERROR_CODES.INVALID_CATALOG) > maxBytes) {
    throw new ModelError(
      `route "${provider}" catalog exceeds the configured registry limit`,
      REGISTRY_ERROR_CODES.INVALID_CATALOG,
    )
  }
  const seen = new Set<string>()
  return models.map((model) => {
    if (model.provider !== provider || typeof model.id !== 'string' || model.id.length === 0
      || typeof model.name !== 'string' || model.name.length === 0) {
      throw new ModelError(
        `route "${provider}" advertised a model entry with invalid identity`,
        REGISTRY_ERROR_CODES.INVALID_CATALOG,
      )
    }
    if (seen.has(model.id)) {
      throw new ModelError(
        `route "${provider}" advertised model "${model.id}" more than once`,
        REGISTRY_ERROR_CODES.INVALID_CATALOG,
      )
    }
    seen.add(model.id)
    return structuredClone(model)
  })
}

export function validateModelCatalogSnapshot(
  provider: string,
  snapshot: ModelCatalogSnapshot,
  maxModels: number,
  maxBytes: number,
): ModelCatalogSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null
    || snapshot.provider?.id !== provider || typeof snapshot.provider.name !== 'string'
    || snapshot.provider.name.length === 0
    || !['static', 'fresh', 'empty', 'stale', 'unavailable'].includes(snapshot.state)
    || typeof snapshot.revision !== 'string' || snapshot.revision.length === 0
    || typeof snapshot.observedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw new ModelError(
      `route "${provider}" returned an invalid catalog snapshot`,
      REGISTRY_ERROR_CODES.INVALID_CATALOG,
    )
  }
  const models = validateCatalogModels(provider, snapshot.models, maxModels, maxBytes)
  return deepFreeze({ ...structuredClone(snapshot), provider: { ...snapshot.provider }, models })
}

export function normalizeResolvedModelInfo(
  provider: string,
  model: string,
  info: ResolvedModelInfo,
  maxBytes: number,
): ResolvedModelInfo {
  if (info.provider !== provider || info.id !== model
    || typeof info.name !== 'string' || info.name.length === 0) {
    throw invalidModel(provider, model, 'mismatched identity')
  }
  if (info.context !== undefined
    && (!Number.isSafeInteger(info.context.contextWindow) || info.context.contextWindow <= 0)) {
    throw invalidModel(provider, model, 'a non-positive context window')
  }
  if (info.defaultMaxTokens !== undefined
    && (!Number.isSafeInteger(info.defaultMaxTokens) || info.defaultMaxTokens <= 0)) {
    throw invalidModel(provider, model, 'a non-positive defaultMaxTokens')
  }
  for (const value of [info.context?.maxContextWindow, info.context?.defaultContextWindow, info.context?.standardPriceInputTokens]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw invalidModel(provider, model, 'invalid context policy')
    }
  }
  if (info.context?.maxContextWindow !== undefined && (
    info.context.contextWindow > info.context.maxContextWindow
    || (info.context.defaultContextWindow ?? 0) > info.context.maxContextWindow
  )) throw invalidModel(provider, model, 'contextWindow above maxContextWindow')
  if (info.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(info.maxOutputTokens) || info.maxOutputTokens <= 0)) {
    throw invalidModel(provider, model, 'a non-positive maxOutputTokens')
  }
  if (info.defaultMaxTokens !== undefined && info.maxOutputTokens !== undefined
    && info.defaultMaxTokens > info.maxOutputTokens) {
    throw invalidModel(provider, model, 'defaultMaxTokens above maxOutputTokens')
  }
  if (info.context !== undefined && info.defaultMaxTokens !== undefined
    && info.defaultMaxTokens >= info.context.contextWindow) {
    throw invalidModel(provider, model, 'no input headroom')
  }
  if (info.context !== undefined && info.maxOutputTokens !== undefined
    && info.maxOutputTokens >= (info.context.maxContextWindow ?? info.context.contextWindow)) {
    throw invalidModel(provider, model, 'no input headroom')
  }
  validateReasoning(provider, model, info)
  validateCapabilities(provider, model, info)
  const normalized = deepFreeze(structuredClone({
    ...info,
    ...(info.inputModalities === undefined ? {} : { inputModalities: [...info.inputModalities] }),
    ...(info.outputModalities === undefined ? {} : { outputModalities: [...info.outputModalities] }),
    ...(info.nativeTools === undefined ? {} : { nativeTools: [...info.nativeTools] }),
  }))
  if (serializedBytes(normalized, REGISTRY_ERROR_CODES.INVALID_MODEL_INFO) > maxBytes) {
    throw new ModelError(
      `route "${provider}" model metadata exceeds the configured registry limit`,
      REGISTRY_ERROR_CODES.INVALID_MODEL_INFO,
    )
  }
  return normalized
}

function validateReasoning(provider: string, model: string, info: ResolvedModelInfo): void {
  if (info.reasoning === undefined) return
  const ids = info.reasoning.efforts.map(effort => effort.id)
  if (ids.length === 0 || new Set(ids).size !== ids.length
    || info.reasoning.efforts.some(effort =>
      typeof effort.id !== 'string' || effort.id.length === 0
      || typeof effort.name !== 'string' || effort.name.length === 0)) {
    throw invalidModel(provider, model, 'empty or duplicated reasoning efforts')
  }
  if (info.reasoning.defaultEffort !== undefined
    && !ids.includes(info.reasoning.defaultEffort)) {
    throw invalidModel(provider, model, 'a default reasoning effort it does not offer')
  }
}

function validateCapabilities(provider: string, model: string, info: ResolvedModelInfo): void {
  for (const [label, values] of [
    ['input modalities', info.inputModalities],
    ['output modalities', info.outputModalities],
    ['native tools', info.nativeTools],
  ] as const) {
    if (values !== undefined
      && (new Set(values).size !== values.length
        || values.some(value => typeof value !== 'string' || value.length === 0))) {
      throw invalidModel(provider, model, `invalid ${label}`)
    }
  }
}

function invalidModel(provider: string, model: string, reason: string): ModelError {
  return new ModelError(
    `route "${provider}" resolved model "${model}" with ${reason}`,
    REGISTRY_ERROR_CODES.INVALID_MODEL_INFO,
  )
}

export function resolveCallWithModelInfo(
  config: CallConfig,
  info: ResolvedModelInfo,
): { readonly config: CallConfig; readonly context: ModelContext | undefined } {
  const reasoningEffort = config.reasoningEffort ?? info.reasoning?.defaultEffort
  if (config.reasoningEffort !== undefined
    && info.reasoning?.efforts.some(effort => effort.id === config.reasoningEffort) !== true) {
    throw new ModelError(
      `model "${info.id}" on route "${info.provider}" does not offer reasoning effort `
      + `"${config.reasoningEffort}"`,
      REGISTRY_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT,
    )
  }
  const maxTokens = config.maxTokens ?? info.defaultMaxTokens
  if (maxTokens !== undefined && info.maxOutputTokens !== undefined
    && maxTokens > info.maxOutputTokens) {
    throw new ModelError(
      `model "${info.id}" on route "${info.provider}" supports at most `
      + `${info.maxOutputTokens} output tokens, received ${maxTokens}`,
      REGISTRY_ERROR_CODES.OUTPUT_TOKEN_LIMIT_EXCEEDED,
    )
  }
  if (maxTokens !== undefined && info.context !== undefined
    && maxTokens >= info.context.contextWindow) {
    throw new ModelError(
      `model "${info.id}" on route "${info.provider}" cannot reserve ${maxTokens} output tokens `
      + `inside its ${info.context.contextWindow}-token combined context window`,
      REGISTRY_ERROR_CODES.OUTPUT_TOKEN_LIMIT_EXCEEDED,
    )
  }
  return {
    config: {
      provider: config.provider,
      model: config.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      ...(config.topP === undefined ? {} : { topP: config.topP }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(config.stop === undefined ? {} : { stop: [...config.stop] }),
    },
    context: info.context,
  }
}

export function projectReplayForAdapter(
  options: GenerateOptions,
  adapter: ModelAdapter,
  registeredAdapter: (provider: string) => ModelAdapter | undefined,
): GenerateOptions {
  const messages: Message[] = options.messages.map((message) => {
    const source = message.source
    if (message.role !== 'assistant' || source.kind !== 'model'
      || source.replayState === undefined || registeredAdapter(source.provider) === adapter) {
      return message
    }
    return freezeMessage({
      ...message,
      source: { kind: 'model', provider: source.provider, model: source.model },
    })
  })
  if (messages.every((message, index) => message === options.messages[index])) return options
  return { ...options, messages }
}

function serializedBytes(value: unknown, code: string): number {
  let encoded: string | undefined
  try { encoded = JSON.stringify(value) }
  catch (error) {
    throw new ModelError('adapter model metadata must be JSON-serializable', code, { cause: error })
  }
  if (encoded === undefined) {
    throw new ModelError('adapter model metadata must be JSON-serializable', code)
  }
  return new TextEncoder().encode(encoded).byteLength
}
