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

export { anthropicMessagesProtocol } from '@ai-agent-sdk/protocol-anthropic-messages'
export type { AnthropicDialect, AnthropicReasoningState } from '@ai-agent-sdk/protocol-anthropic-messages'

export declare const ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
export declare const ANTHROPIC_VERSION: '2023-06-01'
export type AnthropicCredential = CredentialSource
export type ThinkingBudgets = Readonly<Record<string, number>>
export declare const DEFAULT_THINKING_BUDGETS: ThinkingBudgets

export interface AnthropicAdapterOptions {
  apiKey: AnthropicCredential
  baseUrl?: string
  version?: string
  beta?: readonly string[]
  models?: readonly ProviderCatalogModel[]
  thinkingBudgets?: ThinkingBudgets
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

export interface AnthropicPluginOptions extends AnthropicAdapterOptions {
  readonly routes?: readonly string[]
}

export interface AnthropicProviderOptions extends Omit<AnthropicAdapterOptions, 'apiKey'> {
  /** String requires exactly one claimed route; object names the desired claimed route. */
  readonly defaultModel?: string | import('@ai-agent-sdk/core/provider').ModelTarget
  readonly apiKey: CredentialInput
  /** Defaults to `anthropic`; when routes are omitted this is also the sole route. */
  readonly id?: string
  /** Explicit aliases; omission claims `[id ?? 'anthropic']`. */
  readonly routes?: readonly string[]
}

export declare function anthropicAdapter(options: AnthropicAdapterOptions): HttpModelAdapter
export declare function anthropicPlugin(
  options: AnthropicProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'anthropic' }
export declare function anthropicPlugin(options: AnthropicPluginOptions): ModelProviderPlugin
