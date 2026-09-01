/**
 * Codex provider: the ChatGPT-backed Codex endpoint, authenticated with this
 * project's own credential store rather than the Codex CLI's global one.
 *
 * Sign in with `npm run provider:codex:login-device`.
 */

export {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  codexAdapter,
  type CodexAdapterOptions,
} from './adapter.ts'
export {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  CODEX_AUTH_PATH_ENV,
  DEFAULT_CODEX_AUTH_PATH,
  LAST_REFRESH_MAX_AGE_MS,
  fileCodexAuthStore,
  isFedrampAccount,
  memoryCodexAuthStore,
  readJwtClaims,
  requireTokens,
  resolveAccountId,
  resolveCodexAuthPath,
  shouldRefresh,
  type CodexAuthFile,
  type CodexAuthStore,
  type CodexJwtClaims,
  type CodexTokens,
} from './auth-file.ts'
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
