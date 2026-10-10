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

import {
  COPILOT_EDITOR_PLUGIN_VERSION, COPILOT_EDITOR_VERSION, type CopilotEditorHeaders,
} from './common/identity.ts'
import { copilotFetch, copilotUrl, issuerOf, readCopilotResponseText } from './common/http.ts'
import type { CopilotGitHubToken } from './common/store-types.ts'
import { DEFAULT_GITHUB_API_BASE_URL, COPILOT_TOKEN_EXCHANGE_PATH } from './exchange-types.ts'
import type { CopilotExchangeOptions, CopilotApiToken } from './exchange-types.ts'
export { DEFAULT_GITHUB_API_BASE_URL, COPILOT_TOKEN_EXCHANGE_PATH, COPILOT_PROVIDER_ID } from './exchange-types.ts'
export type {
  CopilotExchangeOptions, CopilotApiToken, CopilotTokenCacheEntry, CopilotTokenCache,
  CopilotTokenCacheOptions,
} from './exchange-types.ts'
import { rejectDataResidencyTenant, transportFailure, statusFailure } from './exchange-errors.ts'
import { readApiToken } from './exchange-response.ts'

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
 * Headers for the exchange request.
 *
 * Both editor headers are mandatory: with either one missing the endpoint answers
 * HTTP 400 and the request never runs. An override of one leaves the other at its
 * exported default rather than dropping it.
 * @param github - the credential whose value goes in `Authorization`.
 * @param headers - per-call overrides for the editor identity.
 * @returns the header map for the request init.
 */
export function exchangeHeaders(
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
