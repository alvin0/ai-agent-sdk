import type {
  ComposableModelProviderPlugin,
  CredentialInput,
  ModelProviderPlugin,
  RetryPolicyConfig,
} from '@ai-agent-sdk/core/provider'
import type {
  CredentialSource,
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
} from '@ai-agent-sdk/provider-http'

export { openAiResponsesProtocol } from '@ai-agent-sdk/protocol-responses'
export type { ResponsesDialect } from '@ai-agent-sdk/protocol-responses'

export declare const OPENAI_BASE_URL: 'https://api.openai.com/v1'
export type OpenAiCredential = CredentialSource

export interface OpenAiAdapterOptions {
  apiKey: OpenAiCredential
  baseUrl?: string
  organization?: string
  project?: string
  models?: readonly ProviderCatalogModel[]
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

export interface OpenAiPluginOptions extends OpenAiAdapterOptions {
  readonly routes?: readonly string[]
}

export interface OpenAiProviderOptions extends Omit<OpenAiAdapterOptions, 'apiKey'> {
  /** String requires exactly one claimed route; object names the desired claimed route. */
  readonly defaultModel?: string | import('@ai-agent-sdk/core/provider').ModelTarget
  readonly apiKey: CredentialInput
  /** Defaults to `openai`; when routes are omitted this is also the sole route. */
  readonly id?: string
  /** Explicit aliases; omission claims `[id ?? 'openai']`. */
  readonly routes?: readonly string[]
}

export declare function openAiAdapter(options: OpenAiAdapterOptions): HttpModelAdapter
export declare function openAiPlugin(
  options: OpenAiProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'openai' }
export declare function openAiPlugin(options: OpenAiPluginOptions): ModelProviderPlugin
