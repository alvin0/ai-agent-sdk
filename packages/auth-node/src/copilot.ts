/**
 * Node wrapper over the injected-store Universal Copilot provider.
 *
 * A deliberate mirror of `./codex.ts` and just as thin: the ONLY thing this module
 * does is default `authStore` to the project-local file store, because paths, the
 * filesystem and the environment belong to this package and never to a Universal
 * one (Requirements 6.5, 18.2). Everything else here is a re-export of the
 * Universal surface so a Node caller needs one import specifier instead of two.
 *
 * Unlike `./codex.ts` there are no `@deprecated` compatibility aliases: Copilot
 * ships with no former entry point to stay compatible with.
 *
 * @module ai-agent-sdk/auth-node/copilot
 */

import type { ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import {
  copilotPlugin as universalCopilotPlugin,
  type CopilotCredentialStore,
  type CopilotProviderOptions,
} from '@alvin0/ai-agent-sdk-provider-copilot'
import { fileCopilotCredentialStore } from './copilot-store.ts'

export interface CopilotNodeProviderOptions extends Omit<CopilotProviderOptions, 'authStore'> {
  /** Omit to use the project-local file credential store. */
  readonly authStore?: CopilotCredentialStore
}

/** Preferred Node composition plugin backed by revision-safe file credentials by default. */
export function copilotNodeProviderPlugin(
  options: CopilotNodeProviderOptions = {},
): ComposableModelProviderPlugin & { readonly family: 'copilot' } {
  return universalCopilotPlugin({
    ...options,
    authStore: options.authStore ?? fileCopilotCredentialStore(),
  })
}

export {
  COPILOT_BASE_URL,
  COPILOT_CATALOG_PATH,
  COPILOT_DEFAULT_CATALOG_TIMEOUT_MS,
  COPILOT_DEFAULT_DIALECT,
  COPILOT_DEFAULT_MAX_CATALOG_BYTES,
  COPILOT_DEFAULT_MAX_CATALOG_CHUNKS,
  COPILOT_DEFAULT_MAX_CATALOG_MODELS,
  COPILOT_DEFAULT_POLL_INTERVAL_SECONDS,
  COPILOT_DEVICE_CODE_MAX_WAIT_MS,
  COPILOT_DEVICE_LOGIN_WARNING,
  COPILOT_DISPLAY_NAME,
  COPILOT_DUAL_PROTOCOL_ID,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_ERROR_CODES,
  COPILOT_LOGIN_COMMAND,
  COPILOT_OAUTH_CLIENT_ID,
  COPILOT_OAUTH_SCOPE,
  COPILOT_PROVIDER_ID,
  COPILOT_RESPONSES_MODEL_PREFIXES,
  COPILOT_ROUTE_ID,
  COPILOT_SLOW_DOWN_INCREMENT_SECONDS,
  COPILOT_TOKEN_EXCHANGE_MARGIN_MS,
  COPILOT_TOKEN_EXCHANGE_PATH,
  CopilotDeviceLoginError,
  CopilotTokenExchangeError,
  DEFAULT_COPILOT_OAUTH_ISSUER,
  DEFAULT_COPILOT_TIMER,
  DEFAULT_GITHUB_API_BASE_URL,
  copilotAdapter,
  copilotCatalogCacheOptions,
  copilotDualProtocol,
  copilotPlugin,
  createCopilotEndpointRouter,
  createCopilotTokenCache,
  credentialFailure,
  discoverCopilotModels,
  exchangeCopilotToken,
  getCopilotToken,
  type GetCopilotTokenOptions,
  memoryCopilotAuthStore,
  memoryCopilotCredentialStore,
  partitionCopilotCatalog,
  requestCopilotDeviceCode,
  requireGitHubToken,
  resolveCopilotCatalogLimits,
  runCopilotDeviceLogin,
  shouldExchange,
  toChatCompletionsDialect,
  toResponsesDialect,
  type ChatCompletionsProtocolLike,
  type CopilotAccountIdentity,
  type CopilotApiToken,
  type CopilotAuthFile,
  type CopilotAuthStore,
  type CopilotCatalogLimits,
  type CopilotCatalogOptions,
  type CopilotCatalogSnapshot,
  type CopilotCredentialFailure,
  type CopilotCredentialSnapshot,
  type CopilotCredentialStore,
  type CopilotDeviceCode,
  type CopilotDeviceLoginReason,
  type CopilotDialect,
  type CopilotDualProtocolOptions,
  type CopilotEditorHeaders,
  type CopilotEmbeddingModel,
  type CopilotEndpoint,
  type CopilotEndpointDecision,
  type CopilotEndpointRouter,
  type CopilotEndpointRouterOptions,
  type CopilotErrorCode,
  type CopilotExchangeOptions,
  type CopilotGenerationModel,
  type CopilotGitHubToken,
  type CopilotLegacyProviderOptions,
  type CopilotLoginProgress,
  type CopilotLoginResult,
  type CopilotOAuthOptions,
  type CopilotOmitReason,
  type CopilotOmittedModel,
  type CopilotPluginOptions,
  type CopilotProviderOptions,
  type CopilotSubProtocol,
  type CopilotTimer,
  type CopilotTokenCache,
  type CopilotTokenCacheEntry,
  type CopilotTokenCacheOptions,
  type CopilotTokenExchangeFailureKind,
  type CopilotTokenExpiry,
  type ResponsesProtocolLike,
} from '@alvin0/ai-agent-sdk-provider-copilot'
export {
  COPILOT_AUTH_PATH_ENV,
  DEFAULT_COPILOT_AUTH_PATH,
  fileCopilotAuthStore,
  fileCopilotCredentialStore,
  resolveCopilotAuthPath,
  type CopilotAuthPathOptions,
} from './copilot-store.ts'
