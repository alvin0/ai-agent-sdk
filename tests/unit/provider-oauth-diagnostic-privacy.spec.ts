import { expect, it } from 'vitest'
import {
  requestDeviceCode, pollForAuthorization, exchangeCodeForTokens,
} from '../../packages/provider-codex/src/oauth-device.ts'
import { authorizationCodeFrom } from '../../packages/provider-codex/src/oauth-browser.ts'
import { readJson } from '../../packages/provider-codex/src/oauth-http.ts'
import { readCatalogJson } from '../../packages/provider-codex/src/catalog.ts'
import { refreshCodexTokens } from '../../packages/provider-codex/src/oauth.ts'
import { memoryCodexAuthStore } from '../../packages/provider-codex/src/auth.ts'
import { refreshErrorCode } from '../../packages/provider-codex/src/oauth-errors.ts'
import { readApiToken } from '../../packages/provider-copilot/src/exchange-response.ts'
import { parseCatalogBody } from '../../packages/provider-copilot/src/catalog.ts'
import { requestCopilotDeviceCode } from '../../packages/provider-copilot/src/oauth.ts'

const marker = 'AUDIT84927'
const issuer = 'https://auth.example.test'
const failure = (status: number) => ({ issuer, fetch: async () => Response.json({ error: marker }, { status }) })
const authFile = { auth_mode: 'chatgpt', tokens: { id_token: 'e30.e30.signature',
  access_token: 'fixture-access', refresh_token: 'fixture-refresh' }, last_refresh: '2000-01-01T00:00:00.000Z' }
const pendingCode = { verificationUrl: `${issuer}/codex/device`, userCode: 'fixture-user-code',
  deviceAuthId: 'fixture-device-code', intervalSeconds: 1 }
const cases: { name: string; code: string | undefined; run: () => unknown }[] = [
  { name: 'device request', code: 'CODEX_AUTH_FAILED', run: () => requestDeviceCode(failure(400)) },
  { name: 'device poll', code: 'CODEX_AUTH_FAILED', run: () => pollForAuthorization(pendingCode, failure(500), {}) },
  { name: 'code exchange', code: 'CODEX_AUTH_FAILED', run: () => exchangeCodeForTokens({
    authorizationCode: 'fixture-code', codeVerifier: 'fixture-verifier',
  }, failure(400)) },
  { name: 'refresh rejection', code: 'CODEX_REAUTH_REQUIRED', run: () =>
    refreshCodexTokens(memoryCodexAuthStore(authFile), failure(401)) },
  { name: 'refresh transport', code: 'CODEX_REFRESH_TRANSIENT', run: () =>
    refreshCodexTokens(memoryCodexAuthStore(authFile), { issuer, fetch: async () => { throw new Error(marker) } }) },
  { name: 'callback', code: 'CODEX_AUTH_FAILED', run: () => authorizationCodeFrom({
    url: `${issuer}/oauth/authorize`, redirectUri: 'http://localhost:1455/auth/callback',
    state: 'fixture-state', codeVerifier: 'fixture-verifier',
  }, new URLSearchParams({ state: 'fixture-state', error: 'access_denied', error_description: marker })) },
  { name: 'Codex OAuth JSON', code: 'CODEX_AUTH_MALFORMED', run: () => readJson(new Response(marker), 'fixture', {}) },
  { name: 'Copilot token JSON', code: 'COPILOT_TOKEN_MALFORMED', run: () => readApiToken(marker, []) },
  { name: 'Copilot token expiry', code: 'COPILOT_TOKEN_MALFORMED', run: () =>
    readApiToken(JSON.stringify({ token: marker, expires_at: null }), []) },
  { name: 'Copilot device JSON', code: 'COPILOT_DEVICE_LOGIN_FAILED', run: () =>
    requestCopilotDeviceCode({ fetch: async () => new Response(marker, { status: 400 }) }) },
  { name: 'Copilot catalog JSON', code: 'COPILOT_CATALOG_MALFORMED', run: () => parseCatalogBody(marker) },
  { name: 'Codex catalog JSON', code: undefined, run: () => readCatalogJson(new Response(marker),
    { maxBytes: 1024, maxChunks: 10 }, new AbortController().signal) },
]

function diagnosticText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || typeof value !== 'object') return ''
  const error = value as { message?: unknown; cause?: unknown }
  return `${String(error.message ?? '')}\n${diagnosticText(error.cause, depth + 1)}`
}

it.each(cases)('keeps $name diagnostics classified without service response details', async ({ code, run }) => {
  const error: unknown = await Promise.resolve().then(run).catch(error => error as unknown)
  expect(error).toBeInstanceOf(Error)
  if (code !== undefined) expect(error).toMatchObject({ code })
  expect(diagnosticText(error)).not.toContain(marker)
})

it('recognizes stable OAuth refresh classifications', () => {
  expect(refreshErrorCode('{"error":"invalid_grant"}')).toBe('invalid_grant')
  expect(refreshErrorCode('{"error":{"code":"refresh_token_reused"}}')).toBe('refresh_token_reused')
  expect(refreshErrorCode('{"error":"AUDIT84927"}')).toBeUndefined()
})

it.each(['null', '[]', '42'])('classifies a non-object OAuth body %s as malformed', async body => {
  await expect(readJson(new Response(body), 'fixture', {})).rejects.toMatchObject({ code: 'CODEX_AUTH_MALFORMED' })
})
