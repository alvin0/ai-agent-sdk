/**
 * Public surface of the Copilot provider.
 *
 * The three `Client_Identity_Constants` are exported here on purpose: a caller
 * has to be able to read the client identity this SDK presents and override it.
 *
 * @module ai-agent-sdk/providers/copilot
 */

export {
  COPILOT_BASE_URL,
  COPILOT_DISPLAY_NAME,
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  COPILOT_ROUTE_ID,
  copilotAdapter,
  copilotPlugin,
  type CopilotEditorHeaders,
  type CopilotLegacyProviderOptions,
  type CopilotPluginOptions,
  type CopilotProviderOptions,
} from './adapter.ts'
export {
  COPILOT_LOGIN_COMMAND,
  COPILOT_TOKEN_EXCHANGE_MARGIN_MS,
  memoryCopilotAuthStore,
  memoryCopilotCredentialStore,
  requireGitHubToken,
  shouldExchange,
  type CopilotAccountIdentity,
  type CopilotAuthFile,
  type CopilotAuthStore,
  type CopilotCredentialSnapshot,
  type CopilotCredentialStore,
  type CopilotGitHubToken,
  type CopilotTokenExpiry,
} from './auth.ts'
export {
  COPILOT_CATALOG_PATH,
  COPILOT_DEFAULT_CATALOG_TIMEOUT_MS,
  COPILOT_DEFAULT_MAX_CATALOG_BYTES,
  COPILOT_DEFAULT_MAX_CATALOG_CHUNKS,
  COPILOT_DEFAULT_MAX_CATALOG_MODELS,
  copilotCatalogCacheOptions,
  discoverCopilotModels,
  partitionCopilotCatalog,
  resolveCopilotCatalogLimits,
  type CopilotCatalogLimits,
  type CopilotCatalogOptions,
  type CopilotCatalogSnapshot,
  type CopilotEmbeddingModel,
  type CopilotEndpoint,
  type CopilotGenerationModel,
  type CopilotOmitReason,
  type CopilotOmittedModel,
} from './catalog.ts'
export {
  COPILOT_DEFAULT_DIALECT,
  COPILOT_DUAL_PROTOCOL_ID,
  copilotDualProtocol,
  toChatCompletionsDialect,
  toResponsesDialect,
  type ChatCompletionsProtocolLike,
  type CopilotDialect,
  type CopilotDualProtocolOptions,
  type CopilotSubProtocol,
  type ResponsesProtocolLike,
} from './dual-protocol.ts'
export {
  COPILOT_ERROR_CODES,
  CopilotDeviceLoginError,
  CopilotTokenExchangeError,
  credentialFailure,
  type CopilotCredentialFailure,
  type CopilotDeviceLoginReason,
  type CopilotErrorCode,
  type CopilotTokenExchangeFailureKind,
} from './errors.ts'
export {
  COPILOT_PROVIDER_ID,
  COPILOT_TOKEN_EXCHANGE_PATH,
  createCopilotTokenCache,
  DEFAULT_GITHUB_API_BASE_URL,
  exchangeCopilotToken,
  type CopilotApiToken,
  type CopilotExchangeOptions,
  type CopilotTokenCache,
  type CopilotTokenCacheEntry,
  type CopilotTokenCacheOptions,
} from './exchange.ts'
export {
  COPILOT_DEFAULT_POLL_INTERVAL_SECONDS,
  COPILOT_DEVICE_CODE_MAX_WAIT_MS,
  COPILOT_DEVICE_LOGIN_WARNING,
  COPILOT_OAUTH_CLIENT_ID,
  COPILOT_OAUTH_SCOPE,
  COPILOT_SLOW_DOWN_INCREMENT_SECONDS,
  DEFAULT_COPILOT_OAUTH_ISSUER,
  DEFAULT_COPILOT_TIMER,
  requestCopilotDeviceCode,
  runCopilotDeviceLogin,
  type CopilotDeviceCode,
  type CopilotLoginProgress,
  type CopilotLoginResult,
  type CopilotOAuthOptions,
  type CopilotTimer,
} from './oauth.ts'
export {
  COPILOT_RESPONSES_MODEL_PREFIXES,
  createCopilotEndpointRouter,
  type CopilotEndpointDecision,
  type CopilotEndpointRouter,
  type CopilotEndpointRouterOptions,
} from './router.ts'
