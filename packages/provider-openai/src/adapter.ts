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

import type { ModelProviderPlugin, ModelProviderRegistrar, RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import { ModelAdapter, ModelError } from '@alvin0/ai-agent-sdk-core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
  type CredentialInput,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import { OpenAiDualApiAdapter, type OpenAiApi } from './dual-api.ts'
import type {
  HeaderContext,
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
  ProviderResponseLogger,
  RequestContext,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  createHttpProvider,
  endpointHeaders,
  createRuntimeHttpProvider,
  FieldFallbackAdapter,
  type CredentialSource,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'
import {
  openAiChatCompletionsProtocol,
  type ChatCompletionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'

/** The OpenAI API base. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** How the API key is obtained. */
export type OpenAiCredential = CredentialSource

/**
 * Endpoint-specific knobs for the Chat Completions wire, exposed only when
 * `api: 'chat-completions'`. Named `compat` because each field exists for one
 * reason: some OpenAI-compatible endpoint needs the field sent differently, or
 * not at all. Unset fields keep this protocol's own conservative defaults.
 */
export interface OpenAiChatCompletionsCompat {
  /**
   * How this endpoint wants to be told how hard to think.
   *
   * Defaults to `'openai'` (`reasoning_effort`, sent verbatim) — the official
   * field, live-verified on `/v1/chat/completions` (see the redesign plan's
   * codex2claudecode probe). `'deepseek'` matches an endpoint that reasons
   * unless told not to. `false` sends nothing regardless of agent effort.
   */
  reasoningFormat?: ChatCompletionsDialect['reasoningFormat']
  /** Name of the output-length field; `false` sends none. */
  maxTokensField?: ChatCompletionsDialect['maxTokensField']
  /** Role the system prompt travels under. */
  systemRole?: ChatCompletionsDialect['systemRole']
  /** `response_format` support. */
  structuredOutputs?: ChatCompletionsDialect['structuredOutputs']
  /** Send `tools` + `tool_choice`. */
  tools?: boolean
  /** Send `parallel_tool_calls`. */
  parallelToolCalls?: boolean
  /** Send `stream_options: { include_usage: true }`. */
  streamUsage?: boolean
  /** Send `stop`. */
  stop?: boolean
  /** Send `seed`. */
  seed?: boolean
  /** Prompt/session cache key, when the endpoint accepts one. */
  promptCacheKey?: string
}

/** A catalog entry that can also name which OpenAI wire this exact model speaks. */
export interface OpenAiCatalogModel extends ProviderCatalogModel {
  /** Overrides the route's own `api` for this one model id. */
  api?: OpenAiApi
}

/** Options for {@link openAiAdapter}. */
export interface OpenAiAdapterOptions {
  /** Injected API key or resolver. Universal packages never read environment variables. */
  apiKey: OpenAiCredential
  /**
   * Endpoint base; defaults to {@link OPENAI_BASE_URL}.
   *
   * Point this at a compatible gateway to reuse this provider wholesale.
   */
  baseUrl?: string
  /**
   * Name this endpoint uses in diagnostics and error messages. Defaults to
   * `'OpenAI'`; set it to the real vendor name (e.g. `'DeepSeek'`) when pointing
   * this provider at a compatible gateway, so a rejection names who rejected it.
   */
  displayName?: string
  /** Extra endpoint headers, captured once per operation. Reserved names and collisions fail. */
  headers?: Readonly<Record<string, string>> | ((ctx: HeaderContext) => Readonly<Record<string, string>>)
  /** Permit cleartext HTTP explicitly for trusted local gateways. */
  allowInsecureHttp?: boolean
  /** Override the request path this protocol would otherwise pick (e.g. an Azure deployment path). */
  path?: string
  /** Extra query-string parameters, or a resolver for them (e.g. Azure's `api-version`). Never for secrets. */
  query?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  /**
   * Fields to deep-merge into the serialized body. The caller's value always
   * wins, even over a field the SDK set. A `null` value deletes the field.
   */
  body?: Readonly<Record<string, unknown>>
  /** Last-resort hook with full authority over the body, run after `body` is merged in. */
  transformRequest?: (body: unknown, ctx: RequestContext) => unknown
  /** Organization to bill, when the key belongs to several. */
  organization?: string
  /** Project to attribute usage to. */
  project?: string
  /**
   * Which OpenAI wire this endpoint speaks. Defaults to `'responses'`.
   *
   * Most third-party OpenAI-compatible endpoints (DeepSeek, Groq, Together,
   * Qwen/DashScope, vLLM, Ollama, LM Studio, many gateways) only implement
   * `/chat/completions` — set `'chat-completions'` to reach those.
   */
  api?: 'responses' | 'chat-completions'
  /** Chat Completions wire knobs. Ignored unless `api: 'chat-completions'`. */
  compat?: OpenAiChatCompletionsCompat
  /**
   * Advisory model catalog.
   *
   * Empty by default: this package cannot know which model ids are current, and a
   * stale built-in list would name retired models. Supply entries to declare
   * capabilities the SDK cannot infer, such as image support.
   *
   * `api` on an entry lets ONE route serve both OpenAI wires, model by model —
   * a gateway that fronts both classic chat models (only on `/chat/completions`)
   * and newer reasoning models (only on `/responses`), for instance. Omitted,
   * an entry follows the route's own `api`.
   */
  models?: readonly OpenAiCatalogModel[]
  /** Whether the provider may retain responses server-side. Defaults to false. */
  store?: boolean
  /**
   * Stable key letting the provider route a session's calls to the same
   * cached-prefix-warm backend, cutting cost and latency on a long
   * conversation that resends its own history every turn. Applies to
   * whichever wire is active — Responses or Chat Completions — and, for a
   * mixed route (`models[].api`), to both.
   *
   * Leave unset and set {@link promptCaching} instead to have the SDK invent
   * one per adapter instance (one per conversation, in the common case of
   * building a fresh registry per session) rather than naming your own.
   */
  promptCacheKey?: string
  /**
   * Auto-generate a stable {@link promptCacheKey} when none is given.
   *
   * Off by default: not every account or OpenAI-COMPATIBLE gateway behind
   * this adapter understands `prompt_cache_key`, and a route that doesn't
   * should not silently be asked to guess. If a live dispatch is ever
   * rejected specifically for it, this adapter turns caching off for
   * itself, permanently, and retries once without it.
   */
  promptCaching?: boolean
  /** Output cap when neither caller nor catalog names one. */
  defaultMaxTokens?: number
  /** Context capacity assumed for an uncatalogued model. */
  defaultContextWindow?: number
  /** Idle bound while a stream read is outstanding. */
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxResponseChunks?: number
  maxSseEvents?: number
  maxSseEventChars?: number
  maxErrorBodyBytes?: number
  requestLoggerTimeoutMs?: number
  /** Retry policy this route owns. */
  retryPolicy?: RetryPolicyConfig
  /** Optional exact wire-request logger; credentials are redacted. */
  requestLogger?: ProviderRequestLogger
  /** Optional exact wire-response logger, fired once a stream ends. */
  responseLogger?: ProviderResponseLogger
  fetch?: typeof globalThis.fetch
}

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
  const shared = {
    baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
    auth: {
      kind: 'bearer' as const,
      token: options.apiKey,
      label: 'the `apiKey` option',
    },
    headers: endpointHeaders(options.headers, {
      ...options.organization === undefined
        ? {}
        : { 'openai-organization': options.organization },
      ...options.project === undefined ? {} : { 'openai-project': options.project },
    }),
    ...options.path === undefined ? {} : { path: options.path },
    ...options.query === undefined ? {} : { query: options.query },
    ...options.body === undefined ? {} : { body: options.body },
    ...options.transformRequest === undefined ? {} : { transformRequest: options.transformRequest },
    ...models === undefined ? {} : { models },
    ...options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens },
    ...options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow },
    ...options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...transportLimits(options),
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
    ...options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger },
  }
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

const CHAT_COMPLETIONS_REASONING_FORMATS = new Set(['openai', 'deepseek', false])

function chatCompletionsDialectOf(
  compat: OpenAiChatCompletionsCompat | undefined,
  promptCacheKey: string | undefined,
): Partial<ChatCompletionsDialect> {
  if (compat?.reasoningFormat !== undefined && !CHAT_COMPLETIONS_REASONING_FORMATS.has(compat.reasoningFormat)) {
    throw new TypeError(
      `Chat Completions reasoningFormat must be 'openai', 'deepseek', or false, received ${JSON.stringify(compat.reasoningFormat)}`,
    )
  }
  return {
    // A JS caller (or one that fought past TypeScript with `as any`) mistyping
    // a value from a DIFFERENT protocol — Anthropic's `'thinking-budget'`, for
    // instance — would otherwise fall through `reasoningFieldsOf`'s `=== false`
    // / `=== 'openai'` checks in serialize.ts and silently behave as
    // `'deepseek'` instead of failing loudly.
    reasoningFormat: compat?.reasoningFormat ?? 'openai',
    ...compat?.maxTokensField === undefined ? {} : { maxTokensField: compat.maxTokensField },
    ...compat?.systemRole === undefined ? {} : { systemRole: compat.systemRole },
    ...compat?.structuredOutputs === undefined ? {} : { structuredOutputs: compat.structuredOutputs },
    ...compat?.tools === undefined ? {} : { tools: compat.tools },
    ...compat?.parallelToolCalls === undefined ? {} : { parallelToolCalls: compat.parallelToolCalls },
    ...compat?.streamUsage === undefined ? {} : { streamUsage: compat.streamUsage },
    ...compat?.stop === undefined ? {} : { stop: compat.stop },
    ...compat?.seed === undefined ? {} : { seed: compat.seed },
    // The resolved key — explicit, auto-generated, or the older `compat`-only
    // spelling — always wins over `compat.promptCacheKey` restated here, since
    // both already fed into the SAME resolution in `effectivePromptCacheKey`.
    ...promptCacheKey === undefined ? {} : { promptCacheKey },
  }
}

export interface OpenAiPluginOptions extends OpenAiAdapterOptions {
  /** Registry routes installed by the plugin. Defaults to `['openai']`. */
  readonly routes?: readonly string[]
}

export interface OpenAiProviderOptions extends Omit<OpenAiAdapterOptions, 'apiKey'> {
  readonly defaultModel?: string | ModelTarget
  readonly apiKey: CredentialInput
  readonly id?: string
  readonly routes?: readonly string[]
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
  const shared = {
    baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
    auth: { kind: 'bearer' as const, token: options.apiKey, label: 'the `apiKey` option' },
    headers: endpointHeaders(options.headers, {
      ...(options.organization === undefined ? {} : { 'openai-organization': options.organization }),
      ...(options.project === undefined ? {} : { 'openai-project': options.project }),
    }),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.transformRequest === undefined ? {} : { transformRequest: options.transformRequest }),
    ...(models === undefined ? {} : { models }),
    ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
    ...(options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow }),
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
    ...(options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger }),
  }
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

function transportLimits(options: OpenAiAdapterOptions | OpenAiProviderOptions) {
  return {
    ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks },
    ...options.maxSseEvents === undefined ? {} : { maxSseEvents: options.maxSseEvents },
    ...options.maxSseEventChars === undefined ? {} : { maxSseEventChars: options.maxSseEventChars },
    ...options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes },
    ...options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },
    ...options.fetch === undefined ? {} : { fetch: options.fetch },
  }
}
