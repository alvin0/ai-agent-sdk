/**
 * The OAuth flows behind the Codex credential file: device-code sign-in and
 * refresh-token rotation.
 *
 * Device code rather than a browser redirect because this SDK has no business
 * binding a localhost port: the flow works over SSH, in containers, and in CI,
 * and it needs no callback server.
 *
 * One surprise worth flagging: in this flow the SERVER generates the PKCE pair
 * and returns both the verifier and the challenge alongside the authorization
 * code. That inverts normal PKCE, where the client generates the verifier and
 * never transmits it. It is what the endpoint does, so it is what this
 * implements — but it means the device-code leg is only as safe as the TLS
 * channel, and it is why the user-facing prompt carries a phishing warning.
 *
 * @module ai-agent-sdk/providers/codex/oauth
 */

import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import { waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import type { CredentialOperationOptions, SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import {
  readJwtClaims,
  requireTokens,
  shouldRefresh,
  resolveAccountId,
  type CodexAuthFile,
  type CodexAuthStore,
  type CodexCredentialStore,
  type CodexTokens,
} from './auth.ts'
import { captureCodexStore, type CapturedCodexStore } from './common/store-capture.ts'
import { rejectCodexRedirect } from './common/no-follow.ts'

const NEVER_ABORTED_SIGNAL = new AbortController().signal
const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

type AnyCodexStore = CodexAuthStore | CodexCredentialStore

interface CodexStoreSnapshot {
  readonly file: CodexAuthFile | undefined
  readonly revision: string | null
}

/** OpenAI's auth issuer. */
export const DEFAULT_CODEX_ISSUER = 'https://auth.openai.com'

/** The public OAuth client id the Codex CLI uses; not a secret. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** The device code expires server-side after this long. */
const DEVICE_CODE_MAX_WAIT_MS = 15 * 60 * 1_000

/** Used when the server does not state a polling interval. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

/** Shared settings for the OAuth calls. */
export interface CodexOAuthOptions {
  /** Auth issuer base URL; defaults to {@link DEFAULT_CODEX_ISSUER}. */
  issuer?: string
  /** OAuth client id; defaults to {@link CODEX_CLIENT_ID}. */
  clientId?: string
  /** Cancellation for the whole flow. */
  signal?: AbortSignal
  /** HTTP implementation for tests and non-browser runtimes. */
  fetch?: typeof fetch
  /** Deadline for each auth HTTP request. Defaults to 30 seconds. */
  requestTimeoutMs?: number
  /** Maximum auth response bytes retained or parsed. Defaults to 1 MiB. */
  maxResponseBytes?: number
  /** Maximum auth response chunks accepted. Defaults to 10,000. */
  maxResponseChunks?: number
  /** Permit an http:// issuer for a trusted local test endpoint. Defaults to false. */
  allowInsecureIssuer?: boolean
}

/** Settings for reading credentials from any store and optionally refreshing them. */
export interface GetCodexTokensOptions extends CodexOAuthOptions {
  /** Defaults to true. Set false to read the stored tokens without refreshing. */
  readonly refreshIfNeeded?: boolean
}

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

/** A pending device authorization the user has to approve. */
export interface CodexDeviceCode {
  /** URL to open in a browser. */
  verificationUrl: string
  /** One-time code the user types there. */
  userCode: string
  /** Opaque server-side handle for this authorization. */
  deviceAuthId: string
  /** Seconds to wait between polls. */
  intervalSeconds: number
}

/** Progress reported while a device-code login runs. */
export interface CodexLoginProgress {
  /** The code is ready; show it to the user. */
  onPrompt?: (code: CodexDeviceCode) => void
  /** Called before each poll, so a CLI can show that it is still waiting. */
  onPoll?: (elapsedMs: number) => void
}

function issuerOf(options: CodexOAuthOptions): string {
  const url = new URL(options.issuer ?? DEFAULT_CODEX_ISSUER)
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError('Codex OAuth issuer must not contain credentials')
  }
  if (url.protocol !== 'https:' && !(options.allowInsecureIssuer === true && url.protocol === 'http:')) {
    throw new TypeError('Codex OAuth issuer must use https')
  }
  return url.href.replace(/\/+$/, '')
}

function clientIdOf(options: CodexOAuthOptions): string {
  return options.clientId ?? CODEX_CLIENT_ID
}

async function oauthFetch(
  options: CodexOAuthOptions,
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  const issuer = new URL(issuerOf(options))
  const url = new URL(input)
  if (url.origin !== issuer.origin) throw new TypeError(`Codex OAuth endpoint origin '${url.origin}' is not allowed`)
  const timeoutMs = positiveSafeInteger(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs')
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('Codex OAuth requires fetch')
  const response = await raceAbort(Promise.resolve(fetchImpl(url, {
    ...init,
    signal,
    redirect: 'manual',
  })), signal)
  await rejectCodexRedirect(response, url.href, 'OAuth', 30_000)
  return response
}

async function readResponseText(response: Response, options: CodexOAuthOptions): Promise<string> {
  const maxBytes = positiveSafeInteger(options.maxResponseBytes ?? 1024 * 1024, 'maxResponseBytes')
  const maxChunks = positiveSafeInteger(options.maxResponseChunks ?? 10_000, 'maxResponseChunks')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body !== null) await waitForSettlement(response.body.cancel().catch(() => undefined), 30_000)
    throw new RangeError(`Codex OAuth response exceeds the ${maxBytes}-byte limit`)
  }
  if (response.body === null) return ''
  const timeout = AbortSignal.timeout(positiveSafeInteger(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs'))
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let chunks = 0
  let result = ''
  try {
    while (true) {
      const next = await raceAbort(reader.read(), signal)
      if (next.done) return result + decoder.decode()
      if (next.value === undefined) continue
      chunks++
      bytes += next.value.byteLength
      if (chunks > maxChunks || bytes > maxBytes) {
        await waitForSettlement(reader.cancel().catch(() => undefined), 30_000)
        throw new RangeError(`Codex OAuth response exceeds its configured resource limit`)
      }
      result += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    return Promise.reject(signal.reason ?? new Error('Codex OAuth operation aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Codex OAuth operation aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Codex OAuth ${field} must be a positive safe integer`)
  }
  return value
}

/** Read a JSON body, failing with the status when it is not JSON. */
async function readJson(
  response: Response,
  what: string,
  options: CodexOAuthOptions,
): Promise<Record<string, unknown>> {
  const raw = await readResponseText(response, options)
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error: unknown) {
    throw new AgentSdkError(
      `${what} returned a non-JSON response (HTTP ${response.status})`,
      'CODEX_AUTH_MALFORMED',
      { cause: error },
    )
  }
}

function requireString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new AgentSdkError(`${what} omitted "${key}"`, 'CODEX_AUTH_MALFORMED')
  }
  return value
}

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
  const parsed = typeof rawInterval === 'string'
    ? Number.parseInt(rawInterval.trim(), 10)
    : typeof rawInterval === 'number' ? rawInterval : Number.NaN
  return {
    verificationUrl: `${issuer}/codex/device`,
    userCode: requireString(body, 'user_code', 'the device-code endpoint'),
    deviceAuthId: requireString(body, 'device_auth_id', 'the device-code endpoint'),
    intervalSeconds: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_SECONDS,
  }
}

/** What the poll endpoint hands back once the user approves. */
interface AuthorizationGrant {
  authorizationCode: string
  codeVerifier: string
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
async function pollForAuthorization(
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
async function exchangeCodeForTokens(
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
function authFileFor(tokens: CodexTokens): CodexAuthFile {
  const accountId = resolveAccountId(tokens)
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { ...tokens, account_id: accountId ?? null },
    last_refresh: new Date().toISOString(),
  }
}

/** Result of a completed device-code login. */
export interface CodexLoginResult {
  /** Where the credentials were written. */
  location: string
  /** Signed-in account email, when the token discloses one. */
  email: string | undefined
  /** Workspace/account id that requests will carry. */
  accountId: string | undefined
  /** Plan type, when disclosed. */
  planType: string | undefined
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
  const file = authFileFor(tokens)
  await commitStore(captured, file, initial.revision, operation)

  const claims = readJwtClaims(tokens.id_token)
  return {
    location: storeLabel(captured),
    email: claims?.email,
    accountId: file.tokens?.account_id ?? undefined,
    planType: claims?.planType,
  }
}

/** Why a refresh failed, which decides whether re-login is required. */
export type RefreshFailureKind = 'permanent' | 'transient'

/** A refresh that did not succeed. */
export class CodexRefreshError extends AgentSdkError {
  readonly kind: RefreshFailureKind

  constructor(message: string, kind: RefreshFailureKind, options?: ErrorOptions) {
    super(message, kind === 'permanent' ? 'CODEX_REAUTH_REQUIRED' : 'CODEX_REFRESH_TRANSIENT', options)
    this.kind = kind
  }
}

/** Error codes that mean the refresh token is gone for good. */
const PERMANENT_REFRESH_CODES = new Set([
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
])

/** Pull an OAuth error code out of either body shape the endpoint uses. */
function refreshErrorCode(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string') return error
    if (typeof error === 'object' && error !== null) {
      const code = (error as Record<string, unknown>).code
      if (typeof code === 'string') return code
    }
    const code = parsed.code
    return typeof code === 'string' ? code : undefined
  } catch {
    return undefined
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
  const current = file?.tokens
  if (current === undefined || current === null || current.refresh_token.length === 0) {
    throw new CodexRefreshError(
      `no refresh token at ${storeLabel(captured)}; run \`npm run provider:codex:login-device\``,
      'permanent',
    )
  }

  const issuer = issuerOf(options)
  let response: Response
  try {
    response = await oauthFetch(options, `${issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientIdOf(options),
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
      }),
    })
  } catch (error: unknown) {
    throw new CodexRefreshError('token refresh could not reach the auth service', 'transient', { cause: error })
  }

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

  const parsed = await readJson(response, 'the token endpoint', options)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CodexRefreshError('token refresh returned an invalid payload', 'transient')
  }
  for (const field of ['id_token', 'access_token', 'refresh_token'] as const) {
    const value = parsed[field]
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      throw new CodexRefreshError('token refresh returned an invalid token field', 'transient')
    }
  }
  // Every field is optional on refresh; keep the current value when one is absent
  // rather than clobbering it with undefined.
  const next: CodexTokens = {
    id_token: typeof parsed.id_token === 'string' ? parsed.id_token : current.id_token,
    access_token: typeof parsed.access_token === 'string' ? parsed.access_token : current.access_token,
    refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : current.refresh_token,
  }
  const accountId = parsed.id_token === undefined ? resolveAccountId(current) : resolveAccountId(next)
  const updated: CodexTokens = { ...next, account_id: accountId ?? null }
  const nextFile: CodexAuthFile = {
    ...file,
    auth_mode: file?.auth_mode ?? 'chatgpt',
    tokens: updated,
    last_refresh: new Date().toISOString(),
  }
  try {
    await commitStore(captured, nextFile, snapshot.revision, operation)
  } catch (error) {
    if (!isRevisionConflict(error) || captured.kind !== 'versioned') throw error
    const winner = await readStore(captured, operation)
    const winnerTokens = winner.file?.tokens
    if (winner.revision === snapshot.revision || winnerTokens === undefined || winnerTokens === null) {
      throw error
    }
    return requireRefreshTokens(winnerTokens, storeLabel(captured))
  }
  return updated
}

function credentialOperation(signal: AbortSignal | undefined): CredentialOperationOptions {
  return { signal: signal ?? NEVER_ABORTED_SIGNAL, logger: NULL_LOGGER }
}

async function readStore(
  captured: CapturedCodexStore,
  operation: CredentialOperationOptions,
): Promise<CodexStoreSnapshot> {
  if (captured.kind === 'versioned') {
    operation.signal.throwIfAborted()
    const record = await raceAbort(captured.store.read(operation), operation.signal)
    return record === undefined
      ? { file: undefined, revision: null }
      : { file: record.value, revision: record.revision }
  }
  operation.signal.throwIfAborted()
  return { file: await raceAbort(captured.store.read(), operation.signal), revision: null }
}

async function commitStore(
  captured: CapturedCodexStore,
  file: CodexAuthFile,
  expectedRevision: string | null,
  operation: CredentialOperationOptions,
): Promise<void> {
  if (captured.kind === 'versioned') {
    await captured.store.commit({ value: file, expectedRevision }, operation)
    return
  }
  await captured.store.write(file)
}

function storeLabel(captured: CapturedCodexStore): string {
  return captured.label
}

function isRevisionConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined && 'value' in descriptor
    && descriptor.value === 'CODEX_CREDENTIAL_REVISION_CONFLICT'
}

function requireRefreshTokens(tokens: CodexTokens, location: string): CodexTokens {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0
    || typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length === 0) {
    throw new CodexRefreshError(`refreshed credentials at ${location} are incomplete`, 'permanent')
  }
  return tokens
}
