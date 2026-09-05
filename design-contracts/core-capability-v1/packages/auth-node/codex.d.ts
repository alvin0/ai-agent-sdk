import type { ModelAdapter, ModelProviderPlugin } from '@ai-agent-sdk/core/provider'
import type {
  CodexAdapterOptions as UniversalCodexAdapterOptions,
  CodexAuthStore,
  CodexCredentialStore,
  CodexProviderOptions,
} from '@ai-agent-sdk/provider-codex'

export {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  CODEX_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CodexRefreshError,
  DEFAULT_CODEX_ISSUER,
  LAST_REFRESH_MAX_AGE_MS,
  isFedrampAccount,
  memoryCodexAuthStore,
  memoryCodexCredentialStore,
  readJwtClaims,
  refreshCodexTokens,
  requestDeviceCode,
  requireTokens,
  resolveAccountId,
  runDeviceCodeLogin,
  shouldRefresh,
} from '@ai-agent-sdk/provider-codex'
export type {
  CodexAuthFile,
  CodexAuthStore,
  CodexCredentialStore,
  CodexDeviceCode,
  CodexJwtClaims,
  CodexLoginProgress,
  CodexLoginResult,
  CodexOAuthOptions,
  CodexTokens,
  RefreshFailureKind,
} from '@ai-agent-sdk/provider-codex'

export declare const DEFAULT_CODEX_AUTH_PATH = '.providers/.codex/auth.json'
export declare const CODEX_AUTH_PATH_ENV = 'AI_AGENT_SDK_CODEX_AUTH'

export interface CodexAuthPathOptions {
  /** Base for relative paths. Defaults to process.cwd(). */
  readonly cwd?: string
  /** Environment source. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export declare function resolveCodexAuthPath(
  explicitPath?: string,
  options?: CodexAuthPathOptions,
): string

/** Existing blind store retained for source compatibility. */
export declare function fileCodexAuthStore(
  path?: string,
  options?: CodexAuthPathOptions,
): CodexAuthStore

/** Preferred compare-and-swap file store for new provider composition. */
export declare function fileCodexCredentialStore(
  path?: string,
  options?: CodexAuthPathOptions,
): CodexCredentialStore

export interface CodexNodeAdapterOptions
  extends Omit<UniversalCodexAdapterOptions, 'authStore'> {
  /** Omit only in the compatibility wrapper to use the project-local file store. */
  readonly authStore?: CodexAuthStore
}

export interface CodexNodePluginOptions extends CodexNodeAdapterOptions {
  readonly routes?: readonly string[]
}

export declare function codexNodeAdapter(
  options?: CodexNodeAdapterOptions,
): ModelAdapter
export declare function codexNodePlugin(
  options?: CodexNodePluginOptions,
): ModelProviderPlugin

export interface CodexNodeProviderOptions
  extends Omit<CodexProviderOptions, 'authStore'> {
  readonly authStore?: CodexCredentialStore
}

/** Preferred Node convenience: revisioned file auth plus a composable provider plugin. */
export declare function codexNodeProviderPlugin(
  options?: CodexNodeProviderOptions,
): import('@ai-agent-sdk/core/provider').ComposableModelProviderPlugin & {
  readonly family: 'codex'
}

/** Compatibility alias for the former ai-agent-sdk/codex entry. */
export declare const codexAdapter: typeof codexNodeAdapter
/** Compatibility alias for the former ai-agent-sdk/codex entry. */
export declare const codexPlugin: typeof codexNodePlugin
export type CodexAdapterOptions = CodexNodeAdapterOptions
export type CodexPluginOptions = CodexNodePluginOptions
