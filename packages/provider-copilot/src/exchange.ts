/**
 * `Copilot_Token_Exchange`: turn the long-lived `GitHub_User_Token` into the
 * short-lived `Copilot_Api_Token` the Copilot surface accepts.
 *
 * ```text
 * GET https://api.github.com/copilot_internal/v2/token
 * Authorization: Bearer ghu_…
 * Accept: application/json
 * Editor-Version / Editor-Plugin-Version
 * → 200 { token, expires_at, refresh_in?, endpoints?: { api?: string }, … }
 * ```
 *
 * ## The classification order is the contract
 *
 * Nine rows, in this order, each for a concrete reason:
 *
 * ```text
 * 1. host is 'ghe.com' or ends with a '.ghe.com' label ⇒ TENANT_UNSUPPORTED   (before any I/O)
 * 2. origin is not the pinned githubApiBaseUrl origin   ⇒ ENDPOINT_ORIGIN_INVALID (before any I/O)
 * 3. the response is a redirect, in any of its shapes   ⇒ REDIRECT_REJECTED
 * 4. HTTP 404                                          ⇒ TENANT_UNSUPPORTED
 * 5. HTTP 401                                          ⇒ CREDENTIAL_REJECTED   (permanent)
 * 6. HTTP 403                                          ⇒ CREDENTIAL_REJECTED   (permanent)
 * 7. HTTP 429, HTTP 5xx, a network error, or a timeout ⇒ TOKEN_EXCHANGE_FAILED (transient)
 * 8. any remaining 4xx                                 ⇒ TOKEN_EXCHANGE_FAILED (permanent)
 * 9. body is not JSON, or expires_at is unreadable     ⇒ TOKEN_MALFORMED
 * ```
 *
 * Rows 1 and 2 run BEFORE a request is dispatched. A data-residency tenant has no
 * token-exchange surface at all, so asking it is pointless; and an origin check
 * performed after the fact would already have handed the bearer token to whatever
 * origin the URL named (Requirements 3.6, 3.7).
 *
 * Row 1 detects the tenant by DOMAIN LABEL SUFFIX, never by substring: with
 * `includes('ghe.com')`, `ghe.com.evil.tld` and `notghe.com` would both be
 * misread as data-residency tenants, one of which is an attacker-chosen host.
 *
 * Row 6 does the most work of the nine. The endpoint answers 403 both for a
 * personal access token and for a token minted by an OAuth App that is not on
 * GitHub's allowlist, and the response does not distinguish the two — so the
 * message names BOTH possibilities alongside the single instruction that helps in
 * either case (Requirements 3.5, 13.2).
 *
 * ## What is read from the body, and what is refused
 *
 * `expires_at` is MANDATORY and has to be a positive finite number: without it
 * there is no second source for the lifetime, and an invented TTL is exactly the
 * inference this SDK does not make. `refresh_in` is advisory and a bad value is
 * dropped rather than fatal — it can only shorten the refresh moment, so losing
 * it costs nothing. `endpoints.api` is read and exposed for diagnostics but is
 * NEVER used as the base URL: a server-designated base URL is a redirect under
 * another name, and this SDK does not follow provider-controlled redirects
 * (DD-6, Requirements 3.8, 7.8).
 *
 * @module ai-agent-sdk/providers/copilot/exchange
 */

import { AgentSdkError, type ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import { observeCredentialOperation } from '@alvin0/ai-agent-sdk-provider-http'
import {
  COPILOT_EDITOR_PLUGIN_VERSION,
  COPILOT_EDITOR_VERSION,
  type CopilotEditorHeaders,
} from './common/identity.ts'
import {
  COPILOT_LOGIN_COMMAND,
  COPILOT_TOKEN_EXCHANGE_MARGIN_MS,
  requireGitHubToken,
  shouldExchange,
  type CopilotCredentialSnapshot,
} from './auth.ts'
import { COPILOT_ERROR_CODES } from './common/error-codes.ts'
import {
  COPILOT_DEFAULT_REQUEST_TIMEOUT_MS,
  copilotFetch,
  copilotUrl,
  issuerOf,
  positiveSafeInteger,
  raceAbort,
  readCopilotResponseText,
  type CopilotHttpOptions,
} from './common/http.ts'
import type { CopilotGitHubToken } from './common/store-types.ts'
import { CopilotTokenExchangeError, credentialFailure } from './errors.ts'

/** GitHub's API base, where the token-exchange surface lives. */
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'

/** Path of the token-exchange surface. */
export const COPILOT_TOKEN_EXCHANGE_PATH = '/copilot_internal/v2/token'

/** Marker used in place of a credential value that appeared in a response body. */
const REDACTED = '[REDACTED]'

/** Settings for one token exchange. Every field is optional; every default is a bound. */
export interface CopilotExchangeOptions extends CopilotHttpOptions {
  /** Overrides {@link DEFAULT_GITHUB_API_BASE_URL}; pinned as its own origin. */
  readonly githubApiBaseUrl?: string
  /** Overrides for the two mandatory editor headers. */
  readonly editorHeaders?: CopilotEditorHeaders
  /**
   * Further secret values to strike out of any body this exchange retains,
   * beyond the credential it sends itself.
   *
   * Requirement 13.7 is stated over BOTH tokens, not just the one a given request
   * carries, and an exchange knows only its own. The remaining value — the
   * `Copilot_Api_Token` currently held — reaches this path from
   * {@link createCopilotTokenCache}, which is the one component holding both at
   * once. Without it, a body echoing the live API token back would travel into
   * `cause` intact, because the redaction here would be looking for the wrong
   * string.
   */
  readonly additionalSecrets?: readonly string[]
}

/**
 * The result of one `Copilot_Token_Exchange`, held in process memory only.
 *
 * Structurally satisfies `CopilotTokenExpiry` from `./auth.ts`, so `shouldExchange`
 * accepts one of these with no conversion.
 */
export interface CopilotApiToken {
  /** Bearer token for the Copilot API base. Short-lived, ~25 minutes. */
  readonly token: string
  /** Expiry instant in epoch MILLISECONDS, derived from `expires_at` (seconds). */
  readonly expiresAtMs: number
  /** The endpoint's `refresh_in` hint in seconds, when it sent a usable one. ADVISORY. */
  readonly refreshInSeconds?: number
  /**
   * The endpoint's declared `endpoints.api`, when present.
   *
   * MUST NOT be used as a base URL. A server-designated base URL is a redirect
   * under another name, and Requirements 3.8/7.8 settled that this SDK does not
   * follow provider-controlled redirection. This field exists so `--status` can
   * print it and so a configuration drift is visible. See DD-6.
   */
  readonly declaredApiEndpoint?: string
}

/**
 * Exchange a `GitHub_User_Token` for a `Copilot_Api_Token`.
 *
 * The long-lived credential is NOT consumed: nothing here writes to a store, and
 * the persisted value is left exactly as it was (Requirement 3.4).
 * @param github - the long-lived GitHub user token. Its value never reaches an
 *   error message, and any occurrence of it in a response body is redacted before
 *   the body is retained as a cause (Requirement 13.7).
 * @param options - base URL override, injected fetch, signal, and the read bounds.
 * @returns the short-lived token plus its expiry and the advisory fields.
 * @throws AgentSdkError with `COPILOT_ENDPOINT_ORIGIN_INVALID` or
 *   `COPILOT_REDIRECT_REJECTED`, or {@link CopilotTokenExchangeError} with
 *   `COPILOT_TENANT_UNSUPPORTED`, `COPILOT_CREDENTIAL_REJECTED`,
 *   `COPILOT_TOKEN_EXCHANGE_FAILED` or `COPILOT_TOKEN_MALFORMED`, per the
 *   classification order in the module note.
 */
export async function exchangeCopilotToken(
  github: CopilotGitHubToken,
  options: CopilotExchangeOptions = {},
): Promise<CopilotApiToken> {
  // Row 1, before any I/O: a data-residency tenant has no surface to ask.
  rejectDataResidencyTenant(options.githubApiBaseUrl)
  // Row 2, before any I/O: pin the origin, then build the URL on that pin.
  const pinned = issuerOf(
    'githubApiBaseUrl',
    options.githubApiBaseUrl,
    DEFAULT_GITHUB_API_BASE_URL,
    options,
  )
  const url = copilotUrl(pinned, COPILOT_TOKEN_EXCHANGE_PATH)
  const host = new URL(pinned.origin).hostname
  let response: Response
  try {
    // Rows 3: `copilotFetch` re-checks the pin and refuses every redirect shape.
    response = await copilotFetch({
      pinned,
      url,
      operation: 'token exchange',
      init: { method: 'GET', headers: exchangeHeaders(github, options.editorHeaders) },
    }, options)
  } catch (error: unknown) {
    throw transportFailure(error, host, options)
  }
  // Every value that must not survive into a retained body: the credential this
  // request carries, plus whatever else the caller knows is live.
  const secrets = [github.token, ...options.additionalSecrets ?? []]
  // Rows 4 through 8.
  if (!response.ok) throw await statusFailure(response, host, secrets, options)
  // Row 9.
  return readApiToken(await readCopilotResponseText(response, options), secrets)
}

/**
 * Row 1: refuse a `*.ghe.com` tenant by domain label, before anything is sent.
 *
 * An unparsable value is left alone rather than reported here — {@link issuerOf}
 * owns that message, and reporting it as a tenant problem would name the wrong
 * cause.
 * @param configured - the caller's `githubApiBaseUrl`, when they set one.
 * @throws CopilotTokenExchangeError with `COPILOT_TENANT_UNSUPPORTED`, naming the
 *   detected domain (Requirement 13.3).
 */
function rejectDataResidencyTenant(configured: string | undefined): void {
  if (configured === undefined) return
  let host: string
  try {
    host = new URL(configured).hostname
  } catch {
    return
  }
  if (!isDataResidencyHost(host)) return
  throw new CopilotTokenExchangeError(
    credentialFailure(tenantMessage(host)),
    COPILOT_ERROR_CODES.TENANT_UNSUPPORTED,
    'permanent',
  )
}

/**
 * Whether a hostname belongs to the `ghe.com` data-residency namespace.
 *
 * Matched on DOMAIN LABELS, which is the whole point: `ghe.com.evil.tld` and
 * `notghe.com` are not data-residency hosts, and a substring test would call both
 * of them one.
 * @param host - a hostname, without a port.
 * @returns true for `ghe.com` itself and for any host under it.
 */
function isDataResidencyHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '')
  return normalized === 'ghe.com' || normalized.endsWith('.ghe.com')
}

/**
 * Headers for the exchange request.
 *
 * Both editor headers are mandatory: with either one missing the endpoint answers
 * HTTP 400 and the request never runs. An override of one leaves the other at its
 * exported default rather than dropping it.
 * @param github - the credential whose value goes in `Authorization`.
 * @param headers - per-call overrides for the editor identity.
 * @returns the header map for the request init.
 */
function exchangeHeaders(
  github: CopilotGitHubToken,
  headers: CopilotEditorHeaders | undefined,
): Record<string, string> {
  return {
    authorization: `Bearer ${github.token}`,
    accept: 'application/json',
    'editor-version': headers?.editorVersion ?? COPILOT_EDITOR_VERSION,
    'editor-plugin-version': headers?.editorPluginVersion ?? COPILOT_EDITOR_PLUGIN_VERSION,
  }
}

/**
 * Rows 3 and 7 on the dispatch path: keep the structural refusals, classify the
 * rest as transient.
 *
 * Four kinds of failure pass through UNCHANGED, because wrapping each one would
 * replace a precise diagnosis with a vaguer one:
 *
 * - the origin refusal and the redirect refusal, which are rows 2 and 3 and
 *   already carry their own codes;
 * - a caller abort, which keeps the SDK's abort code rather than becoming a
 *   Copilot failure the caller did not ask about (Requirement 4.6);
 * - a `RangeError` from a bound, which names the limit that was exceeded and is
 *   neither a network fault nor a server fault (Requirement 13.6).
 *
 * Everything else — DNS, connection reset, TLS, and the per-request deadline —
 * is transient: it is exactly the class of failure that a later attempt can win.
 * @param error - the caught value.
 * @param host - the host that was contacted, for the message.
 * @param options - read for the caller's signal only.
 * @returns the value to throw.
 */
function transportFailure(
  error: unknown,
  host: string,
  options: CopilotExchangeOptions,
): unknown {
  if (options.signal?.aborted === true) return error
  if (error instanceof RangeError) return error
  if (error instanceof AgentSdkError
    && (error.code === COPILOT_ERROR_CODES.ENDPOINT_ORIGIN_INVALID
      || error.code === COPILOT_ERROR_CODES.REDIRECT_REJECTED)) {
    return error
  }
  return new CopilotTokenExchangeError(
    credentialFailure(
      `Copilot token exchange could not reach ${host}; the request failed before a response`,
      error,
    ),
    COPILOT_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
    'transient',
  )
}

/**
 * Rows 4 through 8: classify a response that arrived but was not a success.
 *
 * The body is read through the bounded reader first, so the cause carries the
 * endpoint's own words — with every occurrence of the credential replaced —
 * rather than nothing at all (Requirements 13.6, 13.7). A read that fails is not
 * allowed to hide the status: the classification stands either way.
 * @param response - a non-ok response, already cleared by the redirect guard.
 * @param host - the host that answered, for the tenant message.
 * @param secrets - every live credential value to redact out of the body.
 * @param options - the read bounds and the signal.
 * @returns the classified error to throw.
 */
async function statusFailure(
  response: Response,
  host: string,
  secrets: readonly string[],
  options: CopilotExchangeOptions,
): Promise<CopilotTokenExchangeError> {
  const body = await readFailureBody(response, secrets, options)
  const cause = body === undefined ? undefined : new Error(body)
  if (response.status === 404) {
    return new CopilotTokenExchangeError(
      credentialFailure(tenantMessage(host), cause),
      COPILOT_ERROR_CODES.TENANT_UNSUPPORTED,
      'permanent',
    )
  }
  if (response.status === 401) {
    return new CopilotTokenExchangeError(
      credentialFailure(
        'the Copilot token-exchange surface rejected the stored GitHub credential '
        + `(HTTP 401); run \`${COPILOT_LOGIN_COMMAND}\` to sign in again`,
        cause,
      ),
      COPILOT_ERROR_CODES.CREDENTIAL_REJECTED,
      'permanent',
    )
  }
  if (response.status === 403) {
    // The endpoint answers 403 for BOTH a personal access token and a token from
    // a non-allowlisted OAuth App, and the response does not say which — so both
    // are named, with the one instruction that resolves either.
    return new CopilotTokenExchangeError(
      credentialFailure(
        'the Copilot token-exchange surface refused this credential type (HTTP 403). '
        + 'It accepts only a token minted by an OAuth App on GitHub\'s allowlist: a '
        + 'personal access token cannot be used here, and neither can a token from an '
        + `OAuth App that is not allowlisted. Run \`${COPILOT_LOGIN_COMMAND}\` to sign `
        + 'in with the supported client.',
        cause,
      ),
      COPILOT_ERROR_CODES.CREDENTIAL_REJECTED,
      'permanent',
    )
  }
  // 429 sits with the 5xx row rather than with the remaining 4xx: the design's
  // classification table gives it `transient`, and it is the one 4xx whose cause
  // a later attempt can actually clear. Every other 4xx fails identically forever.
  const transient = response.status >= 500 || response.status === 429
  return new CopilotTokenExchangeError(
    credentialFailure(
      `Copilot token exchange failed (HTTP ${response.status})`,
      cause,
    ),
    COPILOT_ERROR_CODES.TOKEN_EXCHANGE_FAILED,
    transient ? 'transient' : 'permanent',
  )
}

/**
 * Read an error body within the configured bounds, redacted, or give up quietly.
 *
 * Giving up quietly is deliberate: the status has already decided the
 * classification, and a body that could not be read must not turn a precise 403
 * into a read error.
 * @param response - the non-ok response.
 * @param secrets - every live credential value to redact.
 * @param options - the read bounds and the signal.
 * @returns the redacted text, or `undefined` when it could not be read.
 */
async function readFailureBody(
  response: Response,
  secrets: readonly string[],
  options: CopilotExchangeOptions,
): Promise<string | undefined> {
  try {
    const text = await readCopilotResponseText(response, options)
    return text.length === 0 ? undefined : redact(text, secrets)
  } catch {
    return undefined
  }
}

/**
 * Row 9: read the success body, requiring exactly what cannot be inferred.
 *
 * `token` and `expires_at` are mandatory; everything else is advisory and a
 * useless value is dropped rather than raised, because a dropped hint changes
 * nothing about correctness while a raised one would fail an exchange that
 * actually produced a usable token.
 * @param raw - the bounded response text.
 * @param secrets - every live credential value to redact out of the cause.
 * @returns the token this exchange produced.
 * @throws CopilotTokenExchangeError with `COPILOT_TOKEN_MALFORMED` when the body
 *   is not a JSON object, `token` is not a non-empty string, or `expires_at` is
 *   not a positive finite number.
 */
function readApiToken(raw: string, secrets: readonly string[]): CopilotApiToken {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error: unknown) {
    throw malformed('the Copilot token-exchange response was not JSON', error)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformed('the Copilot token-exchange response was not a JSON object')
  }
  const body = parsed as Record<string, unknown>
  const token = body['token']
  if (typeof token !== 'string' || token.length === 0) {
    throw malformed('the Copilot token-exchange response carried no token')
  }
  const expiresAt = body['expires_at']
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw malformed(
      'the Copilot token-exchange response carried no readable expires_at; '
      + 'this SDK does not invent a token lifetime',
      new Error(redact(raw, secrets)),
    )
  }
  const refreshIn = body['refresh_in']
  const declared = declaredEndpointOf(body['endpoints'])
  return Object.freeze({
    token,
    expiresAtMs: expiresAt * 1_000,
    ...typeof refreshIn === 'number' && Number.isFinite(refreshIn) && refreshIn > 0
      ? { refreshInSeconds: refreshIn }
      : {},
    ...declared === undefined ? {} : { declaredApiEndpoint: declared },
  })
}

/**
 * Read `endpoints.api` for diagnostics only.
 *
 * Never returned as something to request against — see {@link
 * CopilotApiToken.declaredApiEndpoint} and DD-6.
 * @param endpoints - the `endpoints` member of the response, unvalidated.
 * @returns the declared API endpoint, when it is a non-empty string.
 */
function declaredEndpointOf(endpoints: unknown): string | undefined {
  if (typeof endpoints !== 'object' || endpoints === null) return undefined
  const api = (endpoints as Record<string, unknown>)['api']
  return typeof api === 'string' && api.length > 0 ? api : undefined
}

/**
 * The one tenant message, so the two paths that reach row 1 and row 4 say the
 * same thing.
 * @param host - the detected host, named in the message (Requirement 13.3).
 * @returns the message text.
 */
function tenantMessage(host: string): string {
  return `'${host}' is a GitHub data-residency tenant, which does not provide the Copilot `
    + 'token-exchange surface; use a github.com account for this provider'
}

/**
 * Replace every occurrence of every live credential value in text with
 * {@link REDACTED}.
 *
 * A response body is endpoint-authored text, and an endpoint that echoes the
 * `Authorization` header back is exactly how a token ends up in a log. The list
 * is plural because Requirement 13.7 covers BOTH tokens: this request carries one
 * of them, and the other arrives through
 * {@link CopilotExchangeOptions.additionalSecrets}.
 * @param text - the body text.
 * @param secrets - the credential values; empty entries are ignored.
 * @returns the text with every value removed.
 */
function redact(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    result = result.split(secret).join(REDACTED)
  }
  return result
}

/**
 * Build the row-9 error.
 * @param message - SDK-authored text.
 * @param cause - the caught value or the redacted body, when there is one.
 * @returns the malformed-token error.
 */
function malformed(message: string, cause?: unknown): CopilotTokenExchangeError {
  return new CopilotTokenExchangeError(
    credentialFailure(message, cause),
    COPILOT_ERROR_CODES.TOKEN_MALFORMED,
    'permanent',
  )
}
/**
 * A cache entry, bound to exactly the credential that produced it.
 *
 * The pair `(sourceToken, sourceRevision)` is the whole key: signing in as a
 * different account invalidates the entry the moment the store returns a
 * different token value, with no TTL involved and no clock consulted.
 */
export interface CopilotTokenCacheEntry {
  /** The token this credential produced. */
  readonly api: CopilotApiToken
  /** The `GitHub_User_Token` value used. Compared with `===`. */
  readonly sourceToken: string
  /** The store revision at read time, or `null` for a store without revisions. */
  readonly sourceRevision: string | null
}

/**
 * The process-memory cache in front of {@link exchangeCopilotToken}.
 *
 * Owned by an adapter instance, and injectable through the adapter's `tokenCache`
 * option so several routes sharing one unchanged credential exchange once rather
 * than once per route.
 */
export interface CopilotTokenCache {
  /**
   * Return a live `Copilot_Api_Token` for this credential, exchanging when due.
   *
   * Concurrent calls that all need an exchange are COALESCED into exactly one
   * in-flight exchange (Requirement 5.4).
   * @param source - one read of the credential store, revision included.
   * @param operation - the calling operation; only its signal is read, and it
   *   bounds THIS caller's wait, never the shared exchange.
   * @param context - invocation context for the observation record, when there is one.
   * @returns a token that is live as of the decision moment.
   */
  acquire(
    source: CopilotCredentialSnapshot,
    operation: CredentialOperationOptions,
    context?: ModelInvocationContext,
  ): Promise<CopilotApiToken>
  /** Drop the current entry; used when the API surface rejects a token before its expiry. */
  invalidate(): void
}

/** Provider name recorded on the credential-operation observation by default. */
export const COPILOT_PROVIDER_ID = 'copilot'

/** Settings for {@link createCopilotTokenCache}: the exchange settings, plus a clock. */
export interface CopilotTokenCacheOptions extends CopilotExchangeOptions {
  /**
   * Provider name on the observation record. Defaults to {@link COPILOT_PROVIDER_ID}.
   *
   * An adapter with a custom `id` passes it here so the record names the provider
   * the caller configured rather than the family.
   */
  readonly providerId?: string
  /** Exchange this long before expiry. Defaults to `COPILOT_TOKEN_EXCHANGE_MARGIN_MS`. */
  readonly marginMs?: number
  /**
   * The clock the exchange decision reads, injectable so a test places `now`
   * exactly on a boundary instead of waiting for one.
   */
  readonly now?: () => number
}

/**
 * Build a token cache over one set of exchange settings.
 *
 * ## The mistake this is written to avoid
 *
 * The shared exchange gets its OWN `AbortController` plus its own deadline, and
 * NEVER any single caller's signal. Were the caller's signal handed to it, the
 * first caller to abort would cancel the exchange every other caller is waiting
 * on, and those callers would fail for a reason that has nothing to do with them.
 * Instead each caller — the one that started the exchange included — races the
 * shared promise against its OWN signal: an aborted caller leaves, and the
 * exchange still completes for everyone else (Property 18).
 *
 * The observation therefore counts exchanges actually DISPATCHED rather than
 * callers served, which is what makes the coalescing observable instead of merely
 * claimed (Property 52). It is recorded with the `'refresh'` operation name: that
 * parameter's union is closed at `'resolve' | 'refresh' | 'login'`, widening it
 * would change a public type of `provider-http`, and Requirement 18.4 forbids
 * that — see DD-7.
 *
 * ## Two paths deliberately absent
 *
 * There is no revision-conflict recovery, unlike `provider-codex`. That path
 * exists there because a Codex refresh token rotates and is single-use, so a lost
 * race destroys a credential. A `GitHub_User_Token` does not rotate and an
 * exchange does not consume it, so two racing processes simply exchange twice —
 * and a branch no situation reaches is a branch nothing verifies (DD-8).
 *
 * Nothing here writes to a store. The `Copilot_Api_Token` is never persisted: it
 * lives ~25 minutes, so persisting it would add a second secret on disk, a second
 * write path, and a new state to reason about, to save one request inside a
 * 25-minute window (DD-9, Requirement 3.3).
 *
 * A failure is returned to every waiting caller as-is and never retried here — an
 * endpoint that rejected the credential will reject it again, and this layer has
 * no way to change that (Requirement 5.8, Property 19).
 * @param options - exchange settings, the observation provider name, the margin
 *   and the clock. `options.signal` is deliberately IGNORED for the exchange
 *   itself; per-caller cancellation travels through `operation.signal`.
 * @returns a cache over a single credential slot.
 */
export function createCopilotTokenCache(
  options: CopilotTokenCacheOptions = {},
): CopilotTokenCache {
  const provider = options.providerId ?? COPILOT_PROVIDER_ID
  const now = options.now ?? (() => Date.now())
  const marginMs = options.marginMs === undefined
    ? COPILOT_TOKEN_EXCHANGE_MARGIN_MS
    : positiveSafeInteger(options.marginMs, 'marginMs')
  let entry: CopilotTokenCacheEntry | undefined
  let inflight: Promise<CopilotApiToken> | undefined
  let inflightToken: string | undefined
  let ticket = 0
  return {
    async acquire(
      source: CopilotCredentialSnapshot,
      operation: CredentialOperationOptions,
      context?: ModelInvocationContext,
    ): Promise<CopilotApiToken> {
      operation.signal.throwIfAborted()
      const github = requireGitHubToken(source.file, source.label)
      const cached = entry
      if (cached !== undefined
        && cached.sourceToken === github.token
        && cached.sourceRevision === source.revision
        && !shouldExchange(cached.api, now(), marginMs)) {
        return cached.api
      }
      // Coalesce: an exchange already flying for THIS credential value serves
      // this caller too, and the caller still leaves on its own signal.
      if (inflight !== undefined && inflightToken === github.token) {
        return await raceAbort(inflight, operation.signal)
      }
      ticket++
      const id = ticket
      const pending = runExchange(id)
      inflight = pending
      inflightToken = github.token
      return await raceAbort(pending, operation.signal)

      /**
       * Dispatch the one shared exchange and record its result.
       * @param slot - this exchange's ticket, so a later exchange's teardown does
       *   not clear a newer in-flight one.
       * @returns the exchanged token.
       */
      async function runExchange(slot: number): Promise<CopilotApiToken> {
        // The cache is the only place BOTH tokens are known at once, so it is the
        // only place that can tell the exchange about the second one. Without
        // this, a body echoing the API token currently held would reach `cause`
        // intact: the exchange redacts the credential it sends, and that is a
        // different string (Requirement 13.7).
        const held = entry?.api.token
        try {
          const api = await observeCredentialOperation(
            context,
            provider,
            'refresh',
            () => exchangeCopilotToken(github, {
              ...options,
              ...held === undefined
                ? {}
                : { additionalSecrets: [...options.additionalSecrets ?? [], held] },
              signal: sharedExchangeSignal(options),
            }),
          )
          entry = Object.freeze({
            api,
            sourceToken: github.token,
            sourceRevision: source.revision,
          })
          return api
        } finally {
          if (ticket === slot) {
            inflight = undefined
            inflightToken = undefined
          }
        }
      }
    },
    invalidate(): void {
      // Only the entry goes. An in-flight exchange is left alone: it was started
      // by callers that are still waiting on it, and the token it produces is
      // newer than the one being rejected here.
      entry = undefined
    },
  }
}

/**
 * The shared exchange's own cancellation source: one controller, driven by one
 * deadline, and reachable by no caller.
 *
 * The deadline is what makes the controller more than ceremony. `copilotFetch`
 * bounds its own dispatch, but the bounded body read afterwards races only the
 * signal it was given — so without a deadline on this signal a stalled read would
 * hold the in-flight slot open indefinitely and every coalesced caller with it.
 * @param options - read for `requestTimeoutMs`.
 * @returns a signal that aborts on the exchange deadline and on nothing else.
 * @throws RangeError when `requestTimeoutMs` cannot serve as a bound.
 */
function sharedExchangeSignal(options: CopilotTokenCacheOptions): AbortSignal {
  const controller = new AbortController()
  const deadline = AbortSignal.timeout(positiveSafeInteger(
    options.requestTimeoutMs ?? COPILOT_DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
  ))
  deadline.addEventListener('abort', () => { controller.abort(deadline.reason) }, { once: true })
  return controller.signal
}
