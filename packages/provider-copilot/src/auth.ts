/**
 * The Universal half of `Copilot_Auth`: the in-memory store doubles, the
 * credential snapshot an operation carries, the one function that turns "no
 * credential" into an actionable error, and the pure predicate that decides
 * whether a token exchange is due.
 *
 * Storage is injected. Paths, the filesystem, and the environment belong to the
 * Node auth package, never this Universal one (Requirement 6.1).
 *
 * ## Two tiers, one of which lives here
 *
 * The long-lived `GitHub_User_Token` is what a store persists; the short-lived
 * `Copilot_Api_Token` obtained from it never reaches a store and lives only in
 * the process cache (Requirements 3.1, 3.3). Exchanging does not consume the
 * long-lived token, so the persisted value is left exactly as it was
 * (Requirement 3.4) — this module has no write path at all for that reason.
 *
 * @module ai-agent-sdk/providers/copilot/auth
 */

import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialStore } from '@alvin0/ai-agent-sdk-core/provider'
import { COPILOT_ERROR_CODES } from './errors.ts'
import type {
  CopilotAuthFile,
  CopilotAuthStore,
  CopilotCredentialStore,
  CopilotGitHubToken,
} from './common/store-types.ts'

export type {
  CopilotAccountIdentity,
  CopilotAuthFile,
  CopilotAuthStore,
  CopilotCredentialStore,
  CopilotGitHubToken,
} from './common/store-types.ts'

/**
 * The command that produces a credential, named in every message that tells a
 * caller how to fix a credential problem.
 *
 * Exported so the token-exchange path names the SAME command: a 401 and a 403
 * there both end in "sign in again", and two copies of that string are two
 * strings that can drift apart.
 */
export const COPILOT_LOGIN_COMMAND = 'npm run provider:copilot:login-device'

/**
 * An in-memory {@link CopilotAuthStore} — the read/write variant (Requirement 6.4).
 *
 * The read/write variant exists for symmetry with Codex; normal runtime
 * composition uses {@link memoryCopilotCredentialStore}, the compare-and-swap
 * variant.
 * @param initial - the file the store starts with, or nothing for an empty store.
 * @returns a store backed by a single mutable slot.
 */
export function memoryCopilotAuthStore(initial?: CopilotAuthFile): CopilotAuthStore {
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

/**
 * An in-memory compare-and-swap store, for deterministic runtime and tests
 * (Requirements 6.2, 6.4).
 *
 * Values are `structuredClone`d in BOTH directions, which is the point of this
 * double: a caller that mutates the object it wrote, or the object it read, must
 * not be able to change what the store holds. Without the clone a test could pass
 * for the wrong reason — the store and the caller sharing one object rather than
 * the store having committed anything.
 *
 * A commit whose `expectedRevision` disagrees with the current revision raises
 * {@link COPILOT_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT} (Requirement 6.3), the
 * Copilot-owned code, so exactly one of two concurrent commits wins and the loser
 * can tell why it lost.
 * @param initial - the file the store starts with, or nothing for an empty store.
 * @returns a compare-and-swap store over a single mutable slot.
 */
export function memoryCopilotCredentialStore(initial?: CopilotAuthFile): CopilotCredentialStore {
  let current = initial === undefined ? undefined : structuredClone(initial)
  let revision = 0
  return defineCredentialStore<CopilotAuthFile>({
    id: 'copilot-memory-credentials',
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
          'Copilot credential revision changed before commit',
          COPILOT_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT,
        )
      }
      current = structuredClone(input.value)
      revision++
      return { revision: String(revision) }
    },
  })
}

/**
 * One read of the credential store, carried through a single operation.
 *
 * `revision` travels with `file` rather than being re-read later, because the
 * token cache keys on the pair: a file that changed under us has a different
 * revision even when the token value happens to be identical.
 */
export interface CopilotCredentialSnapshot {
  readonly file: CopilotAuthFile
  /** The revision at read time, or `null` for a store with no revisions. */
  readonly revision: string | null
  /** The store's human-readable location, named in diagnostics. */
  readonly label: string
}

/**
 * Require a usable `GitHub_User_Token`, with a message that says how to get one.
 *
 * Three shapes of "there is no credential" — an empty store, a file with no
 * `github` field, and a `github.token` that is the empty string — collapse into
 * the SAME code, because to the person reading the error they are one problem
 * with one fix. That code is the SDK's own {@link MISSING_CREDENTIAL_CODE} rather
 * than a Copilot-specific one, so a consumer does not have to write a second
 * branch for a situation it already handles, and the message carries the command
 * to run `Copilot_Login_Cli` (Requirement 13.4).
 *
 * The token value is never interpolated into the message; only the store's label
 * is (Requirement 13.7).
 * @param file - the credential file, or `undefined` when the store was empty.
 * @param label - the store location named in the diagnostic.
 * @returns the long-lived GitHub token.
 */
export function requireGitHubToken(
  file: CopilotAuthFile | undefined,
  label: string,
): CopilotGitHubToken {
  const github = file?.github
  if (github === undefined || github === null
    || typeof github.token !== 'string' || github.token.length === 0) {
    throw new AgentSdkError(
      `no GitHub Copilot credentials at ${label}; run \`${COPILOT_LOGIN_COMMAND}\` to sign in`,
      MISSING_CREDENTIAL_CODE,
    )
  }
  return github
}

/** Exchange this long before the `Copilot_Api_Token` actually expires. */
export const COPILOT_TOKEN_EXCHANGE_MARGIN_MS = 5 * 60 * 1_000

/**
 * The part of a `Copilot_Api_Token` that {@link shouldExchange} reads.
 *
 * Declared here rather than imported so this module owns no dependency on the
 * exchange module: expiry arithmetic is the whole of what the decision needs, and
 * `CopilotApiToken` — which carries the token value and the declared endpoint
 * besides — satisfies this shape structurally, so `shouldExchange` accepts one
 * with no conversion and there is only ever one declaration of the full type.
 */
export interface CopilotTokenExpiry {
  /** Expiry instant in epoch MILLISECONDS, derived from the endpoint's `expires_at`. */
  readonly expiresAtMs: number
  /** The endpoint's `refresh_in` hint, in seconds, when it sent one. Advisory. */
  readonly refreshInSeconds?: number
}

/**
 * Whether a token exchange has to happen before the next request.
 *
 * A pure function of three values that reads no global clock, so a property test
 * can place `now` at every boundary without a fake timer (Requirements 5.2, 5.3).
 * `undefined` — no token yet — is always `true`.
 *
 * `expires_at` is the authority and `refresh_in` is advisory: the hint may only
 * SHORTEN the refresh moment, never lengthen it. The endpoint is allowed to ask
 * for an earlier exchange; it is not allowed to ask this SDK to hold a token past
 * the expiry it announced itself.
 *
 * There is deliberately no fallback branch. `shouldRefresh` in
 * `provider-codex/src/auth.ts` decodes a JWT for `exp` and falls back to a
 * `last_refresh` age when it cannot; a `Copilot_Api_Token` is not a JWT this SDK
 * has any business reading, and the expiry is stated outright in the exchange
 * response body. With no second source, a fallback would have to invent a
 * lifetime, and an invented lifetime violates the no-inference principle.
 *
 * Because the decision is made BEFORE dispatch, a 401 from the Copilot base URL
 * always means the credential is genuinely dead rather than "the token expired
 * mid-flight" — which is what lets auth failures stay non-retryable
 * (Requirement 5.8).
 * @param api - the cached token, or `undefined` when there is none.
 * @param now - current time in epoch milliseconds.
 * @param marginMs - exchange this long before expiry.
 * @returns true when an exchange is due.
 */
export function shouldExchange(
  api: CopilotTokenExpiry | undefined,
  now: number,
  marginMs = COPILOT_TOKEN_EXCHANGE_MARGIN_MS,
): boolean {
  if (api === undefined) return true
  const advisory = api.refreshInSeconds === undefined
    ? Number.POSITIVE_INFINITY
    : api.expiresAtMs - api.refreshInSeconds * 1_000
  return Math.min(api.expiresAtMs - marginMs, advisory) <= now
}
