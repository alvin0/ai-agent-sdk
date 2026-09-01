/** Node wrapper over the injected-store Universal Codex provider. */

import type { ModelProviderPlugin, ModelProviderRegistrar } from '@ai-agent-sdk/core'
import {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexAdapter as universalCodexAdapter,
  type CodexAdapterOptions as UniversalCodexAdapterOptions,
  type CodexAuthStore,
} from '@ai-agent-sdk/provider-codex'
import { fileCodexAuthStore } from './codex-store.ts'

export { CODEX_BASE_URL, CODEX_CLIENT_VERSION, CODEX_ORIGINATOR }

export interface CodexNodeAdapterOptions extends Omit<UniversalCodexAdapterOptions, 'authStore'> {
  /** Omit only in the Node compatibility wrapper to use the project-local file store. */
  readonly authStore?: CodexAuthStore
}

export interface CodexNodePluginOptions extends CodexNodeAdapterOptions {
  readonly routes?: readonly string[]
}

export function codexNodeAdapter(
  options: CodexNodeAdapterOptions = {},
): ReturnType<typeof universalCodexAdapter> {
  return universalCodexAdapter({
    ...options,
    authStore: options.authStore ?? fileCodexAuthStore(),
  })
}

export function codexNodePlugin(options: CodexNodePluginOptions = {}): ModelProviderPlugin {
  const routes = Object.freeze([...(options.routes ?? ['codex'])])
  const adapter = codexNodeAdapter(options)
  return Object.freeze({
    id: 'codex', displayName: 'Codex',
    setup: (registrar: ModelProviderRegistrar) => { registrar.registerAdapter(routes, adapter) },
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
  readJwtClaims,
  refreshCodexTokens,
  requestDeviceCode,
  requireTokens,
  resolveAccountId,
  runDeviceCodeLogin,
  shouldRefresh,
  type CodexAuthFile,
  type CodexAuthStore,
  type CodexDeviceCode,
  type CodexJwtClaims,
  type CodexLoginProgress,
  type CodexLoginResult,
  type CodexOAuthOptions,
  type CodexTokens,
  type RefreshFailureKind,
} from '@ai-agent-sdk/provider-codex'
export {
  CODEX_AUTH_PATH_ENV,
  DEFAULT_CODEX_AUTH_PATH,
  fileCodexAuthStore,
  resolveCodexAuthPath,
  type CodexAuthPathOptions,
} from './codex-store.ts'
