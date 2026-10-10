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

export { exchangeCopilotToken } from './exchange-operation.ts'
export { createCopilotTokenCache } from './token-cache.ts'
export { DEFAULT_GITHUB_API_BASE_URL, COPILOT_TOKEN_EXCHANGE_PATH, COPILOT_PROVIDER_ID } from './exchange-types.ts'
export type {
  CopilotExchangeOptions, CopilotApiToken, CopilotTokenCacheEntry, CopilotTokenCache,
  CopilotTokenCacheOptions,
} from './exchange-types.ts'
