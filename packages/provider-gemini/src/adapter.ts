import type { ModelProviderPlugin, ModelProviderRegistrar, RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
  type CredentialInput,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
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
  type CredentialSource,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  geminiInteractionsProtocol,
  type GeminiInteractionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-gemini-interactions'

/** Google Gemini API v1beta base. The protocol appends only `/interactions`. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export type GeminiCredential = CredentialSource

export interface GeminiAdapterOptions {
  /** Injected API key or resolver. Universal packages never read environment variables. */
  apiKey: GeminiCredential
  /** Endpoint base; defaults to {@link GEMINI_BASE_URL}. */
  baseUrl?: string
  /**
   * Name this endpoint uses in diagnostics and error messages. Defaults to
   * `'Gemini'`; set it to the real vendor name when pointing this provider at a
   * compatible gateway, so a rejection names who rejected it.
   */
  displayName?: string
  /** Extra endpoint headers, captured once per operation. Reserved names and collisions fail. */
  headers?: Readonly<Record<string, string>> | ((ctx: HeaderContext) => Readonly<Record<string, string>>)
  /** Permit cleartext HTTP explicitly for trusted local gateways. */
  allowInsecureHttp?: boolean
  /** Override the request path this protocol would otherwise pick (e.g. a gateway deployment path). */
  path?: string
  /** Extra query-string parameters, or a resolver for them. Never for secrets. */
  query?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  /**
   * Fields to deep-merge into the serialized body. The caller's value always
   * wins, even over a field the SDK set. A `null` value deletes the field.
   */
  body?: Readonly<Record<string, unknown>>
  /** Last-resort hook with full authority over the body, run after `body` is merged in. */
  transformRequest?: (body: unknown, ctx: RequestContext) => unknown
  /** Advisory catalog; built-in context policies do not advertise model availability. */
  models?: readonly ProviderCatalogModel[]
  /**
   * Whether Google may retain interactions. Defaults to false.
   *
   * This is not a prompt-cache switch: Interactions performs implicit prefix
   * caching automatically for supported models and exposes no cache-key field.
   */
  store?: boolean
  /**
   * How the API key travels. Defaults to `'x-goog-api-key'`, this API's own
   * header — but a gateway sitting in front of it may expect Bearer instead.
   */
  authHeader?: 'x-goog-api-key' | 'bearer'
  defaultMaxTokens?: number
  defaultContextWindow?: number
  streamIdleTimeoutMs?: number
  requestTimeoutMs?: number
  maxRequestBytes?: number
  maxResponseBytes?: number
  maxResponseChunks?: number
  maxSseEvents?: number
  maxSseEventChars?: number
  maxErrorBodyBytes?: number
  requestLoggerTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
  requestLogger?: ProviderRequestLogger
  responseLogger?: ProviderResponseLogger
  fetch?: typeof globalThis.fetch
}

export function geminiAdapter(options: GeminiAdapterOptions): HttpModelAdapter {
  return createHttpProvider({
    displayName: options.displayName ?? 'Gemini',
    protocol: geminiInteractionsProtocol,
    baseUrl: options.baseUrl ?? GEMINI_BASE_URL,
    auth: authOf(options),
    dialect: dialectOf(options),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
    ...(options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow }),
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
    ...(options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger }),
  })
}

export interface GeminiPluginOptions extends GeminiAdapterOptions {
  /** Registry routes installed by the plugin. Defaults to `['gemini']`. */
  readonly routes?: readonly string[]
}

export interface GeminiProviderOptions extends Omit<GeminiAdapterOptions, 'apiKey'> {
  readonly defaultModel?: string | ModelTarget
  readonly apiKey: CredentialInput
  readonly id?: string
  readonly routes?: readonly string[]
}

export function geminiPlugin(
  options: GeminiProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'gemini' }
export function geminiPlugin(options: GeminiPluginOptions): ModelProviderPlugin
export function geminiPlugin(
  options: GeminiProviderOptions | GeminiPluginOptions,
): ModelProviderPlugin | (ComposableModelProviderPlugin & { readonly family: 'gemini' }) {
  if (!usesRuntimeComposition(options)) return legacyGeminiPlugin(options)
  const id = options.id ?? 'gemini'
  const routes = Object.freeze([...(options.routes ?? [id])])
  return defineModelProviderPlugin({
    id,
    family: 'gemini',
    displayName: options.displayName ?? 'Gemini',
    routes,
    ...runtimeDefaultModel(options.defaultModel, routes),
    setup(registrar) {
      const remove = registrar.registerAdapter(createRuntimeGeminiAdapter(options))
      return () => { remove(); return undefined }
    },
  }) as ComposableModelProviderPlugin & { readonly family: 'gemini' }
}

function legacyGeminiPlugin(options: GeminiPluginOptions): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['gemini'])])
  const adapter = geminiAdapter(options)
  return Object.freeze({
    id: 'gemini',
    displayName: options.displayName ?? 'Gemini',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function createRuntimeGeminiAdapter(options: GeminiProviderOptions): HttpModelAdapter {
  return createRuntimeHttpProvider({
    displayName: options.displayName ?? 'Gemini',
    protocol: geminiInteractionsProtocol,
    baseUrl: options.baseUrl ?? GEMINI_BASE_URL,
    auth: authOf(options),
    dialect: dialectOf(options),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
    ...(options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow }),
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
    ...(options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger }),
  })
}

function dialectOf(options: Pick<GeminiAdapterOptions, 'store'>): Partial<GeminiInteractionsDialect> {
  return options.store === undefined ? {} : { store: options.store }
}

/**
 * This API's own header is `x-goog-api-key`, unlike most others' `authorization:
 * Bearer` — but a gateway sitting in front of it may expect Bearer instead.
 */
/**
 * Generic over the credential type on purpose: the two call sites accept
 * DIFFERENT ones — the legacy adapter takes {@link GeminiCredential}
 * (`provider-http`'s string-or-resolver), the composable one takes core's
 * broader `CredentialInput`. A non-generic parameter union would widen
 * `apiKey` to the union of both and fit neither target scheme.
 */
function authOf<Credential>(options: {
  readonly authHeader?: 'x-goog-api-key' | 'bearer'
  readonly apiKey: Credential
}) {
  return options.authHeader === 'bearer'
    ? { kind: 'bearer' as const, token: options.apiKey, label: 'the `apiKey` option' }
    : { kind: 'header' as const, name: 'x-goog-api-key', value: options.apiKey, label: 'the `apiKey` option' }
}

function usesRuntimeComposition(
  options: GeminiProviderOptions | GeminiPluginOptions,
): options is GeminiProviderOptions {
  if ('id' in options || 'defaultModel' in options) return true
  if (typeof options.apiKey === 'object' && options.apiKey !== null) return true
  if (typeof options.apiKey !== 'function') return true
  // Node's envCredential keeps a backwards-compatible callable surface while
  // also carrying the versioned CredentialSource marker used by composition.
  return 'kind' in options.apiKey && options.apiKey.kind === 'credential-source'
}

function runtimeDefaultModel(
  value: string | ModelTarget | undefined,
  routes: readonly string[],
): { readonly defaultModel?: ModelTarget } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { defaultModel: value }
  if (routes.length !== 1) throw new TypeError('A string defaultModel requires exactly one Gemini route')
  return { defaultModel: Object.freeze({ provider: routes[0]!, id: value }) }
}

function transportLimits(options: GeminiAdapterOptions | GeminiProviderOptions) {
  return {
    ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
    headers: endpointHeaders(options.headers),
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.query === undefined ? {} : { query: options.query }),
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.transformRequest === undefined ? {} : { transformRequest: options.transformRequest }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks }),
    ...(options.maxSseEvents === undefined ? {} : { maxSseEvents: options.maxSseEvents }),
    ...(options.maxSseEventChars === undefined ? {} : { maxSseEventChars: options.maxSseEventChars }),
    ...(options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes }),
    ...(options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  }
}
