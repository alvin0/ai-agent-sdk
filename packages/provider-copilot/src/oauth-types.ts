import type { SdkLogger } from '@alvin0/ai-agent-sdk-core/provider'
import { type CopilotHttpOptions } from './common/http.ts'
import type {
  CopilotAccountIdentity, CopilotAuthFile, CopilotAuthStore, CopilotCredentialStore,
} from './common/store-types.ts'

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
export const DEVICE_CODE_PATH = '/login/device/code'

/** GitHub's device-token leg. */
export const DEVICE_TOKEN_PATH = '/login/oauth/access_token'

/** The device-code grant type, spelled as RFC 8628 requires. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

/** The command that produces a credential, named when a login ends without one. */
export const COPILOT_LOGIN_COMMAND = 'npm run provider:copilot:login-device'

export const NEVER_ABORTED_SIGNAL: AbortSignal = new AbortController().signal

export const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
})

/** The real scheduler: `setTimeout`, `clearTimeout` and `Date.now`. */
export const DEFAULT_COPILOT_TIMER: CopilotTimer = Object.freeze({
  setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
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

export type AnyCopilotStore = CopilotAuthStore | CopilotCredentialStore

export interface CopilotStoreSnapshot {
  readonly file: CopilotAuthFile | undefined
  readonly revision: string | null
}

/** What the token leg hands back once the user approves. */
export interface CopilotAccessToken {
  readonly accessToken: string
  readonly tokenType: string | undefined
  readonly scope: string | undefined
  readonly account: CopilotAccountIdentity | undefined
}

/** One bounded read of an OAuth response, plus the status it came with. */
export interface DeviceJson {
  readonly ok: boolean
  readonly status: number
  readonly json: Record<string, unknown>
  /** Why the body was not usable JSON, when it was not. */
  readonly parseError: unknown
}
