/**
 * The one HTTP door for every Copilot call: origin pinning, no-follow, bounded
 * reads, and a caller signal that wins immediately.
 *
 * This is the counterpart of `oauthFetch` in `provider-codex/src/oauth.ts`, kept
 * deliberately close to it — the same guarantees, in the same order, so a reader
 * who knows one knows the other. What differs is scope: Codex has one auth
 * issuer, Copilot has THREE origins, and each is its own option.
 *
 * ## Three origins, three independent pins
 *
 * `oauthIssuer` (`https://github.com`), `githubApiBaseUrl`
 * (`https://api.github.com`) and `baseUrl` (`https://api.githubcopilot.com`) are
 * three separate options, pinned separately by three separate calls to {@link
 * issuerOf}. No module may dispatch a request to an origin other than its own
 * pinned one — the device flow cannot reach the Copilot surface, the Copilot
 * surface cannot reach the token exchange. That is why {@link copilotFetch}
 * demands a {@link CopilotOrigin} rather than reading an origin off a shared
 * options bag: there is no options bag that holds all three, so there is no way
 * to pass the wrong one by forgetting which field applies.
 *
 * The pin is compared BEFORE the request is dispatched (Requirement 3.7). A
 * post-hoc check on the response would already have leaked the `Authorization`
 * header to whatever origin the URL named.
 *
 * ## What is bounded, and why each bound exists
 *
 * - **`redirect: 'manual'` plus {@link rejectCopilotRedirect}** — a followed hop
 *   re-sends the credential headers to the redirect target (Requirements 3.8, 7.8).
 * - **A per-request deadline** — a server that accepts the connection and then
 *   says nothing must not hang a CLI.
 * - **Bytes AND chunk count on every read** — bytes alone still lets a stream of
 *   one-byte chunks pin the event loop, so both are checked (Requirements 4.7, 13.6).
 * - **{@link raceAbort}** — `fetch` honours a signal, but a pending read does not
 *   necessarily reject the instant it aborts. Racing makes the caller's signal win
 *   immediately rather than eventually (Requirement 4.6).
 * - **{@link positiveSafeInteger} on every configured limit** — a `0`, a `NaN` or
 *   a float silently disables a bound, which is worse than rejecting the config.
 *
 * @module ai-agent-sdk/providers/copilot/http
 */

import { AgentSdkError, MODEL_ERROR_CODES, waitForSettlement } from '@alvin0/ai-agent-sdk-core'
import { COPILOT_ERROR_CODES } from './error-codes.ts'
import { rejectCopilotRedirect, type CopilotHttpOperation } from './no-follow.ts'

/** Deadline for one Copilot HTTP request when the caller configures none. */
export const COPILOT_DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Maximum response bytes retained or parsed when the caller configures none. */
export const COPILOT_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

/** Maximum response chunks accepted when the caller configures none. */
export const COPILOT_DEFAULT_MAX_RESPONSE_CHUNKS = 10_000

/** Bound on releasing a body that is being discarded. Never a caller-visible wait. */
const TEARDOWN_TIMEOUT_MS = 30_000

/**
 * Which of the three configurable origins a pin came from.
 *
 * The field name travels with the pin so an origin error can name the option the
 * caller has to fix, rather than saying "origin invalid" about one of three
 * settings.
 */
export type CopilotOriginField = 'oauthIssuer' | 'githubApiBaseUrl' | 'baseUrl'

/** A validated, pinned origin: the only thing {@link copilotFetch} accepts as a target. */
export interface CopilotOrigin {
  /** The option this pin came from. */
  readonly field: CopilotOriginField
  /** Normalized base URL with trailing slashes removed. Safe to concatenate a path onto. */
  readonly href: string
  /** The serialized origin every request URL is compared against. */
  readonly origin: string
}

/** Shared HTTP settings. Every field is optional and every default is a bound, not "unlimited". */
export interface CopilotHttpOptions {
  /** Cancellation for the request and for the body read. */
  readonly signal?: AbortSignal
  /** HTTP implementation, for tests and non-browser runtimes. */
  readonly fetch?: typeof globalThis.fetch
  /** Deadline for one request. Defaults to {@link COPILOT_DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number
  /** Maximum response bytes. Defaults to {@link COPILOT_DEFAULT_MAX_RESPONSE_BYTES}. */
  readonly maxResponseBytes?: number
  /** Maximum response chunks. Defaults to {@link COPILOT_DEFAULT_MAX_RESPONSE_CHUNKS}. */
  readonly maxResponseChunks?: number
  /**
   * Permit an `http:` origin for a trusted local test endpoint. Defaults to false.
   *
   * A separate, explicitly enabled option rather than a lenient default, because
   * cleartext HTTP here carries a bearer token (Requirement 2.2).
   */
  readonly allowInsecureIssuer?: boolean
}

/** One request, carrying the origin it is pinned to and the call site it belongs to. */
export interface CopilotRequest {
  /** The pin from {@link issuerOf}. The URL must be on this origin. */
  readonly pinned: CopilotOrigin
  /** Absolute target URL; build it with {@link copilotUrl} to keep it on the pin. */
  readonly url: string | URL
  /** Which call site this is, for the redirect error. */
  readonly operation: CopilotHttpOperation
  /** Method, headers and body. `signal` and `redirect` are set by this module. */
  readonly init: RequestInit
}

/**
 * Validate and pin one of the three configurable origins.
 *
 * Two rejections, each for a concrete reason:
 *
 * - **Userinfo** (`https://user:pass@host`) — credentials in a URL would be sent
 *   as an extra `Authorization` header the caller never wrote, and they end up in
 *   logs. There is no legitimate use for them on any of these three origins.
 * - **`http:` without `allowInsecureIssuer`** — see the option's note.
 *
 * @param field - which option is being pinned; appears in the error message.
 * @param configured - the caller's value, or `undefined` to take the default.
 * @param fallback - the exported default for this field.
 * @param options - read for `allowInsecureIssuer` only.
 * @returns the pin to hand to {@link copilotFetch}.
 * @throws AgentSdkError with `COPILOT_ENDPOINT_ORIGIN_INVALID` when the value is
 *   unparsable, carries userinfo, or is cleartext without the opt-in.
 */
export function issuerOf(
  field: CopilotOriginField,
  configured: string | undefined,
  fallback: string,
  options: Pick<CopilotHttpOptions, 'allowInsecureIssuer'> = {},
): CopilotOrigin {
  const raw = configured ?? fallback
  let url: URL
  try {
    url = new URL(raw)
  } catch (error: unknown) {
    throw originError(`Copilot ${field} is not an absolute URL`, error)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw originError(`Copilot ${field} must not contain credentials`)
  }
  if (url.protocol !== 'https:'
    && !(options.allowInsecureIssuer === true && url.protocol === 'http:')) {
    throw originError(`Copilot ${field} must use https unless allowInsecureIssuer is enabled`)
  }
  return Object.freeze({ field, href: url.href.replace(/\/+$/, ''), origin: url.origin })
}

/**
 * Build an absolute URL on a pinned origin.
 *
 * The path has to be absolute-and-rooted: a relative path resolved against a base
 * is exactly how a URL quietly ends up somewhere else, and a path that is itself
 * absolute (`//evil.tld/x` or `https://evil.tld/x`) would replace the origin
 * outright.
 * @param pinned - the pin from {@link issuerOf}.
 * @param path - a path beginning with a single `/`.
 * @returns the absolute URL string, guaranteed to be on `pinned.origin`.
 * @throws AgentSdkError with `COPILOT_ENDPOINT_ORIGIN_INVALID` when the path could
 *   move the request off the pin.
 */
export function copilotUrl(pinned: CopilotOrigin, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw originError(`Copilot ${pinned.field} path must start with a single '/'`)
  }
  const url = new URL(`${pinned.href}${path}`)
  if (url.origin !== pinned.origin) {
    throw originError(`Copilot ${pinned.field} path must stay on the pinned origin`)
  }
  return url.href
}

/**
 * Dispatch one Copilot request with the origin pin, no-follow and deadline applied.
 *
 * Order matters and is the contract: the pin is compared FIRST, so a URL on the
 * wrong origin never receives the headers; then the request goes out with
 * `redirect: 'manual'`; then the response passes the redirect guard before it is
 * handed back. The body is left unread — {@link readCopilotResponseText} is the
 * bounded reader for it.
 * @param request - the pin, the URL, the call site and the init.
 * @param options - signal, fetch implementation and limits.
 * @returns the response, already cleared by the redirect guard.
 * @throws AgentSdkError with `COPILOT_ENDPOINT_ORIGIN_INVALID` when the URL is off
 *   the pin, or `COPILOT_REDIRECT_REJECTED` when the response was a redirect.
 */
export async function copilotFetch(
  request: CopilotRequest,
  options: CopilotHttpOptions = {},
): Promise<Response> {
  const url = requestUrl(request)
  const timeoutMs = positiveSafeInteger(
    options.requestTimeoutMs ?? COPILOT_DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  )
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('Copilot HTTP requires fetch')
  const response = await raceAbort(Promise.resolve(fetchImpl(url, {
    ...request.init,
    signal,
    redirect: 'manual',
  })), signal)
  await rejectCopilotRedirect(response, url, request.operation, TEARDOWN_TIMEOUT_MS)
  return response
}

/**
 * Read a response body as text, bounded on bytes and on chunk count.
 *
 * A declared `content-length` over the limit is refused before a single chunk is
 * read; the running totals then catch a body that lies about its length or sends
 * none. Either way the reader is cancelled rather than abandoned.
 * @param response - a response already cleared by {@link copilotFetch}.
 * @param options - limits and the signal to race the read against.
 * @returns the decoded text, or `''` when there was no body.
 * @throws RangeError when a configured bound is exceeded.
 */
export async function readCopilotResponseText(
  response: Response,
  options: CopilotHttpOptions = {},
): Promise<string> {
  const maxBytes = positiveSafeInteger(
    options.maxResponseBytes ?? COPILOT_DEFAULT_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  )
  const maxChunks = positiveSafeInteger(
    options.maxResponseChunks ?? COPILOT_DEFAULT_MAX_RESPONSE_CHUNKS,
    'maxResponseChunks',
  )
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (response.body !== null) {
      await waitForSettlement(response.body.cancel().catch(() => undefined), TEARDOWN_TIMEOUT_MS)
    }
    throw new RangeError(`Copilot HTTP response exceeds the ${maxBytes}-byte limit`)
  }
  if (response.body === null) return ''
  const timeout = AbortSignal.timeout(positiveSafeInteger(
    options.requestTimeoutMs ?? COPILOT_DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  ))
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
        await waitForSettlement(reader.cancel().catch(() => undefined), TEARDOWN_TIMEOUT_MS)
        throw new RangeError('Copilot HTTP response exceeds its configured resource limit')
      }
      result += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Settle as soon as either the pending work or the signal does.
 *
 * An already-aborted signal rejects synchronously rather than after one turn, so
 * a caller who aborts before the call never dispatches the request at all.
 * @param pending - the work to race.
 * @param signal - the signal that gets to win.
 * @returns the pending value, when it arrives first.
 */
export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(abortReason(signal)) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

/**
 * Accept a configured limit only when it can actually bound anything.
 *
 * `0`, a negative, a float and `NaN` all disable a bound silently, so each one is
 * rejected instead of normalized.
 * @param value - the configured number.
 * @param field - the option name, for the message.
 * @returns the value, unchanged.
 * @throws RangeError when the value cannot serve as a bound.
 */
export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Copilot HTTP ${field} must be a positive safe integer`)
  }
  return value
}

/**
 * Resolve the request URL and compare it against the pin, before anything is sent.
 *
 * Userinfo is rejected here as well as in {@link issuerOf}: `URL.origin` ignores
 * it, so a URL on the right origin can still carry credentials the caller never
 * intended to send.
 */
function requestUrl(request: CopilotRequest): string {
  let url: URL
  try {
    url = new URL(request.url)
  } catch (error: unknown) {
    throw originError(`Copilot ${request.operation} target is not an absolute URL`, error)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw originError(`Copilot ${request.operation} target must not contain credentials`)
  }
  if (url.origin !== request.pinned.origin) {
    throw originError(
      `Copilot ${request.operation} target origin '${url.origin}' is not the pinned `
      + `${request.pinned.field} origin '${request.pinned.origin}'`,
    )
  }
  return url.href
}

function originError(message: string, cause?: unknown): AgentSdkError {
  return new AgentSdkError(
    message,
    COPILOT_ERROR_CODES.ENDPOINT_ORIGIN_INVALID,
    cause === undefined ? undefined : { cause },
  )
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new AgentSdkError('Copilot HTTP request aborted', MODEL_ERROR_CODES.ABORTED)
}
