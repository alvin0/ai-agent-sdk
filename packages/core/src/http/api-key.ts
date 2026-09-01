/**
 * The one definition of a well-formed provider API key, shared by every adapter
 * that puts one into an HTTP header.
 *
 * @module ai-agent-sdk/core/http/api-key
 */

import { AgentSdkError, INVALID_CREDENTIAL_CODE } from '../errors/agent-sdk-error.ts'

/**
 * Characters an HTTP header value carries verbatim and every known provider key
 * uses: printable ASCII, space excluded.
 *
 * A key outside this set cannot reach ANY provider, because `fetch` refuses to
 * build the header  Eso this is a transport invariant, not one vendor's policy.
 * Latin-1 is excluded on purpose: a header could carry it, but no provider
 * issues it, and admitting it would trade a local explained refusal for an
 * opaque 401 much later.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/** Why a supplied API key cannot be used. */
export type ApiKeyRejection = 'empty' | 'illegalCharacters'

/** The verdict on one supplied API key. */
export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

/**
 * Judge one SUPPLIED API key, trimming surrounding whitespace first.
 *
 * Trimming is silent because a padded key has exactly one sensible reading, and
 * keys routinely pick up whitespace from `.env` files and shell exports. Every
 * other defect is reported rather than repaired.
 *
 * Absence is a state this function never sees: a route may legitimately
 * authenticate through ambient provider credential discovery, so the caller
 * decides whether a value was supplied at all before asking.
 * @param raw - the key exactly as configured, stored, or typed.
 * @returns the trimmed key, or why it cannot be used.
 */
export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/**
 * Accept one supplied credential, or refuse it with a diagnosis.
 *
 * Fails here rather than inside `fetch`, whose ByteString refusal names a UTF-16
 * code point instead of the setting to change. The key itself NEVER enters the
 * message: `ref` names where to fix it, and echoing any part of a secret into a
 * log or a UI is precisely the failure this avoids.
 * @param raw - the credential exactly as supplied.
 * @param provider - the refusing provider name, prefixed to the diagnostic.
 * @param ref - how the credential was referenced (e.g. an env var name).
 * @returns the trimmed, usable key.
 */
export function assertUsableApiKey(raw: string, provider: string, ref: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new AgentSdkError(
    checked.reason === 'empty'
      ? `${provider}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
      : `${provider}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone`,
    INVALID_CREDENTIAL_CODE,
  )
}
