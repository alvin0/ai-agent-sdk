import type { ModelProviderPlugin, ModelProviderRegistrar, RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import {
  defineModelProviderPlugin,
  type ComposableModelProviderPlugin,
  type CredentialInput,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import type {
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
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
import { geminiContextPolicy } from './context-policy.ts'

/** Google Gemini API v1beta base. The protocol appends only `/interactions`. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export type GeminiCredential = CredentialSource

export interface GeminiAdapterOptions {
  /** Injected API key or resolver. Universal packages never read environment variables. */
  apiKey: GeminiCredential
  /** Endpoint base; defaults to {@link GEMINI_BASE_URL}. */
  baseUrl?: string
  /** Extra endpoint headers, captured once per operation. Reserved names and collisions fail. */
  headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>)
  /** Permit cleartext HTTP explicitly for trusted local gateways. */
  allowInsecureHttp?: boolean
  /** Advisory catalog; built-in context policies do not advertise model availability. */
  models?: readonly ProviderCatalogModel[]
  /** Whether Google may retain interactions. Defaults to false. */
  store?: boolean
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
  fetch?: typeof globalThis.fetch
}

export function geminiAdapter(options: GeminiAdapterOptions): HttpModelAdapter {
  return createHttpProvider({
    displayName: 'Gemini',
    describeModel: geminiContextPolicy(options),
    protocol: geminiInteractionsProtocol,
    baseUrl: options.baseUrl ?? GEMINI_BASE_URL,
    auth: {
      kind: 'header', name: 'x-goog-api-key', value: options.apiKey,
      label: 'the `apiKey` option',
    },
    dialect: dialectOf(options),
    ...(options.models === undefined ? {} : { models: options.models }),
    defaultMaxTokens: options.defaultMaxTokens ?? 8_192,
    defaultContextWindow: options.defaultContextWindow ?? 200_000,
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
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
    displayName: 'Gemini',
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
    displayName: 'Gemini',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function createRuntimeGeminiAdapter(options: GeminiProviderOptions): HttpModelAdapter {
  return createRuntimeHttpProvider({
    describeModel: geminiContextPolicy(options),
    displayName: 'Gemini',
    protocol: geminiInteractionsProtocol,
    baseUrl: options.baseUrl ?? GEMINI_BASE_URL,
    auth: {
      kind: 'header', name: 'x-goog-api-key', value: options.apiKey,
      label: 'the `apiKey` option',
    },
    dialect: dialectOf(options),
    ...(options.models === undefined ? {} : { models: options.models }),
    defaultMaxTokens: options.defaultMaxTokens ?? 8_192,
    defaultContextWindow: options.defaultContextWindow ?? 200_000,
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
  })
}

function dialectOf(options: Pick<GeminiAdapterOptions, 'store'>): Partial<GeminiInteractionsDialect> {
  return options.store === undefined ? {} : { store: options.store }
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
