import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import {
  resolveAccountId,
  type CodexAuthFile,
  type CodexTokens,
} from './auth.ts'
import {
  DEVICE_CODE_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  type CodexOAuthOptions,
  type CodexDeviceCode,
  type CodexLoginProgress,
  type AuthorizationGrant,
} from './oauth-types.ts'
import { issuerOf, clientIdOf, oauthFetch, readResponseText, readJson, requireString } from './oauth-http.ts'

/**
 * Start a device authorization.
 * @param options - issuer, client id, cancellation.
 * @returns the code and URL to show the user.
 */
export async function requestDeviceCode(
  options: CodexOAuthOptions = {},
): Promise<CodexDeviceCode> {
  const issuer = issuerOf(options)
  const response = await oauthFetch(options, `${issuer}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientIdOf(options) }),
  })
  if (response.status === 404) {
    throw new AgentSdkError(
      `device-code login is not available at ${issuer}; check the issuer URL`,
      'CODEX_AUTH_UNAVAILABLE',
    )
  }
  if (!response.ok) {
    throw new AgentSdkError(
      `device-code request failed (HTTP ${response.status})`,
      'CODEX_AUTH_FAILED',
      { cause: new Error(await readResponseText(response, options)) },
    )
  }
  const body = await readJson(response, 'the device-code endpoint', options)
  // The server sends `interval` as a STRING; tolerate both forms.
  const rawInterval = body.interval
  const parsed = parseInterval(rawInterval)
  return {
    verificationUrl: `${issuer}/codex/device`,
    userCode: requireString(body, 'user_code', 'the device-code endpoint'),
    deviceAuthId: requireString(body, 'device_auth_id', 'the device-code endpoint'),
    intervalSeconds: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_SECONDS,
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new AgentSdkError('device-code login cancelled', 'ABORTED'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AgentSdkError('device-code login cancelled', 'ABORTED'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Poll until the user approves the code, or the authorization expires.
 *
 * `403` and `404` both mean "not approved yet" here, which is unusual — most
 * device flows use a `authorization_pending` error code — so anything else is
 * treated as a real failure rather than retried.
 * @param code - the pending authorization.
 * @param options - issuer, client id, cancellation.
 * @param progress - poll notifications.
 * @returns the authorization code and its server-issued PKCE verifier.
 */
export async function pollForAuthorization(
  code: CodexDeviceCode,
  options: CodexOAuthOptions,
  progress: CodexLoginProgress,
): Promise<AuthorizationGrant> {
  const issuer = issuerOf(options)
  const url = `${issuer}/api/accounts/deviceauth/token`
  const startedAt = Date.now()

  while (true) {
    const elapsed = Date.now() - startedAt
    try { progress.onPoll?.(elapsed) } catch { /* progress observers do not own authentication */ }
    const response = await oauthFetch(options, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
    })

    if (response.ok) {
      const body = await readJson(response, 'the device-token endpoint', options)
      return {
        authorizationCode: requireString(body, 'authorization_code', 'the device-token endpoint'),
        codeVerifier: requireString(body, 'code_verifier', 'the device-token endpoint'),
      }
    }

    if (response.status === 403 || response.status === 404) {
      const remaining = DEVICE_CODE_MAX_WAIT_MS - (Date.now() - startedAt)
      if (remaining <= 0) {
        throw new AgentSdkError(
          'device-code login timed out after 15 minutes without approval',
          'CODEX_AUTH_TIMEOUT',
        )
      }
      await sleep(Math.min(code.intervalSeconds * 1_000, remaining), options.signal)
      continue
    }

    throw new AgentSdkError(
      `device-code polling failed (HTTP ${response.status})`,
      'CODEX_AUTH_FAILED',
      { cause: new Error(await readResponseText(response, options)) },
    )
  }
}

/**
 * Exchange an approved authorization code for tokens.
 *
 * Form-encoded, not JSON — the token endpoint differs from the device-auth
 * endpoints in this respect, and sending JSON here fails.
 */
export async function exchangeCodeForTokens(
  grant: AuthorizationGrant,
  options: CodexOAuthOptions,
): Promise<CodexTokens> {
  const issuer = issuerOf(options)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: grant.authorizationCode,
    redirect_uri: `${issuer}/deviceauth/callback`,
    client_id: clientIdOf(options),
    code_verifier: grant.codeVerifier,
  })
  const response = await oauthFetch(options, `${issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!response.ok) {
    throw new AgentSdkError(
      `token exchange failed (HTTP ${response.status})`,
      'CODEX_AUTH_FAILED',
      { cause: new Error(await readResponseText(response, options)) },
    )
  }
  const parsed = await readJson(response, 'the token endpoint', options)
  return {
    id_token: requireString(parsed, 'id_token', 'the token endpoint'),
    access_token: requireString(parsed, 'access_token', 'the token endpoint'),
    refresh_token: requireString(parsed, 'refresh_token', 'the token endpoint'),
  }
}

/** Build the credential file for a freshly issued token set. */
export function authFileFor(tokens: CodexTokens): CodexAuthFile {
  const accountId = resolveAccountId(tokens)
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { ...tokens, account_id: accountId ?? null },
    last_refresh: new Date().toISOString(),
  }
}

function parseInterval(value: unknown): number {
  if (typeof value === 'string') return Number.parseInt(value.trim(), 10)
  if (typeof value === 'number') return value
  return Number.NaN
}
