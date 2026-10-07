import type { RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
import {
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import type {
  ProviderCatalogModel,
  ProviderRequestLogger,
  ProviderResponseLogger,

} from '@alvin0/ai-agent-sdk-provider-http'
import {
  type CodexAuthStore,
  type CodexCredentialStore,
} from './auth.ts'
import {
  type CodexOAuthOptions,
} from './oauth.ts'

/** The ChatGPT-backed Codex API base. */
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'

/** Client identifier this endpoint expects. See the module note. */
export const CODEX_ORIGINATOR = 'codex_cli_rs'

/**
 * Client version sent when listing models.
 *
 * NOT cosmetic: the model catalog is gated on it, and an older value returns a
 * shorter list or an empty one. Verified against a live account — `0.45.0` returns
 * `{"models":[]}` while `1.0.0` returns the full set.
 */
export const CODEX_CLIENT_VERSION = '1.0.0'

/** One entry of the `/models` response. */
export interface WireCatalogModel {
  slug?: string
  display_name?: string
  description?: string
  input_modalities?: string[]
  output_modalities?: string[]
  // Use the route's operating window, never the optional max_context_window:
  // extended context can enter a higher-priced tier and must be an explicit choice.
  context_window?: number
  max_context_window?: number
  default_reasoning_level?: string
  supported_reasoning_levels?: Array<{
    effort?: string
    description?: string
  }>
}

/** Options for {@link codexAdapter}. */
export interface CodexAdapterOptions {
  /**
   * Where the credentials live.
   *
   * Required injection. Filesystem/env defaults belong to the Node auth wrapper.
   */
  authStore: CodexAuthStore
  /** Endpoint base; defaults to {@link CODEX_BASE_URL}. */
  baseUrl?: string
  /** Client identifier; defaults to {@link CODEX_ORIGINATOR}. */
  originator?: string
  /**
   * Model catalog.
   *
   * Left undefined, the adapter DISCOVERS it from the endpoint, which is the right
   * default here: the available models depend on the account's plan and on
   * {@link CODEX_CLIENT_VERSION}, so no hardcoded list could be correct for
   * everyone. Discovery also supplies `input_modalities`, without which every model
   * would be assumed text-only and image input silently stripped.
   *
   * One known gap: discovery currently reports only `text` and `image`, even for
   * models that do accept PDF input. Since an omitted modality is read as a
   * negative claim, document input is projected to text unless you override the
   * entry here with `inputModalities: ['text', 'image', 'document']`.
   */
  models?: readonly ProviderCatalogModel[]
  /** Client version used for catalog discovery; defaults to {@link CODEX_CLIENT_VERSION}. */
  clientVersion?: string
  /** Maximum raw model-catalog response bytes. Defaults to 4 MiB. */
  maxCatalogBytes?: number
  /** Maximum model entries accepted from discovery. Defaults to 2,048. */
  maxCatalogModels?: number
  /** Maximum response chunks accepted during discovery. Defaults to 10,000. */
  maxCatalogChunks?: number
  /** Model-catalog request deadline. Defaults to 30 seconds. */
  catalogTimeoutMs?: number
  catalogTtlMs?: number
  catalogStaleTtlMs?: number
  catalogFailureBackoffMs?: number
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
  /** Optional exact wire-request logger; credentials/account ids are redacted. */
  requestLogger?: ProviderRequestLogger
  /** Optional exact wire-response logger, fired once a stream ends. */
  responseLogger?: ProviderResponseLogger
  /** Issuer and client id overrides for token refresh. */
  oauth?: CodexOAuthOptions
  /**
   * Stable key letting the provider reuse a cached prompt prefix across turns.
   *
   * Defaults to one id captured by the adapter/provider-plugin instance. Every
   * conversation routed through that same instance shares the key. Use separate
   * plugin instances (and routes) when cache identity must be isolated; this is
   * not a conversation- or tenant-scoped setting.
   */
  promptCacheKey?: string
  fetch?: typeof globalThis.fetch
}

export interface CodexRevisionedAdapterOptions extends Omit<CodexAdapterOptions, 'authStore'> {
  readonly authStore: CodexCredentialStore
}

export interface CodexPluginOptions extends CodexAdapterOptions {
  /** Registry routes installed by the plugin. Defaults to `['codex']`. */
  readonly routes?: readonly string[]
}

export interface CodexProviderOptions extends CodexRevisionedAdapterOptions {
  readonly defaultModel?: string | ModelTarget
  readonly id?: string
  readonly routes?: readonly string[]
}
