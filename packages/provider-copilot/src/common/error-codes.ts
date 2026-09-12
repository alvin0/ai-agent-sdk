/**
 * The Copilot error codes, in the leaf layer so the shared HTTP modules can reach
 * them.
 *
 * The taxonomy BELONGS to `../errors.ts` — that module is the public door, and it
 * re-exports everything here. The definition lives one layer down for a structural
 * reason: `common/` is a leaf, and `common/http.ts` needs
 * `ENDPOINT_ORIGIN_INVALID` and `COPILOT_REDIRECT_REJECTED` to throw. Importing
 * them from a root module would make `common/` depend on the root while the root
 * already depends on `common/`, which is the source-ownership cycle the repo's
 * package-graph check forbids. Duplicating the two strings instead would be worse:
 * a code that exists in two places is a code that can disagree with itself.
 *
 * Read `../errors.ts` for the taxonomy's rationale, including the three situations
 * that deliberately get an EXISTING SDK code rather than a Copilot one.
 *
 * @module ai-agent-sdk/providers/copilot/error-codes
 */

/**
 * Stable codes for the failures that are specific to Copilot.
 *
 * Frozen, and flat strings rather than a TS enum, for the same reason the core
 * taxonomy is: a consumer routes on the value, and the value has to survive
 * serialization into a log line.
 */
export const COPILOT_ERROR_CODES = Object.freeze({
  /** The token-exchange surface rejected the credential: a PAT, or a non-allowlisted OAuth App. */
  CREDENTIAL_REJECTED: 'COPILOT_CREDENTIAL_REJECTED',
  /** Token exchange failed for a reason that is not the credential. */
  TOKEN_EXCHANGE_FAILED: 'COPILOT_TOKEN_EXCHANGE_FAILED',
  /** The token-exchange response carried no readable `expires_at`, or was not JSON. */
  TOKEN_MALFORMED: 'COPILOT_TOKEN_MALFORMED',
  /** A `*.ghe.com` data-residency tenant has no token-exchange surface. */
  TENANT_UNSUPPORTED: 'COPILOT_TENANT_UNSUPPORTED',
  /** The endpoint rejected the request for missing `Editor_Headers`. */
  EDITOR_HEADERS_MISSING: 'COPILOT_EDITOR_HEADERS_MISSING',
  /** The target URL is not on the same origin as the configured issuer/base URL. */
  ENDPOINT_ORIGIN_INVALID: 'COPILOT_ENDPOINT_ORIGIN_INVALID',
  /** The response was a redirect; this SDK does not follow it. */
  REDIRECT_REJECTED: 'COPILOT_REDIRECT_REJECTED',
  /** Device flow: the user denied the request. */
  DEVICE_LOGIN_DENIED: 'COPILOT_DEVICE_LOGIN_DENIED',
  /** Device flow: the code expired server-side. */
  DEVICE_LOGIN_EXPIRED: 'COPILOT_DEVICE_LOGIN_EXPIRED',
  /** Device flow: the absolute 15-minute bound passed without approval. */
  DEVICE_LOGIN_TIMEOUT: 'COPILOT_DEVICE_LOGIN_TIMEOUT',
  /** Device flow: failed for any other reason. */
  DEVICE_LOGIN_FAILED: 'COPILOT_DEVICE_LOGIN_FAILED',
  /** A credential commit found a revision other than the expected one. */
  CREDENTIAL_REVISION_CONFLICT: 'COPILOT_CREDENTIAL_REVISION_CONFLICT',
  /** The `/models` response was the wrong shape at the structural level. */
  CATALOG_MALFORMED: 'COPILOT_CATALOG_MALFORMED',
  /** `endpointOverrides` pinned a model to an endpoint that does not exist. */
  ENDPOINT_OVERRIDE_INVALID: 'COPILOT_ENDPOINT_OVERRIDE_INVALID',
} as const)

/** One of the codes {@link COPILOT_ERROR_CODES} owns. */
export type CopilotErrorCode = (typeof COPILOT_ERROR_CODES)[keyof typeof COPILOT_ERROR_CODES]
