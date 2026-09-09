/**
 * Universal Codex credential contracts and JWT helpers.
 *
 * Storage is injected. Filesystem/path/environment ownership belongs to the
 * Node auth package, never this Universal provider.
 */

import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@ai-agent-sdk/core'
import {
  defineCredentialStore,
} from '@ai-agent-sdk/core/provider'
import type {
  CodexAuthFile,
  CodexAuthStore,
  CodexCredentialStore,
  CodexTokens,
} from './common/store-types.ts'

export type { CodexAuthFile, CodexAuthStore, CodexCredentialStore, CodexTokens } from './common/store-types.ts'

/** An in-memory {@link CodexAuthStore}, for tests. */
export function memoryCodexAuthStore(initial?: CodexAuthFile): CodexAuthStore {
  let current = initial
  return {
    location: '<memory>',
    read: () => Promise.resolve(current),
    write: (file) => {
      current = file
      return Promise.resolve()
    },
  }
}

/** In-memory compare-and-swap store for deterministic runtime/tests. */
export function memoryCodexCredentialStore(initial?: CodexAuthFile): CodexCredentialStore {
  let current = initial === undefined ? undefined : structuredClone(initial)
  let revision = 0
  return defineCredentialStore<CodexAuthFile>({
    id: 'codex-memory-credentials',
    label: '<memory>',
    async read({ signal }) {
      signal.throwIfAborted()
      return current === undefined
        ? undefined
        : { value: structuredClone(current), revision: String(revision) }
    },
    async commit(input, { signal }) {
      signal.throwIfAborted()
      const expected = current === undefined ? null : String(revision)
      if (input.expectedRevision !== expected) {
        throw new AgentSdkError(
          'Codex credential revision changed before commit',
          'CODEX_CREDENTIAL_REVISION_CONFLICT',
        )
      }
      current = structuredClone(input.value)
      revision++
      return { revision: String(revision) }
    },
  })
}

/** The custom claim namespace OpenAI puts its ChatGPT account fields under. */
const AUTH_CLAIM_NAMESPACE = 'https://api.openai.com/auth'

/** Claims this SDK reads out of a Codex JWT. */
export interface CodexJwtClaims {
  exp?: number
  email?: string
  accountId?: string
  planType?: string
  isFedramp: boolean
}

/** Decode a base64url segment without requiring Node's Buffer. */
function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (segment.length % 4)) % 4)
  const binary = atob(padded)
  // The payload is UTF-8; `atob` yields latin1, so re-decode to preserve
  // non-ASCII values such as an email with accented characters.
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Read the claims this SDK cares about out of a JWT.
 *
 * The signature is NOT verified, and does not need to be: this token is being
 * read to decide which account id to send and whether to refresh, not to grant
 * anything. The issuer verifies it.
 * @param jwt - a compact-serialization JWT.
 * @returns the claims, or `undefined` when the token is unreadable.
 */
export function readJwtClaims(jwt: string): CodexJwtClaims | undefined {
  const parts = jwt.split('.')
  const payload = parts.length === 3 ? parts[1] : undefined
  if (payload === undefined || payload.length === 0) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(decodeBase64Url(payload)) as Record<string, unknown>
  } catch {
    return undefined
  }
  const auth = parsed[AUTH_CLAIM_NAMESPACE]
  const authClaims = typeof auth === 'object' && auth !== null
    ? auth as Record<string, unknown>
    : {}
  const exp = parsed.exp
  const email = parsed.email
  const accountId = authClaims.chatgpt_account_id
  const planType = authClaims.chatgpt_plan_type
  return {
    ...typeof exp === 'number' ? { exp } : {},
    ...typeof email === 'string' ? { email } : {},
    ...typeof accountId === 'string' ? { accountId } : {},
    ...typeof planType === 'string' ? { planType } : {},
    isFedramp: authClaims.chatgpt_account_is_fedramp === true,
  }
}

/**
 * Resolve the account id to send as `ChatGPT-Account-ID`.
 *
 * Prefers the stored value and falls back to the `id_token` claim, because the
 * stored field is legitimately null for personal accounts.
 * @param tokens - the stored tokens.
 * @returns the account id, or `undefined` when neither source has one.
 */
export function resolveAccountId(tokens: CodexTokens): string | undefined {
  const stored = tokens.account_id
  if (typeof stored === 'string' && stored.length > 0) return stored
  return readJwtClaims(tokens.id_token)?.accountId
}

/** Whether this account must be routed through the FedRAMP edge. */
export function isFedrampAccount(tokens: CodexTokens): boolean {
  return readJwtClaims(tokens.id_token)?.isFedramp === true
}

/** Refresh this long before the access token actually expires. */
export const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1_000

/** Fallback staleness bound, used only when `exp` cannot be read. */
export const LAST_REFRESH_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000

/**
 * Whether the access token should be refreshed before the next request.
 *
 * Primary signal is the token's own `exp`, with a five-minute margin so a request
 * cannot expire in flight. The `last_refresh` age is only a fallback for a token
 * whose `exp` is unreadable — matching how the Codex CLI decides.
 * @param file - the credential file.
 * @param now - current time in epoch milliseconds; injectable for tests.
 * @returns true when a refresh is due.
 */
export function shouldRefresh(file: CodexAuthFile, now = Date.now()): boolean {
  const tokens = file.tokens
  if (tokens === undefined || tokens === null) return false
  const exp = readJwtClaims(tokens.access_token)?.exp
  if (exp !== undefined) return exp * 1_000 <= now + ACCESS_TOKEN_REFRESH_WINDOW_MS
  const lastRefresh = file.last_refresh
  if (lastRefresh === undefined || lastRefresh === null) return false
  const at = Date.parse(lastRefresh)
  return Number.isFinite(at) && at < now - LAST_REFRESH_MAX_AGE_MS
}

/**
 * Require usable ChatGPT tokens, with a message that says how to get them.
 * @param file - the credential file, or `undefined` when absent.
 * @param location - the path checked, named in the diagnostic.
 * @returns the tokens.
 */
export function requireTokens(
  file: CodexAuthFile | undefined,
  location: string,
): CodexTokens {
  const tokens = file?.tokens
  if (tokens === undefined || tokens === null
    || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new AgentSdkError(
      `no Codex credentials at ${location}; run \`npm run provider:codex:login-device\` to sign in`,
      MISSING_CREDENTIAL_CODE,
    )
  }
  return tokens
}
