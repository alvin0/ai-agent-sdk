import type { CodexAuthStore, CodexCredentialStore } from './auth.ts'
import type { CodexOAuthOptions } from './oauth-types.ts'

/**
 * One rolling usage window of a Codex plan limit.
 *
 * Codex plans meter usage as a percentage of a rolling window rather than as a
 * token count, so `usedPercent` is the authoritative figure and the rest is derived
 * or optional.
 */
export interface CodexUsageWindow {
  /** Share of the window already used, as reported (0–100; may exceed 100 when over the limit). */
  readonly usedPercent: number
  /** `100 - usedPercent`, clamped to 0–100. */
  readonly remainingPercent: number
  /** Window length in seconds (for example 18,000 for five hours, 604,800 for a week). */
  readonly windowSeconds?: number
  /** Seconds until the window resets, as reported when the snapshot was taken. */
  readonly resetAfterSeconds?: number
  /** When the window resets, as an ISO-8601 timestamp. */
  readonly resetsAt?: string
}

/** One plan limit: a short `primary` window and a longer `secondary` window. */
export interface CodexRateLimit {
  /** Whether a new request is currently allowed under this limit. */
  readonly allowed?: boolean
  /** Whether this limit has been reached. */
  readonly limitReached?: boolean
  /** The shorter window (five hours on current plans). */
  readonly primary?: CodexUsageWindow
  /** The longer window (one week on current plans). */
  readonly secondary?: CodexUsageWindow
}

/** A separately metered limit, such as a model family with its own allowance. */
export interface CodexAdditionalRateLimit {
  readonly name: string
  readonly meteredName?: string
  readonly rateLimit?: CodexRateLimit
}

/** Purchased-credit state, which can extend usage past the plan limit. */
export interface CodexCredits {
  readonly hasCredits?: boolean
  readonly unlimited?: boolean
  /** Remaining credit balance, kept as the decimal string the service reports. */
  readonly balance?: string
  readonly overageLimitReached?: boolean
}

/** Whether one model can be used right now under the account's limits. */
export interface CodexModelAvailability {
  readonly available?: boolean
  /** When the model becomes available again, as an ISO-8601 timestamp. */
  readonly availableAt?: string
}

/**
 * A snapshot of the account's remaining Codex usage.
 *
 * Personal identifiers the service returns alongside (email, user and account
 * ids) are deliberately not carried, so a snapshot is safe to log or display.
 */
export interface CodexUsage {
  /** `usage-endpoint` from {@link getCodexUsage}; `response-headers` from a model response. */
  readonly source: 'usage-endpoint' | 'response-headers'
  /** When the snapshot was taken, as an ISO-8601 timestamp. */
  readonly observedAt: string
  readonly planType?: string
  /** The general Codex limit. */
  readonly rateLimit?: CodexRateLimit
  /** The code-review limit, when the plan meters it separately. */
  readonly codeReviewRateLimit?: CodexRateLimit
  readonly additionalRateLimits: readonly CodexAdditionalRateLimit[]
  readonly credits?: CodexCredits
  /** Per-model availability, keyed by model slug. Empty from response headers. */
  readonly models: Readonly<Record<string, CodexModelAvailability>>
  /** Which limit was reached, when one was. */
  readonly limitReachedType?: string
  /** Whether a workspace spend control has been reached. */
  readonly spendControlReached?: boolean
  /** Response headers only: the limit currently governing requests (for example `premium`). */
  readonly activeLimit?: string
}

/** Options for {@link getCodexUsage}. */
export interface GetCodexUsageOptions {
  /** Credentials, as given to the Codex adapter. Tokens are refreshed when due. */
  readonly authStore: CodexAuthStore | CodexCredentialStore
  /**
   * The Codex API base, as given to the adapter; defaults to `CODEX_BASE_URL`.
   * The usage endpoint is derived from it.
   */
  readonly baseUrl?: string
  /** Client identifier; defaults to `CODEX_ORIGINATOR`. */
  readonly originator?: string
  /** Issuer and client id overrides for token refresh. */
  readonly oauth?: CodexOAuthOptions
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
  /** Request deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number
  /** Maximum response bytes. Defaults to 256 KiB. */
  readonly maxBytes?: number
}
