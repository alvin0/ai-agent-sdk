/**
 * A request-error hook that retries transient model failures with backoff.
 *
 * The loop's own `onRequestError` is a bare yes/no; every application that
 * wanted bounded, backed-off retries rebuilt the same counting, usually by
 * inferring successes from history. The loop now reports the outage itself
 * (`consecutiveFailures`, `retries`), so the limits here are exact: a budget
 * per outage that a successful request restores, a cap on the whole turn so a
 * flapping provider cannot hold it forever, the provider's `retry-after` when
 * it is worth waiting for, and an optional deadline no wait may cross.
 *
 * @module ai-agent-sdk/core/agent/loop/request-retry
 */

import {
  backoffDelayMs,
  isRetryable,
  MAX_TIMER_DELAY_MS,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
} from '../../contract/retry-policy.ts'
import type { RequestErrorContext } from './events.ts'

/** How `requestRetryHook` decides and waits. */
export interface RequestRetryOptions {
  /**
   * Which failure codes retry, how many retries one outage may use
   * (`maxRetries`), and the backoff between them. A provider `retry-after` is
   * a floor under the backoff, never a replacement for it: an overloaded
   * provider answering `retry-after: 1` must not burn every retry in seconds.
   * One above `backoff.maxDelayMs` fails the request rather than retrying
   * early (an `always` policy waits its own backoff instead). Even an
   * `always` policy never retries what the loop itself decided
   * (`STEP_REJECTED`, `CHECKPOINT_FAILED`, `INVALID_TOOL_CALL`): repeating
   * the request cannot change those. Defaults to the SDK's normal policy.
   */
  readonly policy?: RetryPolicyConfig | ResolvedRetryPolicy
  /**
   * Retries the turn may spend across all its outages. Defaults to three
   * outages' worth of a normal policy's `maxRetries`, and is unbounded under
   * an `always` policy.
   */
  readonly maxRetriesPerTurn?: number
  /** Epoch milliseconds no wait may end past; such a retry fails instead. */
  readonly deadlineAt?: number | (() => number)
  /** Jitter sample in `[0, 1)`; injectable so tests can be deterministic. */
  readonly random?: () => number
  /** Waits out one delay, settling early when the signal aborts. Injectable for tests. */
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>
}

const OUTAGES_PER_TURN = 3
/** Failures the loop decided itself; no provider retry can change them. */
const LOOP_DECISIONS: ReadonlySet<string> = new Set(['STEP_REJECTED', 'CHECKPOINT_FAILED', 'INVALID_TOOL_CALL'])

/**
 * Build an `onRequestError` hook from a retry policy.
 * @param options - policy, limits, and injectable clock helpers.
 * @returns a hook answering `'retry'` after waiting, or `'fail'`.
 */
export function requestRetryHook(
  options: RequestRetryOptions = {},
): (context: RequestErrorContext) => Promise<'retry' | 'fail'> {
  const policy = isResolved(options.policy)
    ? options.policy
    : resolveRetryPolicy(options.policy, 'requestRetryHook.policy')
  const maxRetriesPerTurn = options.maxRetriesPerTurn
    ?? (policy.mode === 'normal' ? policy.maxRetries * OUTAGES_PER_TURN : Infinity)
  if (maxRetriesPerTurn !== Infinity && (!Number.isSafeInteger(maxRetriesPerTurn) || maxRetriesPerTurn < 0)) {
    throw new Error('requestRetryHook.maxRetriesPerTurn must be a non-negative safe integer')
  }
  const random = options.random ?? Math.random
  const wait = options.wait ?? sleep

  return async (context) => {
    const { failure, signal } = context
    if (signal.aborted) return 'fail'
    // Retries this outage has already used; the failure at hand is the next.
    const used = Math.max(0, context.consecutiveFailures - 1)
    if (context.retries >= maxRetriesPerTurn || LOOP_DECISIONS.has(failure.code)
      || !isRetryable(policy, failure.code, used)) return 'fail'
    const delayMs = delayFor(policy, failure.providerRetryAfterMs, used + 1, random)
    if (delayMs === undefined) return 'fail'
    const deadlineAt = typeof options.deadlineAt === 'function' ? options.deadlineAt() : options.deadlineAt
    if (deadlineAt !== undefined && Date.now() + delayMs >= deadlineAt) return 'fail'
    await wait(delayMs, signal)
    return signal.aborted ? 'fail' : 'retry'
  }
}

/**
 * The backoff for this retry, raised to the provider's `retry-after` when it
 * asks for longer; undefined when a bounded policy will not wait that long.
 */
function delayFor(policy: ResolvedRetryPolicy, retryAfterMs: number | undefined, attempt: number,
  random: () => number): number | undefined {
  const backoff = backoffDelayMs(policy, attempt, random)
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return backoff
  if (retryAfterMs > policy.maxDelayMs) return policy.mode === 'always' ? backoff : undefined
  return Math.max(backoff, retryAfterMs)
}

function isResolved(policy: RequestRetryOptions['policy']): policy is ResolvedRetryPolicy {
  return policy !== undefined && 'initialDelayMs' in policy
}

/** Resolves after `delayMs`, or as soon as the signal aborts. */
function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, Math.min(delayMs, MAX_TIMER_DELAY_MS))
    // A backoff must not keep a host process alive on its own.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    signal.addEventListener('abort', done, { once: true })
  })
}
