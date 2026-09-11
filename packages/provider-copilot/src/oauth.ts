/**
 * The OAuth device flow behind the Copilot credential file.
 *
 * Device code rather than a browser redirect for the same reason the Codex
 * provider chose it: this SDK has no business binding a localhost port, and the
 * flow has to work over SSH, in containers, and in CI with no callback server.
 *
 * ## Client identity
 *
 * `COPILOT_OAUTH_CLIENT_ID` is one of three `Client_Identity_Constants` in this
 * package — the other two are `COPILOT_EDITOR_VERSION` and
 * `COPILOT_EDITOR_PLUGIN_VERSION` in `./adapter.ts`. All three default to values
 * that make this SDK identify itself AS AN EDITOR CLIENT when it signs in and
 * when it calls the Copilot surface. That is not a side effect; it is what makes
 * the surface answer at all, because `copilot_internal/v2/token` only accepts a
 * token minted by an OAuth App on GitHub's allowlist and a personal access token
 * cannot stand in for one.
 *
 * Because presenting as another client is a decision the caller should be able
 * to see and change, all three are EXPORTED, OVERRIDABLE constants rather than
 * hidden values buried in a request builder — the same reason
 * `CODEX_CLIENT_VERSION` is an exported constant in `provider-codex`. Each also
 * has a matching named option (`clientId` here, `editorHeaders` on the adapter),
 * so overriding one needs no fork. See the README and the "Client identity"
 * section of the docs for the full tradeoff, and prefer a provider's official
 * first-party surface for production.
 *
 * ## The two legs, and what is load-bearing about each
 *
 * ```text
 * POST {issuer}/login/device/code        → { device_code, user_code,
 *   Accept: application/json               verification_uri, expires_in, interval }
 *
 * POST {issuer}/login/oauth/access_token → { access_token, token_type, scope }
 *   Accept: application/json               or HTTP 200 { error, interval? }
 * ```
 *
 * `Accept: application/json` is mandatory on BOTH legs, and the error channel on
 * the second leg is an HTTP 200 carrying `error` — see
 * {@link pollForCopilotToken} for why each of those changes the shape of the
 * code rather than just its headers.
 *
 * @module ai-agent-sdk/providers/copilot/oauth
 */

import type { CredentialOperationOptions, SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import {
  copilotFetch,
  copilotUrl,
  issuerOf,
  readCopilotResponseText,
  type CopilotHttpOptions,
  type CopilotRequest,
} from './common/http.ts'
import { captureCopilotStore, type CapturedCopilotStore } from './common/store-capture.ts'
import type {
  CopilotAccountIdentity,
  CopilotAuthFile,
  CopilotAuthStore,
  CopilotCredentialStore,
} from './common/store-types.ts'
import {
  CopilotDeviceLoginError,
  credentialFailure,
  type CopilotDeviceLoginReason,
} from './errors.ts'

/** GitHub's OAuth issuer. */
export const DEFAULT_COPILOT_OAUTH_ISSUER = 'https://github.com'

/**
 * Default OAuth client id. Public, not a secret.
 *
 * This is the client id published in GitHub's own editor-plugin sources (the
 * value `copilot.vim` and the other Copilot editor integrations ship in the
 * clear), which is why it is on the allowlist that
 * `copilot_internal/v2/token` checks. Sending it means this SDK signs in AS that
 * editor client. See the module note for why that makes it a named option
 * instead of a hidden constant.
 *
 * ⚠ UNVERIFIED against a live account. Recorded 2026-09-10 from public editor
 * integration sources only; no sign-in against a real Copilot account has
 * confirmed THIS client id.
 *
 * The 2026-09-10 live run that confirmed the two editor headers did NOT confirm
 * this value, and could not: it was handed an existing `ghu_` user-to-server token
 * out of band, so it exercised the EXCHANGE (which answered 200 for that token)
 * while never running the device flow that would put this `client_id` on the wire.
 * What that run does establish is the shape of the claim still outstanding — the
 * exchange endpoint and the allowlist check are live and reachable, and the only
 * untested link is whether they accept a token minted by this particular app.
 *
 * TODO(copilot-identity): confirm on a real Copilot account, then replace this
 * warning with the confirmation date. To confirm: run the device flow against
 * `https://github.com/login/device/code` with this `client_id` and
 * `scope=read:user`, approve it on a Copilot-enabled account, then exchange the
 * resulting user token at `GET https://api.github.com/copilot_internal/v2/token`.
 * The client id is confirmed when that exchange returns a Copilot token rather
 * than 401/403. A non-allowlisted client id fails at the exchange, not at
 * sign-in, so the device flow succeeding on its own proves nothing — and equally,
 * an exchange that succeeds for a token this flow did not mint proves nothing
 * about this constant.
 */
export const COPILOT_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98'

/** Requested scope; enough to exchange a token and read identity, no more. */
export const COPILOT_OAUTH_SCOPE = 'read:user'
/**
 * The absolute ceiling on one device login, INDEPENDENT of the server's
 * `expires_in`.
 *
 * `expires_in` is honoured when it is shorter — there is no point polling a code
 * the server has already retired. It is not honoured when it is longer: a server
 * that answers `expires_in: 86400` would otherwise hang a CLI for a day, and this
 * SDK is not the right place to hold that terminal hostage (Requirement 4.3).
 */
export const COPILOT_DEVICE_CODE_MAX_WAIT_MS = 15 * 60 * 1_000

/** Poll interval used when the device-code response states none. */
export const COPILOT_DEFAULT_POLL_INTERVAL_SECONDS = 5

/**
 * Seconds added on every `slow_down`, per RFC 8628 §3.5.
 *
 * The increment is what makes the wait STRICTLY increase even when the server
 * repeats `slow_down` without a new `interval`. Without it, a server that only
 * ever says "slow down" would be polled at exactly the rate it just objected to.
 */
export const COPILOT_SLOW_DOWN_INCREMENT_SECONDS = 5

/**
 * The warning shown beside the user code, worded exactly as the Codex device
 * prompt words it.
 *
 * A device code is a bearer of authorization that the user types into a page they
 * navigated to themselves. The one attack that works is getting somebody to type
 * an attacker's code, so the prompt has to say so; and it lives here rather than
 * in the CLI so every front end that renders a Copilot prompt renders the same
 * sentence.
 */
export const COPILOT_DEVICE_LOGIN_WARNING
  = 'Only continue if YOU started this login. If someone sent you this code, stop.'

/** GitHub's device-authorization leg. */
const DEVICE_CODE_PATH = '/login/device/code'

/** GitHub's device-token leg. */
const DEVICE_TOKEN_PATH = '/login/oauth/access_token'

/** The device-code grant type, spelled as RFC 8628 requires. */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** The command that produces a credential, named when a login ends without one. */
const COPILOT_LOGIN_COMMAND = 'npm run provider:copilot:login-device'

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

/**
 * The scheduler the poll loop waits on, injectable so no test waits real time.
 *
 * `now` travels with the timer rather than sitting in a second option, because
 * the two are read together on every iteration: a fake timer that advances
 * pending callbacks while `Date.now()` stands still would let a test satisfy the
 * 15-minute bound by accident, in either direction. Handing both through one
 * object makes "virtual clock" a single substitution (Properties 11, 12, 14).
 */
export interface CopilotTimer {
  /** Schedule `handler` after `ms`; returns whatever handle `clear` accepts. */
  readonly setTimeout: (handler: () => void, ms: number) => unknown
  /** Cancel a handle from {@link CopilotTimer.setTimeout}. */
  readonly clearTimeout: (handle: unknown) => void
  /** Current time in epoch milliseconds. */
  readonly now: () => number
}

/** The real scheduler: `setTimeout`, `clearTimeout` and `Date.now`. */
export const DEFAULT_COPILOT_TIMER: CopilotTimer = Object.freeze({
  setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
})

/**
 * Settings for both device-flow legs.
 *
 * Extends {@link CopilotHttpOptions}, so the issuer pin, the deadline and the two
 * read bounds are the same ones every other Copilot call site uses
 * (Requirement 4.7). `oauthIssuer` is named rather than called `issuer` because
 * this package pins THREE origins independently and the field name is what says
 * which one is being set.
 */
export interface CopilotOAuthOptions extends CopilotHttpOptions {
  /** OAuth issuer base URL; defaults to {@link DEFAULT_COPILOT_OAUTH_ISSUER}. */
  readonly oauthIssuer?: string
  /** OAuth client id; defaults to {@link COPILOT_OAUTH_CLIENT_ID}. */
  readonly clientId?: string
  /** Requested scope; defaults to {@link COPILOT_OAUTH_SCOPE}. */
  readonly scope?: string
  /** Scheduler for the poll wait; defaults to {@link DEFAULT_COPILOT_TIMER}. */
  readonly timer?: CopilotTimer
}

/** A pending device authorization the user has to approve. */
export interface CopilotDeviceCode {
  /** URL to open in a browser. Displayed to the user; never fetched by this SDK. */
  readonly verificationUrl: string
  /** One-time code the user types there. */
  readonly userCode: string
  /** Opaque handle this SDK polls with. Never shown to the user. */
  readonly deviceCode: string
  /** Seconds to wait between polls, as the server asked. */
  readonly intervalSeconds: number
  /** Seconds until the server retires the code. */
  readonly expiresInSeconds: number
}

/** Progress reported while a device login runs. */
export interface CopilotLoginProgress {
  /** The code is ready; show it, with {@link COPILOT_DEVICE_LOGIN_WARNING}. */
  readonly onPrompt?: (code: CopilotDeviceCode) => void
  /** Called before each poll, with the interval currently in effect. */
  readonly onPoll?: (elapsedMs: number, intervalSeconds: number) => void
}

/** Result of a completed device login. */
export interface CopilotLoginResult {
  /** Where the credential was written. Always present. */
  readonly location: string
  /** GitHub login, when the endpoint discloses one. */
  readonly login: string | undefined
  /** Numeric account id, when the endpoint discloses one. */
  readonly accountId: number | undefined
  /** Granted scope, when the endpoint discloses it. */
  readonly scope: string | undefined
}

type AnyCopilotStore = CopilotAuthStore | CopilotCredentialStore

interface CopilotStoreSnapshot {
  readonly file: CopilotAuthFile | undefined
  readonly revision: string | null
}

/** What the token leg hands back once the user approves. */
interface CopilotAccessToken {
  readonly accessToken: string
  readonly tokenType: string | undefined
  readonly scope: string | undefined
  readonly account: CopilotAccountIdentity | undefined
}

/**
 * Start a device authorization.
 *
 * `Accept: application/json` is set here as well as on the token leg. It is
 * load-bearing on the token leg (see {@link pollForCopilotToken}) and harmless
 * here, and setting it on both keeps the pair from drifting into "one of the two
 * legs parses JSON".
 * @param options - issuer, client id, scope, cancellation and read bounds.
 * @returns the code, the URL and the timings to show the user.
 * @throws CopilotDeviceLoginError with `reason: 'aborted'` when the caller's
 *   signal aborts, or `reason: 'failed'` when the endpoint answers with anything
 *   other than a usable device authorization.
 */
export async function requestCopilotDeviceCode(
  options: CopilotOAuthOptions = {},
): Promise<CopilotDeviceCode> {
  const pinned = issuerOf('oauthIssuer', options.oauthIssuer, DEFAULT_COPILOT_OAUTH_ISSUER, options)
  const body = await deviceJson(
    {
      pinned,
      url: copilotUrl(pinned, DEVICE_CODE_PATH),
      operation: 'device code',
      init: {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: options.clientId ?? COPILOT_OAUTH_CLIENT_ID,
          scope: options.scope ?? COPILOT_OAUTH_SCOPE,
        }),
      },
    },
    'the device-code endpoint',
    options,
  )
  if (!body.ok) {
    throw deviceFailure(
      `the device-code endpoint failed (HTTP ${body.status})`,
      'failed',
      body.parseError,
    )
  }
  return Object.freeze({
    verificationUrl: verificationUrlOf(body.json, options),
    userCode: requireDeviceString(body.json, 'user_code'),
    deviceCode: requireDeviceString(body.json, 'device_code'),
    intervalSeconds: positiveSecondsOf(body.json.interval, COPILOT_DEFAULT_POLL_INTERVAL_SECONDS),
    expiresInSeconds: positiveSecondsOf(
      body.json.expires_in,
      COPILOT_DEVICE_CODE_MAX_WAIT_MS / 1_000,
    ),
  })
}

/**
 * Run a full device login and persist the resulting `GitHub_User_Token`.
 *
 * The store is read BEFORE the flow starts, so the commit carries the revision
 * that was current when the login began and a concurrent login loses the race
 * loudly instead of silently overwriting. Nothing else is written: the
 * `GitHub_User_Token` does not rotate, so this is the only write in the whole
 * Copilot credential path.
 * @param store - the credential store to write, in either variant.
 * @param options - issuer, client id, scope, cancellation, bounds and timer.
 * @param progress - prompt and poll notifications for a CLI to render.
 * @returns the store location plus whatever identity the endpoint disclosed.
 * @throws CopilotDeviceLoginError with `reason` distinguishing `denied`,
 *   `expired`, `timeout`, `aborted` and `failed`.
 */
export function runCopilotDeviceLogin(
  store: CopilotCredentialStore,
  options?: CopilotOAuthOptions,
  progress?: CopilotLoginProgress,
): Promise<CopilotLoginResult>
export function runCopilotDeviceLogin(
  store: CopilotAuthStore,
  options?: CopilotOAuthOptions,
  progress?: CopilotLoginProgress,
): Promise<CopilotLoginResult>
export async function runCopilotDeviceLogin(
  store: AnyCopilotStore,
  options: CopilotOAuthOptions = {},
  progress: CopilotLoginProgress = {},
): Promise<CopilotLoginResult> {
  const captured = captureCopilotStore(store)
  const operation: CredentialOperationOptions = {
    signal: options.signal ?? NEVER_ABORTED_SIGNAL,
    logger: NULL_LOGGER,
  }
  const initial = await readStore(captured, operation)
  const code = await requestCopilotDeviceCode(options)
  notify(() => progress.onPrompt?.(code))
  const token = await pollForCopilotToken(code, options, progress)
  const file: CopilotAuthFile = {
    version: 1,
    github: {
      token: token.accessToken,
      ...token.tokenType === undefined ? {} : { tokenType: token.tokenType },
      ...token.scope === undefined ? {} : { scope: token.scope },
    },
    ...token.account === undefined ? {} : { account: token.account },
    clientId: options.clientId ?? COPILOT_OAUTH_CLIENT_ID,
    obtainedAt: new Date(timerOf(options).now()).toISOString(),
  }
  await commitStore(captured, file, initial.revision, operation)
  return Object.freeze({
    location: captured.label,
    login: token.account?.login,
    accountId: token.account?.id,
    scope: token.scope,
  })
}

/**
 * Poll the token leg until the user approves, the server refuses, or a bound
 * passes.
 *
 * Two things make this loop different from the Codex one, and both are easy to
 * get wrong:
 *
 * - **`Accept: application/json` is mandatory.** Without it GitHub's token
 *   endpoint answers FORM-ENCODED, so a JSON parser meets
 *   `error=authorization_pending&interval=10` and throws — which turns the "not
 *   approved yet" branch into a hard-failure branch, and the flow can then never
 *   succeed at all.
 * - **The error channel is HTTP 200 with `error` in the body.** Codex surfaces
 *   "pending" as 403/404; GitHub surfaces it as a 200. So classification reads the
 *   BODY FIRST and the status second. A status-first reader treats every pending
 *   poll as a success and then fails looking for `access_token`.
 * @param code - the pending authorization.
 * @param options - issuer, client id, bounds and the injectable timer.
 * @param progress - poll notifications.
 * @returns the access token and whatever the endpoint disclosed beside it.
 */
async function pollForCopilotToken(
  code: CopilotDeviceCode,
  options: CopilotOAuthOptions,
  progress: CopilotLoginProgress,
): Promise<CopilotAccessToken> {
  const pinned = issuerOf('oauthIssuer', options.oauthIssuer, DEFAULT_COPILOT_OAUTH_ISSUER, options)
  const url = copilotUrl(pinned, DEVICE_TOKEN_PATH)
  const timer = timerOf(options)
  const startedAt = timer.now()
  // The 15-minute ceiling is absolute; `expires_in` only ever pulls the deadline
  // in. min() is the whole of that rule.
  const deadlineAt = startedAt + Math.min(
    COPILOT_DEVICE_CODE_MAX_WAIT_MS,
    code.expiresInSeconds * 1_000,
  )
  let intervalSeconds = code.intervalSeconds

  while (true) {
    throwIfAborted(options.signal)
    if (timer.now() >= deadlineAt) throw deviceTimeout(startedAt, timer.now())
    notify(() => progress.onPoll?.(timer.now() - startedAt, intervalSeconds))

    const body = await deviceJson(
      {
        pinned,
        url,
        operation: 'device token',
        init: {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: options.clientId ?? COPILOT_OAUTH_CLIENT_ID,
            device_code: code.deviceCode,
            grant_type: DEVICE_GRANT_TYPE,
          }),
        },
      },
      'the device-token endpoint',
      options,
    )

    // Body first, status second.
    const error = typeof body.json.error === 'string' ? body.json.error : undefined
    if (error === 'authorization_pending' || error === 'slow_down') {
      intervalSeconds = nextIntervalSeconds(intervalSeconds, body.json.interval, error)
      const remaining = deadlineAt - timer.now()
      if (remaining <= 0) throw deviceTimeout(startedAt, timer.now())
      await sleep(Math.min(intervalSeconds * 1_000, remaining), options.signal, timer)
      continue
    }
    if (error === 'access_denied') {
      throw deviceFailure(
        'the device login was denied on GitHub;'
        + ` run \`${COPILOT_LOGIN_COMMAND}\` again if you did mean to approve it`,
        'denied',
      )
    }
    if (error === 'expired_token') {
      throw deviceFailure(
        `the device code expired before it was approved; run \`${COPILOT_LOGIN_COMMAND}\``
        + ' again to request a new code',
        'expired',
      )
    }
    if (error !== undefined) {
      throw deviceFailure(
        `the device-token endpoint refused the request (${error}, HTTP ${body.status})`,
        'failed',
      )
    }
    if (!body.ok) {
      throw deviceFailure(
        `the device-token endpoint failed (HTTP ${body.status})`,
        'failed',
        body.parseError,
      )
    }
    return Object.freeze({
      accessToken: requireDeviceString(body.json, 'access_token'),
      tokenType: optionalString(body.json.token_type),
      scope: optionalString(body.json.scope),
      account: accountIdentityOf(body.json),
    })
  }
}

/**
 * The effective wait after a `slow_down`, which must STRICTLY increase.
 *
 * `max(current, server-requested, current + 5)` — the third term is what keeps
 * the sequence increasing when the server sends no new `interval`, and taking the
 * max of all three keeps it from ever decreasing when the server sends a smaller
 * one. `authorization_pending` may carry a new interval too; there it is honoured
 * without the increment, so an ordinary pending poll does not back off forever.
 */
function nextIntervalSeconds(
  current: number,
  requested: unknown,
  error: 'authorization_pending' | 'slow_down',
): number {
  const server = positiveSecondsOf(requested, 0)
  return error === 'slow_down'
    ? Math.max(current, server, current + COPILOT_SLOW_DOWN_INCREMENT_SECONDS)
    : Math.max(current, server)
}

/**
 * Wait `ms`, losing the race to `signal` the instant it aborts.
 *
 * The timer is injected rather than closed over, so a test can drive the poll
 * loop through fifteen virtual minutes in a millisecond. Aborting rejects instead
 * of resolving early, because a caller who pressed Ctrl-C wants the flow to END,
 * not to take one more turn round the loop.
 */
function sleep(ms: number, signal: AbortSignal | undefined, timer: CopilotTimer): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(deviceAborted())
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      timer.clearTimeout(handle)
      reject(deviceAborted())
    }
    const handle = timer.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** One bounded read of an OAuth response, plus the status it came with. */
interface DeviceJson {
  readonly ok: boolean
  readonly status: number
  readonly json: Record<string, unknown>
  /** Why the body was not usable JSON, when it was not. */
  readonly parseError: unknown
}

/**
 * Dispatch one OAuth leg and read its body within the configured bounds.
 *
 * A body that is not a JSON object yields an EMPTY object plus `parseError`
 * rather than throwing: the status still has to be classified, and on the token
 * leg an unreadable body is one of the shapes a misconfigured `Accept` header
 * produces. Callers therefore always get to the body-first branch, and reach a
 * hard failure only after it finds no `error`.
 */
async function deviceJson(
  request: CopilotRequest,
  what: string,
  options: CopilotOAuthOptions,
): Promise<DeviceJson> {
  let response: Response
  try {
    response = await copilotFetch(request, options)
  } catch (error: unknown) {
    throwIfAborted(options.signal)
    throw error instanceof CopilotDeviceLoginError
      ? error
      : deviceFailure(`${what} could not be reached`, 'failed', error)
  }
  let raw: string
  try {
    raw = await readCopilotResponseText(response, options)
  } catch (error: unknown) {
    throwIfAborted(options.signal)
    throw deviceFailure(`${what} returned a response beyond the configured limits`, 'failed', error)
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError(`${what} returned JSON that is not an object`)
    }
    return {
      ok: response.ok,
      status: response.status,
      json: parsed as Record<string, unknown>,
      parseError: undefined,
    }
  } catch (error: unknown) {
    return { ok: response.ok, status: response.status, json: {}, parseError: error }
  }
}

/**
 * Read the verification URL the user is told to open.
 *
 * Only the SCHEME is constrained, not the origin. This SDK never fetches this
 * URL — it prints it — and GitHub Enterprise deployments legitimately answer with
 * a host other than the issuer, so an origin pin here would reject working
 * installations to guard a request that is never made. The scheme check remains
 * because a `javascript:` or `data:` URL handed to a browser opener is a real
 * problem, and {@link COPILOT_DEVICE_LOGIN_WARNING} covers the rest.
 */
function verificationUrlOf(
  body: Record<string, unknown>,
  options: CopilotOAuthOptions,
): string {
  const raw = requireDeviceString(body, 'verification_uri')
  let url: URL
  try {
    url = new URL(raw)
  } catch (error: unknown) {
    throw deviceFailure('the device-code endpoint returned an unusable verification URL', 'failed', error)
  }
  if (url.protocol !== 'https:'
    && !(options.allowInsecureIssuer === true && url.protocol === 'http:')) {
    throw deviceFailure('the device-code verification URL must use https', 'failed')
  }
  return url.href
}

/** Identity fields, present only when the endpoint disclosed them (Property 16). */
function accountIdentityOf(body: Record<string, unknown>): CopilotAccountIdentity | undefined {
  const login = optionalString(body.login)
  const name = optionalString(body.name)
  const id = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : undefined
  if (login === undefined && name === undefined && id === undefined) return undefined
  return Object.freeze({
    ...login === undefined ? {} : { login },
    ...name === undefined ? {} : { name },
    ...id === undefined ? {} : { id },
  })
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requireDeviceString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw deviceFailure(`the device flow response omitted "${key}"`, 'failed')
  }
  return value
}

/**
 * Read a seconds value that the endpoint may send as a number, as a numeric
 * string, or not at all.
 *
 * GitHub has been observed sending `interval` as a string, so both forms are
 * accepted; anything unparsable falls back rather than failing the login, because
 * a bad hint about pacing is not a reason to refuse a working authorization.
 */
function positiveSecondsOf(value: unknown, fallbackSeconds: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' ? Number.parseInt(value.trim(), 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds
}

function timerOf(options: CopilotOAuthOptions): CopilotTimer {
  return options.timer ?? DEFAULT_COPILOT_TIMER
}

/** Run a progress observer; observers do not own authentication. */
function notify(report: () => void): void {
  try {
    report()
  } catch { /* a CLI's rendering must not decide whether a login succeeds */ }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw deviceAborted()
}

function deviceAborted(): CopilotDeviceLoginError {
  return deviceFailure('the device login was cancelled', 'aborted')
}

function deviceTimeout(startedAt: number, now: number): CopilotDeviceLoginError {
  return deviceFailure(
    `the device login was not approved within ${Math.round((now - startedAt) / 1_000)}s`
    + ` (bound: ${COPILOT_DEVICE_CODE_MAX_WAIT_MS / 60_000} minutes);`
    + ` run \`${COPILOT_LOGIN_COMMAND}\` again`,
    'timeout',
  )
}

function deviceFailure(
  message: string,
  reason: CopilotDeviceLoginReason,
  cause?: unknown,
): CopilotDeviceLoginError {
  return new CopilotDeviceLoginError(credentialFailure(message, cause), reason)
}

async function readStore(
  captured: CapturedCopilotStore,
  operation: CredentialOperationOptions,
): Promise<CopilotStoreSnapshot> {
  if (captured.kind === 'versioned') {
    const record = await captured.store.read(operation)
    return record === undefined
      ? { file: undefined, revision: null }
      : { file: record.value, revision: record.revision }
  }
  return { file: await captured.store.read(), revision: null }
}

async function commitStore(
  captured: CapturedCopilotStore,
  file: CopilotAuthFile,
  expectedRevision: string | null,
  operation: CredentialOperationOptions,
): Promise<void> {
  if (captured.kind === 'versioned') {
    await captured.store.commit({ value: file, expectedRevision }, operation)
    return
  }
  await captured.store.write(file)
}
