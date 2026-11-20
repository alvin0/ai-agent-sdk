import { withCredentialRefresh, credentialLoginId } from '@alvin0/ai-agent-sdk-provider-http'
import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import {
  resolveAccountId, shouldRefresh,
  type CodexAuthFile,
  type CodexTokens,
} from './auth.ts'
import { captureCodexStore, type CapturedCodexStore } from './common/store-capture.ts'
import type { AnyCodexStore, CodexOAuthOptions, CodexStoreSnapshot } from './oauth-types.ts'
import { issuerOf, clientIdOf, oauthFetch, raceAbort, readResponseText, readJson } from './oauth-http.ts'
import { readStore, commitStore, storeLabel, isRevisionConflict } from './oauth-store.ts'
import { CodexRefreshError, PERMANENT_REFRESH_CODES, refreshErrorCode, requireRefreshTokens } from './oauth-errors.ts'

/** Internal runtime path that preserves the caller's bound credential logger. */
export async function refreshCodexTokensWithOperation(
  store: AnyCodexStore,
  options: CodexOAuthOptions,
  operation: CredentialOperationOptions, initial?: CodexStoreSnapshot,
): Promise<CodexTokens> {
  const captured = captureCodexStore(store)
  const snapshot = initial ?? await readStore(captured, operation)
  const current = currentRefreshTokens(snapshot.file, captured)
  const loginId = await credentialLoginId(snapshot.file?.loginId, current.refresh_token)
  return withCredentialRefresh(`codex:${loginId}`, operation.signal, () =>
    rotateTokens(captured, { ...snapshot, current, loginId }, options, operation))
}

async function rotateTokens(captured: CapturedCodexStore,
  snapshot: CodexStoreSnapshot & { current: CodexTokens; loginId: string },
  options: CodexOAuthOptions, operation: CredentialOperationOptions): Promise<CodexTokens> {
  const { current, loginId } = snapshot
  operation.signal.throwIfAborted()
  const latest = await readStore(captured, operation)
  if (latest.revision !== snapshot.revision || latest.file?.tokens?.refresh_token !== current.refresh_token) {
    return winnerTokens(latest, loginId, captured)
  }
  const response = await requestRefresh(current.refresh_token, options)
  try { await assertRefreshResponse(response, options) }
  catch (error) {
    operation.signal.throwIfAborted()
    if (!(error instanceof CodexRefreshError) || error.kind !== 'permanent') throw error
    const winner = await readStore(captured, operation)
    if (winner.revision === snapshot.revision) throw error
    return winnerTokens(winner, loginId, captured)
  }

  return commitRefresh(captured, snapshot, operation, { response, options, loginId, current })
}

async function commitRefresh(captured: CapturedCodexStore, snapshot: CodexStoreSnapshot,
  operation: CredentialOperationOptions,
  grant: { response: Response; options: CodexOAuthOptions; loginId: string; current: CodexTokens }) {
  const { response, options, loginId, current } = grant
  const parsed = await readJson(response, 'the token endpoint', options)
  validateRefreshPayload(parsed)
  const updated = refreshedTokens(parsed, current)
  const nextFile: CodexAuthFile = {
    ...snapshot.file, loginId,
    auth_mode: snapshot.file?.auth_mode ?? 'chatgpt',
    tokens: updated,
    last_refresh: new Date().toISOString(),
  }
  try {
    await raceAbort(commitStore(captured, nextFile, snapshot.revision, operation), operation.signal)
  } catch (error) {
    if (!isRevisionConflict(error)) throw error
    return winnerTokens(await readStore(captured, operation), loginId, captured)
  }
  return updated
}

async function requestRefresh(refreshToken: string, options: CodexOAuthOptions): Promise<Response> {
  const issuer = issuerOf(options)
  try {
    return await oauthFetch(options, `${issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientIdOf(options),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
  } catch {
    throw new CodexRefreshError('token refresh could not reach the auth service', 'transient')
  }
}

async function assertRefreshResponse(response: Response, options: CodexOAuthOptions) {
  if (!response.ok) {
    const raw = await readResponseText(response, options)
    const code = refreshErrorCode(raw)
    const permanent = response.status === 401
      || (code !== undefined && PERMANENT_REFRESH_CODES.has(code.toLowerCase()))
    throw new CodexRefreshError(
      permanent
        ? `Codex credentials are no longer valid (${code ?? `HTTP ${response.status}`});`
          + ' run `npm run provider:codex:login-device` to sign in again'
        : `token refresh failed (HTTP ${response.status})`,
      permanent ? 'permanent' : 'transient',
    )
  }
}

function validateRefreshPayload(parsed: Record<string, unknown>) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexRefreshError('token refresh returned an invalid payload', 'transient')
  }
  for (const field of ['id_token', 'access_token', 'refresh_token'] as const) {
    const value = parsed[field]
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      throw new CodexRefreshError('token refresh returned an invalid token field', 'transient')
    }
  }
}

function refreshedTokens(parsed: Record<string, unknown>, current: CodexTokens): CodexTokens {
  // Every field is optional on refresh; keep the current value when one is absent
  // rather than clobbering it with undefined.
  const next: CodexTokens = {
    id_token: typeof parsed.id_token === 'string' ? parsed.id_token : current.id_token,
    access_token: typeof parsed.access_token === 'string' ? parsed.access_token : current.access_token,
    refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : current.refresh_token,
  }
  const accountId = parsed.id_token === undefined ? resolveAccountId(current) : resolveAccountId(next)
  return { ...next, account_id: accountId ?? null }
}

function currentRefreshTokens(file: CodexAuthFile | undefined, captured: CapturedCodexStore): CodexTokens {
  const current = file?.tokens
  if (current === undefined || current === null || current.refresh_token.length === 0) {
    throw new CodexRefreshError(
      `no refresh token at ${storeLabel(captured)}; run \`npm run provider:codex:login-device\``,
      'permanent',
    )
  }

  return current
}

function winnerTokens(snapshot: CodexStoreSnapshot, loginId: string, captured: CapturedCodexStore): CodexTokens {
  const file = snapshot.file
  if (file?.loginId !== loginId || !file.tokens || shouldRefresh(file)) {
    throw new CodexRefreshError('Codex credentials changed during refresh', 'transient')
  }
  return requireRefreshTokens(file.tokens, storeLabel(captured))
}
