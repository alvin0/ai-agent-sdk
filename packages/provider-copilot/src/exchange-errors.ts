import { AgentSdkError } from '@alvin0/ai-agent-sdk-core'
import { COPILOT_LOGIN_COMMAND } from './auth.ts'
import { COPILOT_ERROR_CODES } from './common/error-codes.ts'
import { readCopilotResponseText } from './common/http.ts'
import { CopilotTokenExchangeError, credentialFailure } from './errors.ts'
import type { CopilotExchangeOptions } from './exchange-types.ts'
import { redact } from './exchange-response.ts'

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
export function rejectDataResidencyTenant(configured: string | undefined): void {
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
export function isDataResidencyHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '')
  return normalized === 'ghe.com' || normalized.endsWith('.ghe.com')
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
export function transportFailure(
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
export async function statusFailure(
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
export async function readFailureBody(
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
 * The one tenant message, so the two paths that reach row 1 and row 4 say the
 * same thing.
 * @param host - the detected host, named in the message (Requirement 13.3).
 * @returns the message text.
 */
export function tenantMessage(host: string): string {
  return `'${host}' is a GitHub data-residency tenant, which does not provide the Copilot `
    + 'token-exchange surface; use a github.com account for this provider'
}
