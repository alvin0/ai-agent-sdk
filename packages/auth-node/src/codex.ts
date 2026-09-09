/** Node wrapper over the injected-store Universal Codex provider. */

import type {
  ComposableModelProviderPlugin,
  ModelProviderPlugin,
  ModelProviderRegistrar,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexAdapter as universalCodexAdapter,
  codexPlugin as universalCodexPlugin,
  type CodexAdapterOptions as UniversalCodexAdapterOptions,
  type CodexAuthStore,
  type CodexCredentialStore,
  type CodexProviderOptions,
} from '@alvin0/ai-agent-sdk-provider-codex'
import { fileCodexAuthStore, fileCodexCredentialStore } from './codex-store.ts'

export { CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR }

export interface CodexNodeAdapterOptions extends Omit<UniversalCodexAdapterOptions, 'authStore'> {
  /** Omit only in the Node compatibility wrapper to use the project-local file store. */
  readonly authStore?: CodexAuthStore
}

export interface CodexNodePluginOptions extends CodexNodeAdapterOptions {
  readonly routes?: readonly string[]
}

/** @deprecated Use {@link codexNodeProviderPlugin} for normal runtime composition. */
export function codexNodeAdapter(
  options: CodexNodeAdapterOptions = {},
): ReturnType<typeof universalCodexAdapter> {
  return universalCodexAdapter({
    ...options,
    authStore: options.authStore ?? fileCodexAuthStore(),
  })
}

/** @deprecated Use {@link codexNodeProviderPlugin}. */
export function codexNodePlugin(options: CodexNodePluginOptions = {}): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['codex'])])
  const adapter = codexNodeAdapter(options)
  return Object.freeze({
    id: 'codex', displayName: 'Codex',
    setup: (registrar: ModelProviderRegistrar) => { registrar.registerAdapter(routes, adapter) },
  })
}

export interface CodexNodeProviderOptions extends Omit<CodexProviderOptions, 'authStore'> {
  readonly authStore?: CodexCredentialStore
}

/** Preferred Node composition plugin backed by revision-safe file credentials by default. */
export function codexNodeProviderPlugin(
  options: CodexNodeProviderOptions = {},
): ComposableModelProviderPlugin & { readonly family: 'codex' } {
  return universalCodexPlugin({
    ...options,
    authStore: options.authStore ?? fileCodexCredentialStore(),
  })
}

/** Compatibility alias for the former `ai-agent-sdk/codex` entry. */
export const codexAdapter = codexNodeAdapter
/** Compatibility alias for the former `ai-agent-sdk/codex` entry. */
export const codexPlugin = codexNodePlugin
export type CodexAdapterOptions = CodexNodeAdapterOptions
export type CodexPluginOptions = CodexNodePluginOptions

export {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  CODEX_CLIENT_ID,
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
  type CodexAuthFile,
  type CodexAuthStore,
  type CodexCredentialStore,
  type CodexDeviceCode,
  type CodexJwtClaims,
  type CodexLoginProgress,
  type CodexLoginResult,
  type CodexOAuthOptions,
  type CodexTokens,
  type RefreshFailureKind,
} from '@alvin0/ai-agent-sdk-provider-codex'
export {
  CODEX_AUTH_PATH_ENV,
  DEFAULT_CODEX_AUTH_PATH,
  fileCodexAuthStore,
  fileCodexCredentialStore,
  resolveCodexAuthPath,
  type CodexAuthPathOptions,
} from './codex-store.ts'
