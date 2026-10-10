import { sharedOptions, chatCompletionsDialectOf   } from './adapter-options.ts'
import type { OpenAiAdapterOptions, OpenAiProviderOptions, OpenAiPluginOptions,
  OpenAiCatalogModel,
} from './adapter-types.ts'
export type { OpenAiAdapterOptions, OpenAiProviderOptions, OpenAiPluginOptions, OpenAiCatalogModel,
  OpenAiChatCompletionsCompat, OpenAiCredential } from './adapter-types.ts'
/**
 * The OpenAI provider: the Responses API on `api.openai.com`.
 *
 * Note how little there is here. Every endpoint fact is configuration handed to
 * {@link createHttpProvider}; the protocol, the pipeline, and the error mapping are
 * all shared. That is the intended shape for any endpoint speaking a protocol this
 * package already implements — including your own gateway.
 *
 * @module ai-agent-sdk/providers/openai/adapter
 */

import type { ModelProviderPlugin, ModelProviderRegistrar  } from '@alvin0/ai-agent-sdk-core'
import { ModelAdapter, ModelError   } from '@alvin0/ai-agent-sdk-core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import { OpenAiDualApiAdapter, type OpenAiApi   } from './dual-api.ts'
import type {
  HttpModelAdapter,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  createHttpProvider,
  createRuntimeHttpProvider,
  FieldFallbackAdapter,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import {
  openAiChatCompletionsProtocol,
} from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'

/** The OpenAI API base. */
export { OPENAI_BASE_URL } from './constants.ts'

/**
 * Create an OpenAI adapter.
 *
 * One route can serve BOTH OpenAI wires at once: if any `models[]` entry
 * names an `api` different from the route's own, this returns a facade
 * ({@link OpenAiDualApiAdapter}) holding one Responses adapter and one Chat
 * Completions adapter, delegating each call by model id. Otherwise — the
 * common case — this is a single `createHttpProvider` adapter, unchanged
 * from before per-model `api` existed.
 * @param options - credential, endpoint, and catalog overrides.
 * @returns the adapter, ready to register.
 */
export function openAiAdapter(options: OpenAiAdapterOptions): ModelAdapter {
  const effectiveKey = effectivePromptCacheKey(options)
  const primary = buildOpenAiAdapterTree(options, effectiveKey)
  // Only wrapped when a key is actually in play (explicit or auto-generated):
  // an adapter nobody asked to cache anything with pays nothing extra.
  if (effectiveKey === undefined) return primary
  return new FieldFallbackAdapter(
    primary,
    buildOpenAiAdapterTree(options, false),
    { isFieldRejection: isPromptCacheKeyRejection },
  )
}

/**
 * Resolve the key every wire this route serves should share, so a mixed
 * route (`models[].api`) still routes both wires' calls to one session.
 * Explicit settings win over auto-generation, and the newer top-level
 * option wins over the older Chat-Completions-only `compat` one.
 */
function effectivePromptCacheKey(
  options: Pick<OpenAiAdapterOptions, 'promptCacheKey' | 'promptCaching' | 'compat'>,
): string | undefined {
  return options.promptCacheKey
    ?? options.compat?.promptCacheKey
    ?? (options.promptCaching === true ? randomId() : undefined)
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sdk-${Date.now().toString(36)}`
}

/**
 * Recognize a dispatch rejection caused specifically by `prompt_cache_key` —
 * the one signal {@link FieldFallbackAdapter} is allowed to react to. Scoped
 * narrowly (a 400 whose message names the field) rather than treating every
 * 400 as a reason to give up on caching, which would mask a real, unrelated
 * request error behind a silent feature downgrade.
 */
function isPromptCacheKeyRejection(error: unknown): boolean {
  return error instanceof ModelError
    && error.failure.status === 400
    && error.message.toLowerCase().includes('prompt_cache_key')
}

/**
 * One route can serve BOTH OpenAI wires at once: if any `models[]` entry
 * names an `api` different from the route's own, this returns a facade
 * ({@link OpenAiDualApiAdapter}) holding one Responses adapter and one Chat
 * Completions adapter, delegating each call by model id. Otherwise — the
 * common case — this is a single `createHttpProvider` adapter.
 * @param promptCacheKeyOverride - `false` forces caching off regardless of
 *   `options`, for {@link FieldFallbackAdapter}'s fallback build.
 */
function buildOpenAiAdapterTree(
  options: OpenAiAdapterOptions,
  promptCacheKeyOverride: string | undefined | false,
): ModelAdapter {
  const defaultApi: OpenAiApi = options.api ?? 'responses'
  const models = options.models
  const mixed = models?.some(entry => entry.api !== undefined && entry.api !== defaultApi) ?? false
  if (!mixed) return buildOpenAiApiAdapter(options, defaultApi, models, promptCacheKeyOverride)

  const apiOf = new Map<string, OpenAiApi>(
    (models ?? []).map(entry => [entry.id, entry.api ?? defaultApi]),
  )
  const responsesModels = (models ?? []).filter(entry => (entry.api ?? defaultApi) === 'responses')
  const chatModels = (models ?? []).filter(entry => (entry.api ?? defaultApi) === 'chat-completions')
  return new OpenAiDualApiAdapter(
    buildOpenAiApiAdapter(options, 'responses', responsesModels, promptCacheKeyOverride),
    buildOpenAiApiAdapter(options, 'chat-completions', chatModels, promptCacheKeyOverride),
    apiOf,
    defaultApi,
  )
}

function buildOpenAiApiAdapter(
  options: OpenAiAdapterOptions,
  api: OpenAiApi,
  models: readonly OpenAiCatalogModel[] | undefined,
  promptCacheKeyOverride: string | undefined | false,
): HttpModelAdapter {
  const shared = sharedOptions(options, models)
  const promptCacheKey = promptCacheKeyOverride === false ? undefined : promptCacheKeyOverride
  if (api === 'chat-completions') {
    return createHttpProvider({
      displayName: options.displayName ?? 'OpenAI',
      protocol: openAiChatCompletionsProtocol,
      dialect: chatCompletionsDialectOf(options.compat, promptCacheKey),
      ...shared,
    })
  }
  return createHttpProvider({
    displayName: options.displayName ?? 'OpenAI',
    protocol: openAiResponsesProtocol,
    dialect: {
      ...options.store === undefined ? {} : { store: options.store },
      ...promptCacheKey === undefined ? {} : { promptCacheKey },
    } satisfies Partial<ResponsesDialect>,
    ...shared,
  })
}

/** Preferred transactional plugin for installing the OpenAI provider. */
export function openAiPlugin(
  options: OpenAiProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'openai' }
export function openAiPlugin(options: OpenAiPluginOptions): ModelProviderPlugin
export function openAiPlugin(
  options: OpenAiProviderOptions | OpenAiPluginOptions,
): ModelProviderPlugin | (ComposableModelProviderPlugin & { readonly family: 'openai' }) {
  if (!usesRuntimeComposition(options)) return legacyOpenAiPlugin(options)
  const id = options.id ?? 'openai'
  const routes = Object.freeze([...(options.routes ?? [id])])
  return defineModelProviderPlugin({
    id,
    family: 'openai',
    displayName: options.displayName ?? 'OpenAI',
    routes,
    ...runtimeDefaultModel(options.defaultModel, routes),
    setup(registrar) {
      const adapter = createRuntimeOpenAiAdapter(options)
      const remove = registrar.registerAdapter(adapter)
      return () => { remove(); return undefined }
    },
  }) as ComposableModelProviderPlugin & { readonly family: 'openai' }
}

function legacyOpenAiPlugin(options: OpenAiPluginOptions): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['openai'])])
  const adapter = openAiAdapter(options)
  return Object.freeze({
    id: 'openai',
    displayName: options.displayName ?? 'OpenAI',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function createRuntimeOpenAiAdapter(options: OpenAiProviderOptions): ModelAdapter {
  const effectiveKey = effectivePromptCacheKey(options)
  const primary = buildRuntimeOpenAiAdapterTree(options, effectiveKey)
  if (effectiveKey === undefined) return primary
  return new FieldFallbackAdapter(
    primary,
    buildRuntimeOpenAiAdapterTree(options, false),
    { isFieldRejection: isPromptCacheKeyRejection },
  )
}

function buildRuntimeOpenAiAdapterTree(
  options: OpenAiProviderOptions,
  promptCacheKeyOverride: string | undefined | false,
): ModelAdapter {
  const defaultApi: OpenAiApi = options.api ?? 'responses'
  const models = options.models
  const mixed = models?.some(entry => entry.api !== undefined && entry.api !== defaultApi) ?? false
  if (!mixed) return buildRuntimeOpenAiApiAdapter(options, defaultApi, models, promptCacheKeyOverride)

  const apiOf = new Map<string, OpenAiApi>(
    (models ?? []).map(entry => [entry.id, entry.api ?? defaultApi]),
  )
  const responsesModels = (models ?? []).filter(entry => (entry.api ?? defaultApi) === 'responses')
  const chatModels = (models ?? []).filter(entry => (entry.api ?? defaultApi) === 'chat-completions')
  return new OpenAiDualApiAdapter(
    buildRuntimeOpenAiApiAdapter(options, 'responses', responsesModels, promptCacheKeyOverride),
    buildRuntimeOpenAiApiAdapter(options, 'chat-completions', chatModels, promptCacheKeyOverride),
    apiOf,
    defaultApi,
  )
}

function buildRuntimeOpenAiApiAdapter(
  options: OpenAiProviderOptions,
  api: OpenAiApi,
  models: readonly OpenAiCatalogModel[] | undefined,
  promptCacheKeyOverride: string | undefined | false,
): HttpModelAdapter {
  const shared = sharedOptions(options, models)
  const promptCacheKey = promptCacheKeyOverride === false ? undefined : promptCacheKeyOverride
  if (api === 'chat-completions') {
    return createRuntimeHttpProvider({
      displayName: options.displayName ?? 'OpenAI',
      protocol: openAiChatCompletionsProtocol,
      dialect: chatCompletionsDialectOf(options.compat, promptCacheKey),
      ...shared,
    })
  }
  return createRuntimeHttpProvider({
    displayName: options.displayName ?? 'OpenAI',
    protocol: openAiResponsesProtocol,
    dialect: {
      ...options.store === undefined ? {} : { store: options.store },
      ...promptCacheKey === undefined ? {} : { promptCacheKey },
    },
    ...shared,
  })
}

function usesRuntimeComposition(
  options: OpenAiProviderOptions | OpenAiPluginOptions,
): options is OpenAiProviderOptions {
  if ('id' in options || 'defaultModel' in options) return true
  if (typeof options.apiKey === 'object' && options.apiKey !== null) return true
  return typeof options.apiKey !== 'function'
}

function runtimeDefaultModel(
  value: string | ModelTarget | undefined,
  routes: readonly string[],
): { readonly defaultModel?: ModelTarget } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { defaultModel: value }
  if (routes.length !== 1) {
    throw new TypeError('A string defaultModel requires exactly one OpenAI route')
  }
  return { defaultModel: Object.freeze({ provider: routes[0]!, id: value }) }
}
