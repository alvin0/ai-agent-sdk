import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import {
  resolveAccountId,
  type CodexAuthFile,
  type CodexTokens,
} from './auth.ts'
import { captureCodexStore, type CapturedCodexStore } from './common/store-capture.ts'
import type { AnyCodexStore, CodexOAuthOptions } from './oauth-types.ts'
import { issuerOf, clientIdOf, oauthFetch, readResponseText, readJson } from './oauth-http.ts'
import { readStore, commitStore, storeLabel, isRevisionConflict } from './oauth-store.ts'
import { CodexRefreshError, PERMANENT_REFRESH_CODES, refreshErrorCode, requireRefreshTokens } from './oauth-errors.ts'

/** Internal runtime path that preserves the caller's bound credential logger. */
export async function refreshCodexTokensWithOperation(
  store: AnyCodexStore,
  options: CodexOAuthOptions,
  operation: CredentialOperationOptions,
): Promise<CodexTokens> {
  const captured = captureCodexStore(store)
  const snapshot = await readStore(captured, operation)
  const file = snapshot.file
  operation.signal.throwIfAborted()
  const current = currentRefreshTokens(file, captured)

  const response = await requestRefresh(current.refresh_token, options)

  await assertRefreshResponse(response, options)

  const parsed = await readJson(response, 'the token endpoint', options)
  validateRefreshPayload(parsed)
  const updated = refreshedTokens(parsed, current)
  const nextFile: CodexAuthFile = {
    ...file,
    auth_mode: file?.auth_mode ?? 'chatgpt',
    tokens: updated,
    last_refresh: new Date().toISOString(),
  }
  try {
    await commitStore(captured, nextFile, snapshot.revision, operation)
  } catch (error) {
    return refreshWinner({ captured, revision: snapshot.revision, operation, error })
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
  } catch (error: unknown) {
    throw new CodexRefreshError('token refresh could not reach the auth service', 'transient', { cause: error })
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
      { cause: new Error(raw) },
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

async function refreshWinner(input: {
  captured: CapturedCodexStore; revision: string | null; operation: CredentialOperationOptions; error: unknown
}): Promise<CodexTokens> {
  const { captured, revision, operation, error } = input
  if (!isRevisionConflict(error) || captured.kind !== 'versioned') throw error
  const winner = await readStore(captured, operation)
  const winnerTokens = winner.file?.tokens
  if (winner.revision === revision || winnerTokens === undefined || winnerTokens === null) {
    throw error
  }
  return requireRefreshTokens(winnerTokens, storeLabel(captured))
}
