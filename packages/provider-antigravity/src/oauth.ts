import { AgentSdkError } from '@alvin0/ai-agent-sdk-core/provider'
import {
  ANTIGRAVITY_AUTHORIZATION_URL, ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_SCOPES, ANTIGRAVITY_TOKEN_URL, ANTIGRAVITY_USER_AGENT,
} from './config.ts'
import { endpoint, NULL_LOGGER, object, requestJson, requiredString } from './http.ts'
import type {
  AntigravityAuthorization, AntigravityAuthFile, AntigravityCredentialStore,
  AntigravityLoginResult, AntigravityOAuthOptions,
} from './types.ts'

const consumed = new WeakSet<AntigravityAuthorization>()

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Create a random, opaque state. The PKCE verifier never travels in the URL. */
export async function createAntigravityAuthorization(
  options: AntigravityOAuthOptions & { readonly redirectUri: string },
): Promise<AntigravityAuthorization> {
  options.signal?.throwIfAborted()
  const redirect = new URL(options.redirectUri)
  if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
    || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new TypeError('Antigravity browser callbacks must use a loopback HTTP URL')
  }
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const clientId = clientIdOf(options)
  const url = endpoint(options.authorizationUrl ?? ANTIGRAVITY_AUTHORIZATION_URL, options.allowInsecureHttp)
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect.href, response_type: 'code',
    scope: ANTIGRAVITY_SCOPES.join(' '), state, code_challenge: challenge,
    code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
  }).toString()
  return Object.freeze({ url: url.href, state, verifier, redirectUri: redirect.href, clientId, createdAt: Date.now() })
}

function clientIdOf(options: AntigravityOAuthOptions): string {
  if (typeof options.clientId !== 'string' || !options.clientId.trim()) {
    throw new AgentSdkError('Antigravity OAuth clientId is required; configure it before signing in',
      'ANTIGRAVITY_CLIENT_REQUIRED')
  }
  return requiredString(options.clientId, 'OAuth client')
}

function oauthClient(options: AntigravityOAuthOptions): Record<string, string> {
  const clientId = clientIdOf(options)
  const clientSecret = options.clientSecret
  if (clientSecret !== undefined && (typeof clientSecret !== 'string' || !clientSecret.trim())) {
    throw new TypeError('Antigravity OAuth clientSecret must be a non-empty string when supplied')
  }
  return { client_id: clientId, ...(clientSecret === undefined ? {} : { client_secret: clientSecret }) }
}

export async function exchangeAntigravityToken(
  fields: Readonly<Record<string, string>>, options: AntigravityOAuthOptions,
): Promise<AntigravityAuthFile['tokens']> {
  const startedAt = Date.now()
  const body = await requestJson(options.tokenUrl ?? ANTIGRAVITY_TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...oauthClient(options), ...fields,
    }).toString(),
  }, options)
  const seconds = body.expires_in
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 31_536_000) {
    throw new AgentSdkError('Antigravity token expiry is invalid', 'MALFORMED_RESPONSE')
  }
  return {
    access_token: requiredString(body.access_token, 'access token'),
    refresh_token: requiredString(body.refresh_token ?? fields.refresh_token, 'refresh token'),
    expires_at: startedAt + seconds * 1_000,
  }
}

export function antigravityHeaders(accessToken: string, options: AntigravityOAuthOptions): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
    'user-agent': options.userAgent ?? ANTIGRAVITY_USER_AGENT }
}

function projectId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id
    if (typeof id === 'string' && id.trim()) return id
  }
  return undefined
}

/** Discover the account's actual project; never manufacture a project or switch quota hosts. */
export async function resolveAntigravityProject(
  accessToken: string, options: AntigravityOAuthOptions,
): Promise<string> {
  const baseUrl = endpoint(options.baseUrl ?? ANTIGRAVITY_BASE_URL, options.allowInsecureHttp).href.replace(/\/$/, '')
  const headers = antigravityHeaders(accessToken, options)
  const metadata = { ideType: 'ANTIGRAVITY' }
  const loaded = await requestJson(`${baseUrl}/v1internal:loadCodeAssist`, {
    method: 'POST', headers, body: JSON.stringify({ metadata,
      ...(options.projectId === undefined ? {} : { cloudaicompanionProject: options.projectId }) }),
  }, options)
  const loadedId = projectId(loaded.cloudaicompanionProject)
  if (loadedId !== undefined) return loadedId
  const tiers = Array.isArray(loaded.allowedTiers) ? loaded.allowedTiers : []
  const tier = tiers.map(object).find(entry => entry.isDefault === true)
  if (tier === undefined || typeof tier.id !== 'string') {
    throw new AgentSdkError(
      'This Google account has no Antigravity project; complete setup in Antigravity and sign in again',
      'ANTIGRAVITY_PROJECT_REQUIRED',
    )
  }
  return onboardProject(baseUrl, headers, { tierId: tier.id, metadata,
    ...(options.projectId === undefined ? {} : { cloudaicompanionProject: options.projectId }) }, options)
}

async function onboardProject(
  baseUrl: string, headers: Record<string, string>, input: Record<string, unknown>, options: AntigravityOAuthOptions,
): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    options.signal?.throwIfAborted()
    const onboarded = await requestJson(`${baseUrl}/v1internal:onboardUser`, {
      method: 'POST', headers, body: JSON.stringify(input),
    }, options)
    if (onboarded.done === true) {
      const id = projectId(object(onboarded.response).cloudaicompanionProject)
      if (id !== undefined) return id
      break
    }
    await delay(options.signal)
  }
  throw new AgentSdkError(
    'Antigravity project setup did not complete; finish setup in Antigravity and retry',
    'ANTIGRAVITY_PROJECT_REQUIRED',
  )
}

async function delay(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 1_000)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function validateCallback(authorization: AntigravityAuthorization, params: URLSearchParams): void {
  if (params.getAll('state').length !== 1 || params.get('state') !== authorization.state
    || Date.now() - authorization.createdAt > 15 * 60_000 || consumed.has(authorization)) {
    throw new AgentSdkError('Antigravity callback state is invalid, expired, or already used',
      'ANTIGRAVITY_AUTH_STATE_INVALID')
  }
  consumed.add(authorization)
  if (params.has('error')) throw new AgentSdkError('Google sign-in was declined or failed', 'ANTIGRAVITY_AUTH_DENIED')
  if (params.getAll('code').length !== 1) {
    throw new AgentSdkError('Google sign-in returned no unique code', 'ANTIGRAVITY_AUTH_FAILED')
  }
}

/** Validate one callback and commit credentials only after token exchange and project discovery succeed. */
export async function completeAntigravityLogin(
  store: AntigravityCredentialStore, authorization: AntigravityAuthorization,
  params: URLSearchParams, options: AntigravityOAuthOptions = {},
): Promise<AntigravityLoginResult> {
  options.signal?.throwIfAborted()
  validateCallback(authorization, params)
  const code = requiredString(params.get('code'), 'authorization code')
  const operation = { signal: options.signal ?? new AbortController().signal, logger: NULL_LOGGER }
  const previous = await store.read(operation)
  const tokens = await exchangeAntigravityToken({ code, grant_type: 'authorization_code',
    redirect_uri: authorization.redirectUri, code_verifier: authorization.verifier }, {
    ...options, clientId: authorization.clientId,
  })
  const resolvedProjectId = await resolveAntigravityProject(tokens.access_token, options)
  const identity = await requestJson(options.userInfoUrl ?? 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  }, options)
  const account = typeof identity.email === 'string' ? { email: identity.email } : undefined
  const file: AntigravityAuthFile = { version: 1, tokens, projectId: resolvedProjectId,
    clientId: authorization.clientId, obtainedAt: new Date().toISOString(),
    ...(account === undefined ? {} : { account }) }
  await store.commit({ value: file, expectedRevision: previous?.revision ?? null }, operation)
  return { projectId: resolvedProjectId, ...(account === undefined ? {} : { account }) }
}
