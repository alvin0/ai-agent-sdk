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
import { ModelAdapter, ModelError, ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
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
  FieldFallbackAdapter,
  type CredentialSource,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  ANTHROPIC_VERSION,
  DEFAULT_THINKING_BUDGETS,
  anthropicMessagesProtocol,
  type AnthropicDialect,
  type AnthropicReasoningFormat,
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
  /**
   * Name this endpoint uses in diagnostics and error messages. Defaults to
   * `'Anthropic'`; set it to the real vendor name (e.g. `'Kimi'`) when pointing
   * this provider at a compatible gateway, so a rejection names who rejected it.
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
  /**
   * Which field carries reasoning effort. Defaults to `'output-config'`
   * (current GA models): the caller's effort string reaches
   * `output_config.effort` verbatim — pure pass-through, no SDK conversion.
   * Set `'thinking-budget'` for an older model or a gateway that only
   * understands a token budget; then effort is converted via `thinkingBudgets`
   * instead of being sent raw.
   */
  reasoningFormat?: AnthropicReasoningFormat
  /** Effort id to thinking-token budget; only consulted under `reasoningFormat: 'thinking-budget'`. */
  thinkingBudgets?: ThinkingBudgets
  /**
   * Extended-thinking mode, sent only when set. Independent of effort under
   * `'output-config'` — omission leaves the model's own default thinking
   * behavior alone rather than the SDK guessing one from the effort.
   */
  thinking?: 'adaptive' | 'disabled'
  /**
   * Mark the stable prefix of every request (system prompt, tool
   * definitions, every message but the newest) as a `cache_control`
   * breakpoint, so a long conversation reads its own unchanged history back
   * at a steep discount instead of paying to reprocess it on every turn.
   *
   * Off by default: this is an Anthropic-specific extension, and a gateway
   * behind this same adapter that speaks the Messages API but does not
   * understand `cache_control` should not be asked to guess. If a live
   * dispatch is ever rejected specifically for it, this adapter turns
   * caching off for itself, permanently, and retries once without it — it
   * never fails a call over an optimization the caller opted into.
   */
  promptCaching?: boolean
  /** Cache breakpoint lifetime. Defaults to this API's own default (5 minutes). */
  promptCachingTtl?: '5m' | '1h'
  /** How the API key travels. Defaults to `'x-api-key'`, this API's own header. */
  authHeader?: 'x-api-key' | 'bearer'
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
  /** Optional exact wire-response logger, fired once a stream ends. */
  responseLogger?: ProviderResponseLogger
  fetch?: typeof globalThis.fetch
}

/**
 * Create an Anthropic adapter.
 * @param options - credential, endpoint, and thinking-budget overrides.
 * @returns the adapter, ready to register.
 */
export function anthropicAdapter(options: AnthropicAdapterOptions): ModelAdapter {
  const build = (promptCachingOverride?: boolean): HttpModelAdapter => createHttpProvider({
    displayName: options.displayName ?? 'Anthropic',
    protocol: anthropicMessagesProtocol,
    baseUrl: options.baseUrl ?? ANTHROPIC_BASE_URL,
    auth: authOf(options),
    dialect: dialectOf(options, promptCachingOverride),
    describeModel: (info, effective) => ({
      ...info,
      reasoning: info.reasoning ?? reasoningInfo(effective.budgets),
    }),
    ...options.models === undefined ? {} : { models: options.models },
    ...options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens },
    ...options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow },
    ...options.streamIdleTimeoutMs === undefined
      ? {}
      : { streamIdleTimeoutMs: options.streamIdleTimeoutMs },
    ...transportLimits(options),
    ...options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy },
    ...options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger },
    ...options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger },
  })
  const primary = build()
  // Only wrapped when caching is actually requested: an adapter nobody asked
  // to cache anything with pays nothing extra.
  if (options.promptCaching !== true) return primary
  return new FieldFallbackAdapter(primary, build(false), { isFieldRejection: isCacheControlRejection })
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
    displayName: options.displayName ?? 'Anthropic',
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
    displayName: options.displayName ?? 'Anthropic',
    setup(registrar: ModelProviderRegistrar) {
      registrar.registerAdapter(routes, adapter)
    },
  })
}

function createRuntimeAnthropicAdapter(options: AnthropicProviderOptions): ModelAdapter {
  const build = (promptCachingOverride?: boolean): HttpModelAdapter => createRuntimeHttpProvider({
    displayName: options.displayName ?? 'Anthropic',
    protocol: anthropicMessagesProtocol,
    baseUrl: options.baseUrl ?? ANTHROPIC_BASE_URL,
    auth: authOf(options),
    dialect: dialectOf(options, promptCachingOverride),
    describeModel: (info, effective) => ({
      ...info,
      reasoning: info.reasoning ?? reasoningInfo(effective.budgets),
    }),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: options.defaultMaxTokens }),
    ...(options.defaultContextWindow === undefined ? {} : { defaultContextWindow: options.defaultContextWindow }),
    ...(options.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: options.streamIdleTimeoutMs }),
    ...transportLimits(options),
    ...(options.retryPolicy === undefined ? {} : { retryPolicy: options.retryPolicy }),
    ...(options.requestLogger === undefined ? {} : { requestLogger: options.requestLogger }),
    ...(options.responseLogger === undefined ? {} : { responseLogger: options.responseLogger }),
  })
  const primary = build()
  if (options.promptCaching !== true) return primary
  return new FieldFallbackAdapter(primary, build(false), { isFieldRejection: isCacheControlRejection })
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

/**
 * This API's own header is `x-api-key`, unlike most others' `authorization:
 * Bearer` — but a gateway sitting in front of it may expect Bearer instead.
 */
/**
 * Generic over the credential type on purpose: the two call sites accept
 * DIFFERENT ones — the legacy adapter takes {@link AnthropicCredential}
 * (`provider-http`'s string-or-resolver), the composable one takes core's
 * broader `CredentialInput`. A non-generic parameter union would widen
 * `apiKey` to the union of both and fit neither target scheme.
 */
function authOf<Credential>(options: {
  readonly authHeader?: 'x-api-key' | 'bearer'
  readonly apiKey: Credential
}) {
  return options.authHeader === 'bearer'
    ? { kind: 'bearer' as const, token: options.apiKey, label: 'the `apiKey` option' }
    : { kind: 'header' as const, name: 'x-api-key', value: options.apiKey, label: 'the `apiKey` option' }
}

const ANTHROPIC_REASONING_FORMATS = new Set(['output-config', 'thinking-budget'])

/**
 * Build the dialect, rejecting a `reasoningFormat` that isn't one of this
 * protocol's own two values. A JS caller (or one that fought past TypeScript
 * with `as any`) mistyping a value from a DIFFERENT protocol — Chat
 * Completions' `'deepseek'`, for instance — would otherwise fall through the
 * `reasoningFormat === 'thinking-budget'` checks in `serialize.ts` and
 * silently behave as `'output-config'` instead of failing loudly.
 */
/**
 * @param promptCachingOverride - Forces `promptCaching` regardless of what
 *   `options` asked for — how the fallback build (never marks
 *   `cache_control`) differs from the primary one when caching is on.
 *   Omitted, `options.promptCaching` decides as normal.
 */
function dialectOf(
  options: AnthropicAdapterOptions | AnthropicProviderOptions,
  promptCachingOverride?: boolean,
): Partial<AnthropicDialect> {
  if (options.reasoningFormat !== undefined && !ANTHROPIC_REASONING_FORMATS.has(options.reasoningFormat)) {
    throw new TypeError(
      `Anthropic reasoningFormat must be 'output-config' or 'thinking-budget', received ${JSON.stringify(options.reasoningFormat)}`,
    )
  }
  const budgets = options.thinkingBudgets ?? DEFAULT_THINKING_BUDGETS
  const promptCaching = promptCachingOverride ?? options.promptCaching
  return {
    budgets,
    ...(options.reasoningFormat === undefined ? {} : { reasoningFormat: options.reasoningFormat }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.beta === undefined ? {} : { beta: options.beta }),
    ...(promptCaching === undefined ? {} : { promptCaching }),
    ...(options.promptCachingTtl === undefined ? {} : { promptCachingTtl: options.promptCachingTtl }),
  }
}

/**
 * Recognize a dispatch rejection caused specifically by `cache_control` —
 * the one signal {@link FieldFallbackAdapter} is allowed to react to. Scoped
 * narrowly (a 400 whose message names the field) rather than treating every
 * 400 as a reason to give up on caching, which would mask a real, unrelated
 * request error behind a silent feature downgrade.
 */
function isCacheControlRejection(error: unknown): boolean {
  return error instanceof ModelError
    && error.failure.status === 400
    && error.message.toLowerCase().includes('cache_control')
}

function transportLimits(options: AnthropicAdapterOptions | AnthropicProviderOptions) {
  return {
    ...(options.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: options.allowInsecureHttp }),
    headers: endpointHeaders(options.headers),
    ...options.path === undefined ? {} : { path: options.path },
    ...options.query === undefined ? {} : { query: options.query },
    ...options.body === undefined ? {} : { body: options.body },
    ...options.transformRequest === undefined ? {} : { transformRequest: options.transformRequest },
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
