/**
 * The Anthropic provider: the Messages API on `api.anthropic.com`.
 *
 * Configuration over {@link createHttpProvider}, like every other endpoint here.
 * The one thing it needs beyond the defaults is `describeModel`, to advertise its
 * thinking budgets as selectable reasoning efforts.
 *
 * @module ai-agent-sdk/providers/anthropic/adapter
 */

import type { ModelReasoningInfo } from '@alvin0/ai-agent-sdk-core'
import type { ModelProviderPlugin, ModelProviderRegistrar, RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import { ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
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
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type ThinkingBudgets,
} from '@alvin0/ai-agent-sdk-protocol-anthropic-messages'

/** The Anthropic API base. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

// Re-exported so callers can reach the protocol's constants from the provider
// they are already importing.
export { ANTHROPIC_VERSION, DEFAULT_THINKING_BUDGETS }

/** How the API key is obtained. */
export type AnthropicCredential = CredentialSource

/** Turn the configured budgets into selectable reasoning efforts. */
function reasoningInfo(budgets: ThinkingBudgets): ModelReasoningInfo {
  return {
    efforts: Object.keys(budgets).map(id => ({
      id: ReasoningEffortId(id),
      name: id.charAt(0).toUpperCase() + id.slice(1),
      description: budgets[id] === 0
        ? 'No extended thinking.'
        : `Up to ${budgets[id]?.toLocaleString() ?? '?'} thinking tokens.`,
    })),
  }
}

/** Options for {@link anthropicAdapter}. */
export interface AnthropicAdapterOptions {
  /** Injected API key or resolver. Universal packages never read environment variables. */
  apiKey: AnthropicCredential
  /** Endpoint base; defaults to {@link ANTHROPIC_BASE_URL}. */
  baseUrl?: string
  /** API version header; defaults to {@link ANTHROPIC_VERSION}. */
  version?: string
  /** Opt-in beta features, sent as `anthropic-beta`. */
  beta?: readonly string[]
  /**
   * Advisory model catalog.
   *
   * Empty by default: this package cannot know which model ids are current, and a
   * stale built-in list would name retired models.
   */
  models?: readonly ProviderCatalogModel[]
  /** Effort id to thinking-token budget; defaults to {@link DEFAULT_THINKING_BUDGETS}. */
  thinkingBudgets?: ThinkingBudgets
  /**
   * Output cap when neither caller nor catalog names one.
   *
   * This API REQUIRES `max_tokens`, so a default always has to exist.
   */
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
 * Create an Anthropic adapter.
 * @param options - credential, endpoint, and thinking-budget overrides.
 * @returns the adapter, ready to register.
 */
export function anthropicAdapter(options: AnthropicAdapterOptions): HttpModelAdapter {
  const budgets = options.thinkingBudgets ?? DEFAULT_THINKING_BUDGETS
  const dialect: Partial<AnthropicDialect> = {
    budgets,
    ...options.version === undefined ? {} : { version: options.version },
    ...options.beta === undefined ? {} : { beta: options.beta },
  }

  return createHttpProvider({
    displayName: 'Anthropic',
    protocol: anthropicMessagesProtocol,
    baseUrl: options.baseUrl ?? ANTHROPIC_BASE_URL,
    // This API uses its own header rather than `authorization: Bearer`.
    auth: {
      kind: 'header',
      name: 'x-api-key',
      value: options.apiKey,
      label: 'the `apiKey` option',
    },
    dialect,
    describeModel: (info, effective) => ({
      ...info,
      reasoning: info.reasoning ?? reasoningInfo(effective.budgets),
    }),
    ...options.models === undefined ? {} : { models: options.models },
    defaultMaxTokens: options.defaultMaxTokens ?? 8_192,
    defaultContextWindow: options.defaultContextWindow ?? 200_000,
    ...options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...transportLimits(options),
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
  })
}

export interface AnthropicPluginOptions extends AnthropicAdapterOptions {
  /** Registry routes installed by the plugin. Defaults to `['anthropic']`. */
  readonly routes?: readonly string[]
}

export interface AnthropicProviderOptions extends Omit<AnthropicAdapterOptions, 'apiKey'> {
  readonly defaultModel?: string | ModelTarget
  readonly apiKey: CredentialInput
  readonly id?: string
  readonly routes?: readonly string[]
}

/** Preferred transactional plugin for installing the Anthropic provider. */
export function anthropicPlugin(
  options: AnthropicProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'anthropic' }
export function anthropicPlugin(options: AnthropicPluginOptions): ModelProviderPlugin
export function anthropicPlugin(
  options: AnthropicProviderOptions | AnthropicPluginOptions,
): ModelProviderPlugin | (ComposableModelProviderPlugin & { readonly family: 'anthropic' }) {
  if (!usesRuntimeComposition(options)) return legacyAnthropicPlugin(options)
  const id = options.id ?? 'anthropic'
  const routes = Object.freeze([...(options.routes ?? [id])])
  return defineModelProviderPlugin({
    id,
    family: 'anthropic',
    displayName: 'Anthropic',
    routes,
    ...runtimeDefaultModel(options.defaultModel, routes),
    setup(registrar) {
      const adapter = createRuntimeAnthropicAdapter(options)
      const remove = registrar.registerAdapter(adapter)
      return () => { remove(); return undefined }
    },
  }) as ComposableModelProviderPlugin & { readonly family: 'anthropic' }
}

function legacyAnthropicPlugin(options: AnthropicPluginOptions): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['anthropic'])])
  const adapter = anthropicAdapter(options)
  return Object.freeze({
    id: 'anthropic',
    displayName: 'Anthropic',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function createRuntimeAnthropicAdapter(options: AnthropicProviderOptions): HttpModelAdapter {
  const budgets = options.thinkingBudgets ?? DEFAULT_THINKING_BUDGETS
  const dialect: Partial<AnthropicDialect> = {
    budgets,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.beta === undefined ? {} : { beta: options.beta }),
  }
  return createRuntimeHttpProvider({
    displayName: 'Anthropic',
    protocol: anthropicMessagesProtocol,
    baseUrl: options.baseUrl ?? ANTHROPIC_BASE_URL,
    auth: {
      kind: 'header',
      name: 'x-api-key',
      value: options.apiKey,
      label: 'the `apiKey` option',
    },
    dialect,
    describeModel: (info, effective) => ({
      ...info,
      reasoning: info.reasoning ?? reasoningInfo(effective.budgets),
    }),
    ...(options.models === undefined ? {} : { models: options.models }),
    defaultMaxTokens: options.defaultMaxTokens ?? 8_192,
    defaultContextWindow: options.defaultContextWindow ?? 200_000,
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
  })
}

function usesRuntimeComposition(
  options: AnthropicProviderOptions | AnthropicPluginOptions,
): options is AnthropicProviderOptions {
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
    throw new TypeError('A string defaultModel requires exactly one Anthropic route')
  }
  return { defaultModel: Object.freeze({ provider: routes[0]!, id: value }) }
}

function transportLimits(options: AnthropicAdapterOptions | AnthropicProviderOptions) {
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
