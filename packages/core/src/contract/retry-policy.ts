/**
 * Retry policy as PURE DATA plus validation. Nothing here executes a retry.
 *
 * The separation is deliberate and is the load-bearing idea: an adapter's job is
 * to assign a stable `code` at the wire boundary, and the policy's job is to
 * decide which codes are eligible. Adapters never decide retry. That is what
 * lets a caller widen or narrow retry behaviour per route without touching  Eor
 * even understanding  Eany provider's error mapping.
 *
 * @module ai-agent-sdk/core/contract/retry-policy
 */

import { EMPTY_RESPONSE_CODE } from '../errors/agent-sdk-error.ts'
import { MODEL_ERROR_CODES } from '../errors/model-error.ts'

/**
 * Largest delay a timer can hold (`2**31 - 1` ms, ~24.9 days).
 *
 * Beyond this, `setTimeout` overflows to a 1 ms delay  Ea scheduled retry would
 * fire immediately instead of much later, which is the opposite of the intent.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1

/**
 * Codes eligible for retry by default.
 *
 * The exclusions are the interesting part. `AUTH`, `INVALID_REQUEST`, `QUOTA`,
 * `INVALID_CREDENTIAL`, and `CONTEXT_WINDOW_EXCEEDED` are absent because they
 * fail IDENTICALLY on every attempt  Eretrying them only burns latency and, for
 * quota, money. `EMPTY_RESPONSE` is present for the opposite reason: nothing
 * durable was produced, so repeating the call is safe and usually works.
 */
const DEFAULT_RETRYABLE_CODES: readonly string[] = Object.freeze([
  EMPTY_RESPONSE_CODE,
  MODEL_ERROR_CODES.RATE_LIMIT,
  MODEL_ERROR_CODES.SERVER,
  MODEL_ERROR_CODES.TIMEOUT,
  MODEL_ERROR_CODES.TRANSPORT,
])

/** Bounded exponential backoff with symmetric jitter around each local delay. */
export interface BackoffConfig {
  /** First local backoff delay in milliseconds (default 500). */
  initialDelayMs?: number
  /** Ceiling on any locally scheduled or accepted provider delay (default 10000). */
  maxDelayMs?: number
  /** Symmetric random multiplier range around one (default 0.1). */
  jitterRatio?: number
}

/** Bounded transient retry behaviour for one route. */
export interface NormalRetryPolicyConfig {
  /** Retry only the configured transient failure codes. */
  mode: 'normal'
  /** Maximum retries AFTER the first attempt (default 5). */
  maxRetries?: number
  /** Failure codes eligible under this policy. */
  retryableCodes?: readonly string[]
  backoff?: BackoffConfig
}

/**
 * Unbounded retry for every failure on one route.
 *
 * For long-running unattended work where giving up is worse than waiting.
 * Bounded only by cancellation. The retry decorator therefore requires the
 * model request to carry an AbortSignal when this mode is selected.
 */
export interface AlwaysRetryPolicyConfig {
  mode: 'always'
  backoff?: BackoffConfig
}

/** Retry policy configuration for one provider route. */
export type RetryPolicyConfig = NormalRetryPolicyConfig | AlwaysRetryPolicyConfig

/** Fully resolved backoff shared by both modes. */
export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

/** Fully resolved bounded transient retry policy. */
export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal'
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
}

/** Fully resolved unbounded retry policy. */
export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always'
}

/** Immutable policy, captured when a route is registered. */
export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy

const NORMAL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'mode', 'maxRetries', 'retryableCodes', 'backoff',
])
// Layered configuration can retain normal-only fields after a mode switch, so
// `always` tolerates those inactive values while still rejecting typos.
const ALWAYS_POLICY_KEYS: ReadonlySet<string> = NORMAL_POLICY_KEYS
const BACKOFF_KEYS: ReadonlySet<string> = new Set(['initialDelayMs', 'maxDelayMs', 'jitterRatio'])

function validateKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
}

function resolveBackoff(config: BackoffConfig | undefined, path: string): ResolvedRetryBackoff {
  if (config !== undefined) validateKeys(config, BACKOFF_KEYS, path)
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO

  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(`${path}.jitterRatio must be between 0 and 1`)
  }
  return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio })
}

/**
 * Validate, default, and detach one retry policy.
 *
 * Everything returned is frozen, because a policy is captured at registration
 * and read on every failure; a mutable one could be edited between the decision
 * to retry and the wait itself.
 * @param config - optional configuration; omission selects the normal defaults.
 * @param path - diagnostic path naming the setting that owns the value.
 * @returns an immutable policy, safe to capture in registration state.
 */
export function resolveRetryPolicy(
  config: RetryPolicyConfig | undefined,
  path: string,
): ResolvedRetryPolicy {
  if (config === undefined) {
    return Object.freeze({
      mode: 'normal' as const,
      maxRetries: DEFAULT_MAX_RETRIES,
      retryableCodes: DEFAULT_RETRYABLE_CODES,
      ...resolveBackoff(undefined, `${path}.backoff`),
    })
  }

  switch (config.mode) {
    case 'normal': {
      validateKeys(config, NORMAL_POLICY_KEYS, path)
      const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
      const retryableCodes = config.retryableCodes ?? DEFAULT_RETRYABLE_CODES
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
        throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
      }
      if (retryableCodes.length === 0) {
        // An empty list is almost certainly a mistake rather than "never retry";
        // `maxRetries: 0` says that unambiguously.
        throw new Error(`${path}.retryableCodes must not be empty`)
      }
      if (retryableCodes.some(code => typeof code !== 'string' || code.length === 0)) {
        throw new Error(`${path}.retryableCodes must contain only non-empty strings`)
      }
      if (new Set(retryableCodes).size !== retryableCodes.length) {
        throw new Error(`${path}.retryableCodes must not contain duplicates`)
      }
      return Object.freeze({
        mode: 'normal' as const,
        maxRetries,
        retryableCodes: Object.freeze([...retryableCodes]),
        ...resolveBackoff(config.backoff, `${path}.backoff`),
      })
    }
    case 'always':
      validateKeys(config, ALWAYS_POLICY_KEYS, path)
      return Object.freeze({
        mode: 'always' as const,
        ...resolveBackoff(config.backoff, `${path}.backoff`),
      })
    default:
      throw new Error(`${path}.mode must be "normal" or "always"`)
  }
}

/**
 * The delay before one retry attempt: bounded exponential growth with symmetric
 * jitter.
 *
 * Jitter matters more than it looks. Without it, every client that failed
 * against the same overloaded provider retries at the same instant, and the
 * synchronized wave reproduces the outage it was meant to ride out.
 * @param policy - the resolved policy supplying growth and bounds.
 * @param attempt - 1-based retry number.
 * @param random - sample in `[0, 1)`; injectable so tests can be deterministic.
 * @returns the delay in milliseconds, never above `policy.maxDelayMs`.
 */
export function backoffDelayMs(
  policy: ResolvedRetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  // Clamp the exponent before shifting: 2 ** 100000 is Infinity, and
  // Infinity * jitter would defeat the Math.min bound below.
  const exponent = Math.min(Math.max(attempt - 1, 0), 1024)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * random()
  return Math.min(exponential * jitter, policy.maxDelayMs)
}

/**
 * Whether a policy admits one more attempt for a given failure code.
 * @param policy - the resolved policy.
 * @param code - the failure code assigned by the adapter.
 * @param attemptsSoFar - retries already performed, excluding the first attempt.
 * @returns true when another retry is permitted.
 */
export function isRetryable(
  policy: ResolvedRetryPolicy,
  code: string,
  attemptsSoFar: number,
): boolean {
  if (policy.mode === 'always') return true
  return policy.retryableCodes.includes(code) && attemptsSoFar < policy.maxRetries
}
