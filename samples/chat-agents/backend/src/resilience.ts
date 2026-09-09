/**
 * What the sample does when a model call fails or stalls.
 *
 * The SDK deliberately ships neither policy: `runTurn` asks `hooks.onRequestError`
 * whether to retry and fails when nobody answers, and it caps a model stream at
 * ten minutes unless a host says otherwise. Both are the right defaults for a
 * library and the wrong ones for a chat window — an unanswered hook turns a
 * blip into a dead run, and ten silent minutes are indistinguishable from a
 * hang. This module supplies the host half.
 *
 * Two rules shape the policy:
 *
 * 1. **Only transient failures are retried.** A rate limit or a dropped socket
 *    is worth another attempt; a bad API key or an over-long request will fail
 *    identically every time, and retrying it just spends the user's minutes and
 *    tokens on the same answer.
 * 2. **A retry is visible.** A silent retry is how a stalled run gets mistaken
 *    for a working one, so every attempt is reported to the transcript.
 */

import type { ModelFailure } from '@alvin0/ai-agent-sdk-core'
import type { TurnHooks } from '@alvin0/ai-agent-sdk-core/agent'

/**
 * Cap on one model stream.
 *
 * A HARD deadline for the whole stream, not an idle timer: the SDK arms it once
 * before the request and never resets it on a chunk. So it has to exceed the
 * longest legitimate single generation, not the longest gap inside one.
 *
 * This was 90 seconds, on the reasoning that no healthy answer here takes
 * longer. That was wrong twice over. A reasoning model at medium effort
 * routinely streams a tool-heavy turn for more than that, and once subagents
 * began running concurrently several streams shared one provider at once. The
 * cap was killing healthy work — and then retrying it into the same wall.
 *
 * Five minutes still catches a dead connection well before the SDK's ten-minute
 * ceiling would, and the run now reports what it is waiting on the whole time,
 * so a slow stream no longer has to look like a hung app.
 */
export const MODEL_TIMEOUT_MS = 300_000

/** Total attempts for one model call, the first one included. */
export const MAX_MODEL_ATTEMPTS = 3

/** Longest a backoff will wait, however far the provider asks us to back off. */
const MAX_BACKOFF_MS = 15_000

/**
 * Failures worth another attempt.
 *
 * Everything absent is permanent for this request: `AUTH` needs a new key,
 * `INVALID_REQUEST` and `MODEL_REQUEST_TOO_LARGE` need a different request,
 * `ABORTED` is the user's own doing, and `UNKNOWN` is unclassified — retrying
 * a failure nobody could name is how a run spins on a permanent error.
 *
 * `MODEL_TIMEOUT` is absent deliberately, and it used to be here. That code is
 * our OWN whole-stream deadline expiring, so work that needed longer than the
 * budget needs longer than it on every attempt too: retrying spends a full
 * generation to reach the same wall, three times over, and fails anyway. The
 * provider's own `TIMEOUT` stays — that one is a transport failure a second
 * attempt can genuinely get past.
 */
const RETRYABLE = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED',
])

/**
 * Whether a failure is worth retrying.
 * @param failure - The provider or transport failure.
 * @returns True for a transient failure.
 */
export function isTransient(failure: ModelFailure): boolean {
  if (RETRYABLE.has(failure.code)) return true
  // A provider that returns 429 or 5xx under a code this sample does not know
  // is still telling us to come back later.
  const status = failure.status
  return status !== undefined && (status === 408 || status === 429 || status >= 500)
}

/**
 * How long to wait before attempt `attempt`.
 * @param attempt - The attempt about to be made, counting the first as 1.
 * @param failure - The failure that prompted the retry.
 * @returns Milliseconds to sleep.
 */
export function backoffMs(attempt: number, failure: ModelFailure): number {
  // The provider knows its own limits better than any local guess; a
  // Retry-After it sent is honoured up to the ceiling.
  const requested = failure.providerRetryAfterMs
  if (requested !== undefined) return Math.min(requested, MAX_BACKOFF_MS)
  const exponential = 1_000 * 2 ** Math.max(0, attempt - 2)
  // Jitter, so several conversations retrying at once do not resynchronise
  // into the same burst the rate limit was complaining about.
  return Math.min(Math.round(exponential * (1 + Math.random() * 0.25)), MAX_BACKOFF_MS)
}

/** Reported once per retry, so a waiting user is told what is happening. */
export interface RetryNotice {
  /** The attempt about to be made, counting the first as 1. */
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly failure: ModelFailure
}

/** Sleep that gives up when the run is cancelled. */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Build the turn hooks that retry a transient model failure.
 *
 * @param onRetry - Reports each attempt; this is what puts it on screen.
 * @returns Hooks to hand to `runAgent` or an agent session.
 */
export function retryHooks(onRetry: (notice: RetryNotice) => void): TurnHooks {
  // `runTurn` counts a retry as another step, so the loop's own step budget
  // bounds this in addition to MAX_MODEL_ATTEMPTS; attempts are tracked per
  // turn+step because a later failure is a fresh problem, not a continuation.
  const attempts = new Map<string, number>()
  return {
    onRequestError: async (context) => {
      const key = `${String(context.turn)}.${String(context.step)}`
      const attempt = (attempts.get(key) ?? 1) + 1
      if (!isTransient(context.failure) || attempt > MAX_MODEL_ATTEMPTS) return 'fail'
      attempts.set(key, attempt)
      const delayMs = backoffMs(attempt, context.failure)
      onRetry({ attempt, maxAttempts: MAX_MODEL_ATTEMPTS, delayMs, failure: context.failure })
      await sleep(delayMs, context.signal)
      // Cancelling during the backoff must not buy the model another attempt.
      return context.signal.aborted ? 'fail' : 'retry'
    },
  }
}

/**
 * How often a quiet run reports what it is still doing.
 *
 * This is a progress report, NOT a stall alarm, and the difference is the whole
 * design. "No events" does not mean "stuck": a reasoning model thinks for a
 * long time before its first token, and `npm install` produces nothing at all
 * for minutes. Treating that silence as a fault produces a warning while the
 * run is visibly working — and an automatic abort would kill the install.
 *
 * Every operation a run can be inside is already bounded by the SDK: a model
 * round by {@link MODEL_TIMEOUT_MS}, and a tool call — `wait_agents` included,
 * since waiting on a member IS a tool call — by the loop's `maxToolDurationMs`.
 * So the gap this fills is not a missing timeout. It is that ten minutes inside
 * a legitimate bound looks exactly like a hang when the window says nothing.
 * The fix is to say what is happening, not to guess that something broke.
 */
export const PROGRESS_REPORT_MS = 20_000

/** Whether a quiet run should say something. */
export type IdleVerdict =
  | { readonly kind: 'quiet' }
  | { readonly kind: 'report'; readonly silentMs: number }

export interface IdleWatch {
  /** Record that the run produced something. */
  touch(at: number): void
  /**
   * Judge the silence since the last activity.
   * @param at - Now, in epoch milliseconds.
   * @param waitingOnUser - A prompt is parked; the run is waiting for a person.
   * @returns Whether to report progress.
   */
  check(at: number, waitingOnUser: boolean): IdleVerdict
}

/**
 * Watch a run for being quiet, so it can say what it is waiting on.
 *
 * Reports repeat while the silence lasts, because a five-minute install wants a
 * counter that keeps moving rather than one stale line. Silence while a
 * permission prompt or a question is parked is not reported at all: the run is
 * waiting on the user, and telling them nothing is happening while they decide
 * would be both untrue and irritating.
 * @param options - Reporting interval and the clock's start.
 * @returns The watch.
 */
export function createIdleWatch(options: {
  reportEveryMs?: number
  startedAt?: number
} = {}): IdleWatch {
  const reportEveryMs = options.reportEveryMs ?? PROGRESS_REPORT_MS
  let last = options.startedAt ?? Date.now()
  let reportedAt = 0
  return {
    touch(at) {
      last = at
      reportedAt = 0
    },
    check(at, waitingOnUser) {
      if (waitingOnUser) {
        last = at
        reportedAt = 0
        return { kind: 'quiet' }
      }
      const silentMs = at - last
      if (silentMs < reportEveryMs) return { kind: 'quiet' }
      // One report per interval, not one per heartbeat.
      if (silentMs - reportedAt < reportEveryMs) return { kind: 'quiet' }
      reportedAt = silentMs
      return { kind: 'report', silentMs }
    },
  }
}
