import { type ModelInvocationContext } from '@alvin0/ai-agent-sdk-core'
import type { CredentialOperationOptions } from '@alvin0/ai-agent-sdk-core/provider'
import { type CopilotEditorHeaders } from './common/identity.ts'
import { type CopilotCredentialSnapshot } from './auth.ts'
import { type CopilotHttpOptions } from './common/http.ts'

/** GitHub's API base, where the token-exchange surface lives. */
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com'

/** Path of the token-exchange surface. */
export const COPILOT_TOKEN_EXCHANGE_PATH = '/copilot_internal/v2/token'

/** Provider name recorded on the credential-operation observation by default. */
export const COPILOT_PROVIDER_ID = 'copilot'

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
