import { describe, expect, it } from 'vitest'
import type { ModelFailure } from '@ai-agent-sdk/core'

const { backoffMs, createIdleWatch, isTransient, retryHooks, MAX_MODEL_ATTEMPTS } =
  await import('../../samples/chat-agents/backend/src/resilience.ts')

const failure = (patch: Partial<ModelFailure>): ModelFailure =>
  ({ message: 'boom', code: 'UNKNOWN', ...patch })

describe('retry classification', () => {
  it('retries transient failures and refuses permanent ones', () => {
    for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED']) {
      expect(isTransient(failure({ code }))).toBe(true)
    }
    // A bad key or an over-long request fails identically every time; retrying
    // only spends the user's minutes on the same answer.
    for (const code of ['AUTH', 'INVALID_REQUEST', 'MODEL_REQUEST_TOO_LARGE', 'ABORTED', 'UNKNOWN']) {
      expect(isTransient(failure({ code }))).toBe(false)
    }
  })

  it('does not retry its own whole-stream deadline', () => {
    // `MODEL_TIMEOUT` is this app's deadline expiring, not a blip. Work that
    // needed longer than the budget needs longer on every attempt, so retrying
    // spends a full generation to reach the same wall — three times, then fails.
    expect(isTransient(failure({ code: 'MODEL_TIMEOUT' }))).toBe(false)
    // The provider's own transport timeout is a different thing and still is.
    expect(isTransient(failure({ code: 'TIMEOUT' }))).toBe(true)
  })

  it('trusts an HTTP status the code did not classify', () => {
    expect(isTransient(failure({ code: 'ODD', status: 429 }))).toBe(true)
    expect(isTransient(failure({ code: 'ODD', status: 503 }))).toBe(true)
    expect(isTransient(failure({ code: 'ODD', status: 400 }))).toBe(false)
  })

  it('honours a provider Retry-After over its own guess', () => {
    expect(backoffMs(2, failure({ code: 'RATE_LIMIT', providerRetryAfterMs: 4_200 }))).toBe(4_200)
    // …but never sleeps longer than the ceiling, whatever the provider asks.
    expect(backoffMs(2, failure({ code: 'RATE_LIMIT', providerRetryAfterMs: 600_000 }))).toBe(15_000)
  })

  it('backs off further on each attempt', () => {
    const second = backoffMs(2, failure({ code: 'SERVER' }))
    const third = backoffMs(3, failure({ code: 'SERVER' }))
    expect(second).toBeGreaterThanOrEqual(1_000)
    expect(third).toBeGreaterThan(second)
  })
})

describe('retryHooks', () => {
  const context = (over: Partial<{ turn: number; step: number; failure: ModelFailure }> = {}) => ({
    turn: over.turn ?? 1,
    step: over.step ?? 1,
    failure: over.failure ?? failure({ code: 'SERVER' }),
    snapshot: {} as never,
    signal: new AbortController().signal,
    emit: async () => undefined,
  })

  it('retries a transient failure up to the cap, then fails', async () => {
    const seen: number[] = []
    const hooks = retryHooks(notice => seen.push(notice.attempt))
    const decisions: string[] = []
    for (let call = 0; call < 4; call += 1) {
      decisions.push(await hooks.onRequestError!(context() as never) as string)
    }
    // First failure → attempt 2, second → attempt 3, then the cap stops it.
    expect(decisions).toEqual(['retry', 'retry', 'fail', 'fail'])
    expect(seen).toEqual([2, 3])
    expect(seen.length).toBe(MAX_MODEL_ATTEMPTS - 1)
  })

  it('counts attempts per step, so a later failure starts fresh', async () => {
    const hooks = retryHooks(() => undefined)
    expect(await hooks.onRequestError!(context({ step: 1 }) as never)).toBe('retry')
    expect(await hooks.onRequestError!(context({ step: 1 }) as never)).toBe('retry')
    expect(await hooks.onRequestError!(context({ step: 1 }) as never)).toBe('fail')
    expect(await hooks.onRequestError!(context({ step: 2 }) as never)).toBe('retry')
  })

  it('does not retry a permanent failure at all', async () => {
    const seen: number[] = []
    const hooks = retryHooks(notice => seen.push(notice.attempt))
    expect(await hooks.onRequestError!(context({ failure: failure({ code: 'AUTH' }) }) as never)).toBe('fail')
    expect(seen).toEqual([])
  })

  it('gives up instead of sleeping when the run is cancelled', async () => {
    const hooks = retryHooks(() => undefined)
    const controller = new AbortController()
    const slow = failure({ code: 'RATE_LIMIT', providerRetryAfterMs: 10_000 })
    const pending = hooks.onRequestError!({ ...context({ failure: slow }), signal: controller.signal } as never)
    controller.abort()
    // The backoff must not outlive the run, and cancelling must not buy the
    // model another attempt.
    expect(await pending).toBe('fail')
  })
})

describe('idle watch', () => {
  const watch = () => createIdleWatch({ reportEveryMs: 1_000, startedAt: 0 })

  it('says nothing while the run is producing', () => {
    const idle = watch()
    expect(idle.check(900, false)).toEqual({ kind: 'quiet' })
    idle.touch(900)
    expect(idle.check(1_800, false)).toEqual({ kind: 'quiet' })
  })

  it('never reports a gap that has already ended', () => {
    // This is the bug the first version shipped: an event arriving after a long
    // quiet model round was judged BEFORE the activity was recorded, so the run
    // was accused of stalling at the exact moment it produced something. The
    // caller records activity first; from the watch's side, a touch must erase
    // the gap entirely rather than leave it pending.
    const idle = watch()
    idle.touch(5_000)
    expect(idle.check(5_000, false)).toEqual({ kind: 'quiet' })
    expect(idle.check(5_900, false)).toEqual({ kind: 'quiet' })
  })

  it('keeps reporting while the silence lasts, once per interval', () => {
    const idle = watch()
    expect(idle.check(1_100, false)).toEqual({ kind: 'report', silentMs: 1_100 })
    // A build that runs for minutes wants a counter that moves, but not one
    // report per heartbeat.
    expect(idle.check(1_500, false)).toEqual({ kind: 'quiet' })
    expect(idle.check(2_200, false)).toEqual({ kind: 'report', silentMs: 2_200 })
    expect(idle.check(2_900, false)).toEqual({ kind: 'quiet' })
    expect(idle.check(3_300, false)).toEqual({ kind: 'report', silentMs: 3_300 })
  })

  it('starts over once the run produces again', () => {
    const idle = watch()
    expect(idle.check(1_100, false)).toEqual({ kind: 'report', silentMs: 1_100 })
    idle.touch(1_200)
    expect(idle.check(1_900, false)).toEqual({ kind: 'quiet' })
    expect(idle.check(2_300, false)).toEqual({ kind: 'report', silentMs: 1_100 })
  })

  it('does not count time the run spends waiting on the user', () => {
    const idle = watch()
    // A permission prompt is open: the run is idle because a person has not
    // answered, which is not something to report at them.
    expect(idle.check(4_000, true)).toEqual({ kind: 'quiet' })
    expect(idle.check(8_000, true)).toEqual({ kind: 'quiet' })
    // The clock restarts from when they answered, not from the prompt.
    expect(idle.check(8_500, false)).toEqual({ kind: 'quiet' })
    expect(idle.check(9_100, false)).toEqual({ kind: 'report', silentMs: 1_100 })
  })
})
