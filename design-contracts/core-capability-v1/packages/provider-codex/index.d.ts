import {
  AgentSdkError,
  type ComposableModelProviderPlugin,
  type CredentialStore,
  type ModelAdapter,
  type ModelProviderPlugin,
  type RetryPolicyConfig,
} from '@ai-agent-sdk/core/provider'
/*
 * AgentSdkError is a runtime base class. All other core imports stay type-only
 * after declaration erasure.
 */
import type {
  HttpModelAdapter,
  ProviderCatalogModel,
  ProviderRequestLogger,
} from '@ai-agent-sdk/provider-http'

export { openAiResponsesProtocol } from '@ai-agent-sdk/protocol-responses'
export type { ResponsesDialect } from '@ai-agent-sdk/protocol-responses'

export declare const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export declare const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export declare const CODEX_CLIENT_VERSION = '1.0.0'
export declare const CODEX_ORIGINATOR = 'codex_cli_rs'
export declare const DEFAULT_CODEX_ISSUER = 'https://auth.openai.com'
export declare const ACCESS_TOKEN_REFRESH_WINDOW_MS: number
export declare const LAST_REFRESH_MAX_AGE_MS: number

/** Existing blind read/write contract, retained for source compatibility. */
export interface CodexAuthStore {
  readonly location: string
  read(): Promise<CodexAuthFile | undefined>
  write(file: CodexAuthFile): Promise<void>
}

/**
 * Revision-aware store used by the normal composable provider path.
 * This has a distinct name because repurposing CodexAuthStore would break users.
 */
export type CodexCredentialStore = CredentialStore<CodexAuthFile>

export interface CodexTokens {
  id_token: string
  access_token: string
  refresh_token: string
  account_id?: string | null
}

export interface CodexAuthFile {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: CodexTokens | null
  last_refresh?: string | null
}

export declare function memoryCodexAuthStore(initial?: CodexAuthFile): CodexAuthStore
export declare function memoryCodexCredentialStore(
  initial?: CodexAuthFile,
): CodexCredentialStore

export interface CodexJwtClaims {
  exp?: number
  email?: string
  accountId?: string
  planType?: string
  isFedramp: boolean
}

export declare function readJwtClaims(jwt: string): CodexJwtClaims | undefined
export declare function resolveAccountId(tokens: CodexTokens): string | undefined
export declare function isFedrampAccount(tokens: CodexTokens): boolean
export declare function shouldRefresh(file: CodexAuthFile, now?: number): boolean
export declare function requireTokens(
  file: CodexAuthFile | undefined,
  location: string,
): CodexTokens

export interface CodexOAuthOptions {
  issuer?: string
  clientId?: string
  signal?: AbortSignal
  fetch?: typeof fetch
  requestTimeoutMs?: number
  maxResponseBytes?: number
  maxResponseChunks?: number
  allowInsecureIssuer?: boolean
}

export interface CodexDeviceCode {
  verificationUrl: string
  userCode: string
  deviceAuthId: string
  intervalSeconds: number
}

export interface CodexLoginProgress {
  onPrompt?: (code: CodexDeviceCode) => void
  onPoll?: (elapsedMs: number) => void
}

export interface CodexLoginResult {
  location: string
  email: string | undefined
  accountId: string | undefined
  planType: string | undefined
}

export declare function requestDeviceCode(
  options?: CodexOAuthOptions,
): Promise<CodexDeviceCode>
export declare function runDeviceCodeLogin(
  store: CodexCredentialStore,
  options?: CodexOAuthOptions,
  progress?: CodexLoginProgress,
): Promise<CodexLoginResult>
/** @deprecated Prefer a CodexCredentialStore so rotating tokens use compare-and-swap. */
export declare function runDeviceCodeLogin(
  store: CodexAuthStore,
  options?: CodexOAuthOptions,
  progress?: CodexLoginProgress,
): Promise<CodexLoginResult>

export type RefreshFailureKind = 'permanent' | 'transient'

export declare class CodexRefreshError extends AgentSdkError {
  readonly kind: RefreshFailureKind
  constructor(message: string, kind: RefreshFailureKind, options?: ErrorOptions)
}

export declare function refreshCodexTokens(
  store: CodexCredentialStore,
  options?: CodexOAuthOptions,
): Promise<CodexTokens>
/** @deprecated Prefer a CodexCredentialStore so rotating tokens use compare-and-swap. */
export declare function refreshCodexTokens(
  store: CodexAuthStore,
  options?: CodexOAuthOptions,
): Promise<CodexTokens>

/** Existing advanced adapter options, retained with the legacy store shape. */
export interface CodexAdapterOptions {
  authStore: CodexAuthStore
  baseUrl?: string
  originator?: string
  models?: readonly ProviderCatalogModel[]
  clientVersion?: string
  maxCatalogBytes?: number
  maxCatalogModels?: number
  maxCatalogChunks?: number
  catalogTimeoutMs?: number
  catalogTtlMs?: number
  catalogStaleTtlMs?: number
  catalogFailureBackoffMs?: number
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
  oauth?: CodexOAuthOptions
  /** One provider-plugin-instance cache/session hint; not a conversation boundary. */
  promptCacheKey?: string
  fetch?: typeof globalThis.fetch
}

/** Revision-safe adapter options for new composition. */
export interface CodexRevisionedAdapterOptions
  extends Omit<CodexAdapterOptions, 'authStore'> {
  readonly authStore: CodexCredentialStore
}

/** Existing plugin options and return contract. */
export interface CodexPluginOptions extends CodexAdapterOptions {
  readonly routes?: readonly string[]
}

/** Normal immutable provider-plugin composition with inert route claims. */
export interface CodexProviderOptions extends CodexRevisionedAdapterOptions {
  /** String requires exactly one claimed route; object names the desired claimed route. */
  readonly defaultModel?: string | import('@ai-agent-sdk/core/provider').ModelTarget
  /** Defaults to codex; when routes are omitted this is also the sole route. */
  readonly id?: string
  /** Explicit aliases; omission claims the selected id. */
  readonly routes?: readonly string[]
}

export declare function codexAdapter(options: CodexAdapterOptions): HttpModelAdapter
export declare function codexAdapter(options: CodexRevisionedAdapterOptions): HttpModelAdapter
export declare function codexPlugin(
  options: CodexProviderOptions,
): ComposableModelProviderPlugin & { readonly family: 'codex' }
export declare function codexPlugin(options: CodexPluginOptions): ModelProviderPlugin
