/**
 * The Anthropic provider: the Messages API on `api.anthropic.com`.
 *
 * Configuration over {@link createHttpProvider}, like every other endpoint here.
 * The one thing it needs beyond the defaults is `describeModel`, to advertise its
 * thinking budgets as selectable reasoning efforts.
 *
 * @module ai-agent-sdk/providers/anthropic/adapter
 */

import type { ModelReasoningInfo } from '@ai-agent-sdk/core'
import type { RetryPolicyConfig } from '@ai-agent-sdk/core'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import type {
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
} from '../base/index.ts'
import {
  apiKeyFromEnv,
  createHttpProvider,
  type CredentialSource,
} from '../http-provider.ts'
import {
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
  type AnthropicDialect,
} from '../protocols/anthropic-messages.ts'
import type { ThinkingBudgets } from './serialize.ts'

/** The Anthropic API base. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

/** Environment variable read when no key is supplied. */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY'

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
  /** The API key, or a resolver. Omit to read `ANTHROPIC_API_KEY`. */
  apiKey?: AnthropicCredential
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
  maxErrorBodyBytes?: number
  requestLoggerTimeoutMs?: number
  /** Retry policy this route owns. */
  retryPolicy?: RetryPolicyConfig
  /** Optional exact wire-request logger; credentials are redacted. */
  requestLogger?: ProviderRequestLogger
}

/**
 * Create an Anthropic adapter.
 * @param options - credential, endpoint, and thinking-budget overrides.
 * @returns the adapter, ready to register.
 */
export function anthropicAdapter(options: AnthropicAdapterOptions = {}): HttpModelAdapter {
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
      value: options.apiKey ?? apiKeyFromEnv(ANTHROPIC_API_KEY_ENV),
      label: options.apiKey === undefined ? ANTHROPIC_API_KEY_ENV : 'the `apiKey` option',
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

function transportLimits(options: AnthropicAdapterOptions) {
  return {
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
    ...options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes },
    ...options.maxResponseChunks === undefined ? {} : { maxResponseChunks: options.maxResponseChunks },
    ...options.maxErrorBodyBytes === undefined ? {} : { maxErrorBodyBytes: options.maxErrorBodyBytes },
    ...options.requestLoggerTimeoutMs === undefined ? {} : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs },
  }
}
