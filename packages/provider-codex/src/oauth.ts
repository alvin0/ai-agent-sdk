import {
  readJwtClaims,
  requireTokens,
  shouldRefresh,
  type CodexAuthStore,
  type CodexCredentialStore,
  type CodexTokens,

} from './auth.ts'
import { captureCodexStore } from './common/store-capture.ts'
import type {
  AnyCodexStore,
  CodexOAuthOptions,
  GetCodexTokensOptions,
  CodexLoginProgress,
  CodexLoginResult,
} from './oauth-types.ts'
import { credentialOperation, readStore, commitStore, storeLabel } from './oauth-store.ts'
import { requestDeviceCode, pollForAuthorization, exchangeCodeForTokens, authFileFor } from './oauth-device.ts'
import { refreshCodexTokensWithOperation } from './oauth-refresh.ts'
import {
  authorizationCodeFrom,
  type CodexBrowserAuthorization,
  type CodexBrowserCallback,
} from './oauth-browser.ts'
import type { CapturedCodexStore } from './common/store-capture.ts'
import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
export { refreshCodexTokensWithOperation } from './oauth-refresh.ts'
export { requestDeviceCode } from './oauth-device.ts'
export {
  CODEX_BROWSER_CALLBACK_PATH,
  CODEX_BROWSER_CALLBACK_PORT,
  createBrowserAuthorization,
  type CodexBrowserAuthorization,
  type CodexBrowserAuthorizationOptions,
  type CodexBrowserCallback,
} from './oauth-browser.ts'
export { CodexRefreshError } from './oauth-errors.ts'
export type { RefreshFailureKind } from './oauth-errors.ts'
export { DEFAULT_CODEX_ISSUER, CODEX_CLIENT_ID } from './oauth-types.ts'
export type {
  CodexOAuthOptions,
  GetCodexTokensOptions,
  CodexDeviceCode,
  CodexLoginProgress,
  CodexLoginResult,
} from './oauth-types.ts'

/**
 * Read Codex tokens from an injected store, refreshing and committing when due.
 * Database stores implement read/commit; no filesystem or environment is consulted.
 * For an unconditional refresh use refreshCodexTokens with the same store.
 */
export async function getCodexTokens(
  store: CodexCredentialStore | CodexAuthStore,
  options: GetCodexTokensOptions = {},
): Promise<CodexTokens> {
  const operation = credentialOperation(options.signal)
  operation.signal.throwIfAborted()
  const captured = captureCodexStore(store)
  const snapshot = await readStore(captured, operation)
  operation.signal.throwIfAborted()
  const tokens = requireTokens(snapshot.file, captured.label)
  if (options.refreshIfNeeded !== false && snapshot.file !== undefined && shouldRefresh(snapshot.file)) {
    return refreshCodexTokensWithOperation(store, options, operation)
  }
  return tokens
}

/**
 * Run a full device-code login and persist the result.
 * @param store - where to write the credentials.
 * @param options - issuer, client id, cancellation.
 * @param progress - prompt and poll notifications for a CLI to render.
 * @returns a summary of who signed in and where it was stored.
 */
export function runDeviceCodeLogin(
  store: CodexCredentialStore,
  options?: CodexOAuthOptions,
  progress?: CodexLoginProgress,
): Promise<CodexLoginResult>
export function runDeviceCodeLogin(
  store: CodexAuthStore,
  options?: CodexOAuthOptions,
  progress?: CodexLoginProgress,
): Promise<CodexLoginResult>
export async function runDeviceCodeLogin(
  store: AnyCodexStore,
  options: CodexOAuthOptions = {},
  progress: CodexLoginProgress = {},
): Promise<CodexLoginResult> {
  const captured = captureCodexStore(store)
  const operation = credentialOperation(options.signal)
  const initial = await readStore(captured, operation)
  const code = await requestDeviceCode(options)
  try { progress.onPrompt?.(code) } catch { /* progress observers do not own authentication */ }
  const grant = await pollForAuthorization(code, options, progress)
  const tokens = await exchangeCodeForTokens(grant, options)
  return await persistLogin(captured, tokens, initial.revision, operation)
}

/**
 * Finish a browser login started with {@link createBrowserAuthorization}: check
 * the callback's `state`, exchange its code with the PKCE verifier, and persist
 * the tokens. Pass the same issuer/client options the authorization used.
 * @param store - where to write the credentials.
 * @param authorization - the pending login the callback belongs to.
 * @param callback - the callback URL, its query string, or its parameters.
 * @param options - issuer, client id, cancellation.
 * @returns a summary of who signed in and where it was stored.
 */
export function completeBrowserLogin(
  store: CodexCredentialStore,
  authorization: CodexBrowserAuthorization,
  callback: CodexBrowserCallback,
  options?: CodexOAuthOptions,
): Promise<CodexLoginResult>
export function completeBrowserLogin(
  store: CodexAuthStore,
  authorization: CodexBrowserAuthorization,
  callback: CodexBrowserCallback,
  options?: CodexOAuthOptions,
): Promise<CodexLoginResult>
export async function completeBrowserLogin(
  store: AnyCodexStore,
  authorization: CodexBrowserAuthorization,
  callback: CodexBrowserCallback,
  options: CodexOAuthOptions = {},
): Promise<CodexLoginResult> {
  const authorizationCode = authorizationCodeFrom(authorization, callback)
  const captured = captureCodexStore(store)
  const operation = credentialOperation(options.signal)
  const initial = await readStore(captured, operation)
  const tokens = await exchangeCodeForTokens(
    { authorizationCode, codeVerifier: authorization.codeVerifier }, options, authorization.redirectUri)
  return await persistLogin(captured, tokens, initial.revision, operation)
}

async function persistLogin(
  captured: CapturedCodexStore, tokens: CodexTokens, revision: string | null, operation: CredentialOperationOptions,
): Promise<CodexLoginResult> {
  const file = authFileFor(tokens)
  await commitStore(captured, file, revision, operation)
  const claims = readJwtClaims(tokens.id_token)
  return {
    location: storeLabel(captured),
    email: claims?.email,
    accountId: file.tokens?.account_id ?? undefined,
    planType: claims?.planType,
  }
}

/**
 * Exchange a refresh token for a fresh token set and persist it.
 *
 * Refresh tokens are SINGLE USE and rotate on every call, which is why this
 * writes the result immediately: losing the new token means the next refresh
 * replays a spent one and permanently fails. It is also why this SDK must not
 * share a credential file with the Codex CLI.
 * @param store - the credential store to update in place.
 * @param options - issuer, client id, cancellation.
 * @returns the refreshed tokens.
 */
export function refreshCodexTokens(
  store: CodexCredentialStore,
  options?: CodexOAuthOptions,
): Promise<CodexTokens>
export function refreshCodexTokens(
  store: CodexAuthStore,
  options?: CodexOAuthOptions,
): Promise<CodexTokens>
export async function refreshCodexTokens(
  store: AnyCodexStore,
  options: CodexOAuthOptions = {},
): Promise<CodexTokens> {
  return await refreshCodexTokensWithOperation(store, options, credentialOperation(options.signal))
}
