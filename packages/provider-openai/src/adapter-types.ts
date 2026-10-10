import type { RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import {
  type CredentialInput,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import { type OpenAiApi } from './dual-api.ts'
import type {
  HeaderContext,
  ProviderCatalogModel,
  ProviderRequestLogger,
  ProviderResponseLogger,
  RequestContext,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  type CredentialSource,
} from '@alvin0/ai-agent-sdk-provider-http'
import {
  type ChatCompletionsDialect,
} from '@alvin0/ai-agent-sdk-protocol-openai-chat-completions'

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
  /**
   * How this route's failures are classified as retryable. Classification
   * only: nothing retries until the adapter is wrapped with `withRetry`.
   */
  retryPolicy?: RetryPolicyConfig
  /** Optional exact wire-request logger; credentials are redacted. */
  requestLogger?: ProviderRequestLogger
  /** Optional exact wire-response logger, fired once a stream ends. */
  responseLogger?: ProviderResponseLogger
  fetch?: typeof globalThis.fetch
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

