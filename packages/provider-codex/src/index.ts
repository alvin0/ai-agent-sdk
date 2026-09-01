/** Universal Codex provider, OAuth flows, and injected auth contracts. */

export {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexAdapter,
  codexPlugin,
  type CodexAdapterOptions,
  type CodexPluginOptions,
} from './adapter.ts'
export {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  LAST_REFRESH_MAX_AGE_MS,
  isFedrampAccount,
  memoryCodexAuthStore,
  readJwtClaims,
  requireTokens,
  resolveAccountId,
  shouldRefresh,
  type CodexAuthFile,
  type CodexAuthStore,
  type CodexJwtClaims,
  type CodexTokens,
} from './auth.ts'
export {
  CODEX_CLIENT_ID,
  CodexRefreshError,
  DEFAULT_CODEX_ISSUER,
  refreshCodexTokens,
  requestDeviceCode,
  runDeviceCodeLogin,
  type CodexDeviceCode,
  type CodexLoginProgress,
  type CodexLoginResult,
  type CodexOAuthOptions,
  type RefreshFailureKind,
} from './oauth.ts'
export {
  openAiResponsesProtocol,
  type ResponsesDialect,
} from '@ai-agent-sdk/protocol-responses'
