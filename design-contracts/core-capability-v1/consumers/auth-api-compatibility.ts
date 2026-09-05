import {
  apiKeyFromEnv as rootApiKeyFromEnv,
  envCredential as rootEnvCredential,
} from '@compat/auth-root'
import {
  apiKeyFromEnv as pathApiKeyFromEnv,
  envCredential as pathEnvCredential,
} from '@compat/auth-env'
import {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  CODEX_AUTH_PATH_ENV,
  CODEX_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CodexRefreshError,
  DEFAULT_CODEX_AUTH_PATH,
  DEFAULT_CODEX_ISSUER,
  LAST_REFRESH_MAX_AGE_MS,
  codexAdapter,
  codexNodeAdapter,
  codexNodePlugin,
  codexPlugin,
  fileCodexAuthStore,
  isFedrampAccount,
  memoryCodexAuthStore,
  readJwtClaims,
  refreshCodexTokens,
  requestDeviceCode,
  requireTokens,
  resolveAccountId,
  resolveCodexAuthPath,
  runDeviceCodeLogin,
  shouldRefresh,
  type CodexAdapterOptions,
  type CodexAuthFile,
  type CodexAuthPathOptions,
  type CodexAuthStore,
  type CodexDeviceCode,
  type CodexJwtClaims,
  type CodexLoginProgress,
  type CodexLoginResult,
  type CodexNodeAdapterOptions,
  type CodexNodePluginOptions,
  type CodexOAuthOptions,
  type CodexPluginOptions,
  type CodexTokens,
  type RefreshFailureKind,
} from '@compat/auth-codex'
import {
  codexAdapter as universalCodexAdapter,
  codexPlugin as universalCodexPlugin,
  openAiResponsesProtocol,
  type CodexAdapterOptions as UniversalCodexAdapterOptions,
  type CodexPluginOptions as UniversalCodexPluginOptions,
  type ResponsesDialect,
} from '@compat/provider-codex'

export type AuthCompatibilityTypes = [
  CodexAdapterOptions,
  CodexAuthFile,
  CodexAuthPathOptions,
  CodexAuthStore,
  CodexDeviceCode,
  CodexJwtClaims,
  CodexLoginProgress,
  CodexLoginResult,
  CodexNodeAdapterOptions,
  CodexNodePluginOptions,
  CodexOAuthOptions,
  CodexPluginOptions,
  CodexTokens,
  RefreshFailureKind,
  UniversalCodexAdapterOptions,
  UniversalCodexPluginOptions,
  ResponsesDialect,
]

export const authCompatibilityValues = {
  ACCESS_TOKEN_REFRESH_WINDOW_MS,
  CODEX_AUTH_PATH_ENV,
  CODEX_BASE_URL,
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CodexRefreshError,
  DEFAULT_CODEX_AUTH_PATH,
  DEFAULT_CODEX_ISSUER,
  LAST_REFRESH_MAX_AGE_MS,
  codexAdapter,
  codexNodeAdapter,
  codexNodePlugin,
  codexPlugin,
  fileCodexAuthStore,
  isFedrampAccount,
  memoryCodexAuthStore,
  readJwtClaims,
  refreshCodexTokens,
  requestDeviceCode,
  requireTokens,
  resolveAccountId,
  resolveCodexAuthPath,
  runDeviceCodeLogin,
  shouldRefresh,
  universalCodexAdapter,
  universalCodexPlugin,
  openAiResponsesProtocol,
}

const mutableFile: CodexAuthFile = {}
mutableFile.auth_mode = 'chatgpt'
mutableFile.last_refresh = null

const legacyStore: CodexAuthStore = {
  location: '/fixture/auth.json',
  async read() { return mutableFile },
  async write(file) {
    if (file.tokens === undefined) delete mutableFile.tokens
    else mutableFile.tokens = file.tokens
  },
}

const callableRootCredential: () => string = rootEnvCredential('ROOT_TOKEN')
const callableRootAlias: () => string = rootApiKeyFromEnv('ROOT_TOKEN')
const callablePathCredential: () => string = pathEnvCredential('PATH_TOKEN')
const callablePathAlias: () => string = pathApiKeyFromEnv('PATH_TOKEN')

const nodeOptions: CodexNodeAdapterOptions = { authStore: legacyStore }
const nodePluginOptions: CodexNodePluginOptions = {
  authStore: legacyStore,
  routes: ['codex-compatibility'],
}
const universalOptions: UniversalCodexAdapterOptions = {
  authStore: legacyStore,
  promptCacheKey: 'compatibility-cache-key',
}
const universalPluginOptions: UniversalCodexPluginOptions = {
  ...universalOptions,
  routes: ['codex-compatibility'],
}

/** Compile-only representative use of every signature-sensitive compatibility path. */
export function exerciseAuthCompatibility(): void {
  void callableRootCredential
  void callableRootAlias
  void callablePathCredential
  void callablePathAlias
  void codexNodeAdapter(nodeOptions)
  void codexNodePlugin(nodePluginOptions)
  void codexAdapter(nodeOptions)
  void codexPlugin(nodePluginOptions)
  void universalCodexAdapter(universalOptions)
  void universalCodexPlugin(universalPluginOptions)
  void fileCodexAuthStore(undefined, { cwd: '/fixture', env: {} })
  void resolveCodexAuthPath(undefined, { cwd: '/fixture', env: {} })
  void memoryCodexAuthStore(mutableFile)
  void runDeviceCodeLogin(legacyStore)
  void refreshCodexTokens(legacyStore)
}
