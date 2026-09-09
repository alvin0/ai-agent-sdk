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
  createRuntimeHttpProvider,
  type CredentialSource,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@alvin0/ai-agent-sdk-protocol-responses'

/** The OpenAI API base. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** How the API key is obtained. */
export type OpenAiCredential = CredentialSource

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
  /** Organization to bill, when the key belongs to several. */
  organization?: string
  /** Project to attribute usage to. */
  project?: string
  /**
   * Advisory model catalog.
   *
   * Empty by default: this package cannot know which model ids are current, and a
   * stale built-in list would name retired models. Supply entries to declare
   * capabilities the SDK cannot infer, such as image support.
   */
  models?: readonly ProviderCatalogModel[]
  /** Whether the provider may retain responses server-side. Defaults to false. */
  store?: boolean
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
  fetch?: typeof globalThis.fetch
}

/**
 * Create an OpenAI adapter.
 * @param options - credential, endpoint, and catalog overrides.
 * @returns the adapter, ready to register.
 */
export function openAiAdapter(options: OpenAiAdapterOptions): HttpModelAdapter {
  const dialect: Partial<ResponsesDialect> = options.store === undefined
    ? {}
    : { store: options.store }

  return createHttpProvider({
    displayName: 'OpenAI',
    protocol: openAiResponsesProtocol,
    baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
    auth: {
      kind: 'bearer',
      token: options.apiKey,
      label: 'the `apiKey` option',
    },
    dialect,
    headers: {
      ...options.organization === undefined
        ? {}
        : { 'openai-organization': options.organization },
      ...options.project === undefined ? {} : { 'openai-project': options.project },
    },
    ...options.models === undefined ? {} : { models: options.models },
    defaultMaxTokens: options.defaultMaxTokens ?? 32_000,
    defaultContextWindow: options.defaultContextWindow ?? 128_000,
    ...options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...transportLimits(options),
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
  })
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
    displayName: 'OpenAI',
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
    displayName: 'OpenAI',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function createRuntimeOpenAiAdapter(options: OpenAiProviderOptions): HttpModelAdapter {
  return createRuntimeHttpProvider({
    displayName: 'OpenAI',
    protocol: openAiResponsesProtocol,
    baseUrl: options.baseUrl ?? OPENAI_BASE_URL,
    auth: { kind: 'bearer', token: options.apiKey, label: 'the `apiKey` option' },
    dialect: options.store === undefined ? {} : { store: options.store },
    headers: {
      ...(options.organization === undefined ? {} : { 'openai-organization': options.organization }),
      ...(options.project === undefined ? {} : { 'openai-project': options.project }),
    },
    ...(options.models === undefined ? {} : { models: options.models }),
    defaultMaxTokens: options.defaultMaxTokens ?? 32_000,
    defaultContextWindow: options.defaultContextWindow ?? 128_000,
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
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
