import { COPILOT_ERROR_CODES } from './common/error-codes.ts'
import { CopilotTokenExchangeError, credentialFailure } from './errors.ts'
import type { CopilotApiToken } from './exchange-types.ts'

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
export function readApiToken(raw: string, secrets: readonly string[]): CopilotApiToken {
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
  return Object.freeze({ token, expiresAtMs: expiresAt * 1_000, ...tokenAdvisoryFields(body) })
}

/**
 * Read `endpoints.api` for diagnostics only.
 *
 * Never returned as something to request against — see {@link
 * CopilotApiToken.declaredApiEndpoint} and DD-6.
 * @param endpoints - the `endpoints` member of the response, unvalidated.
 * @returns the declared API endpoint, when it is a non-empty string.
 */
export function declaredEndpointOf(endpoints: unknown): string | undefined {
  if (typeof endpoints !== 'object' || endpoints === null) return undefined
  const api = (endpoints as Record<string, unknown>)['api']
  return typeof api === 'string' && api.length > 0 ? api : undefined
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
export function redact(text: string, secrets: readonly string[]): string {
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
export function malformed(message: string, cause?: unknown): CopilotTokenExchangeError {
  return new CopilotTokenExchangeError(
    credentialFailure(message, cause),
    COPILOT_ERROR_CODES.TOKEN_MALFORMED,
    'permanent',
  )
}

/** Marker used in place of a credential value that appeared in a response body. */
export const REDACTED = '[REDACTED]'

function tokenAdvisoryFields(body: Record<string, unknown>) {
  const refreshIn = body['refresh_in']
  const declared = declaredEndpointOf(body['endpoints'])
  return {
    ...typeof refreshIn === 'number' && Number.isFinite(refreshIn) && refreshIn > 0
      ? { refreshInSeconds: refreshIn }
      : {},
    ...declared === undefined ? {} : { declaredApiEndpoint: declared },
  }
}
