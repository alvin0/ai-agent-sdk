import { describe, expect, it } from 'vitest'
import {
  MAX_TIMER_DELAY_MS,
  backoffDelayMs,
  isRetryable,
  resolveRetryPolicy,
} from '../../src/core/contract/retry-policy.ts'

describe('resolveRetryPolicy', () => {
  it('defaults to a bounded policy whose allow-list excludes permanent failures', () => {
    const policy = resolveRetryPolicy(undefined, 'test')
    if (policy.mode !== 'normal') throw new Error('expected the normal mode default')
    expect(policy.maxRetries).toBe(5)
    // These fail identically on every attempt; retrying only burns latency and,
    // for quota, money.
    for (const code of ['AUTH', 'INVALID_REQUEST', 'QUOTA', 'CONTEXT_WINDOW_EXCEEDED']) {
      expect(policy.retryableCodes).not.toContain(code)
    }
    // Nothing durable was produced, so repeating is safe.
    expect(policy.retryableCodes).toContain('EMPTY_RESPONSE')
  })

  it('freezes the result so a captured policy cannot be edited mid-flight', () => {
    const policy = resolveRetryPolicy(undefined, 'test')
    expect(Object.isFrozen(policy)).toBe(true)
  })

  it('rejects an unknown key instead of silently ignoring a typo', () => {
    expect(() => resolveRetryPolicy(
      { mode: 'normal', maxRetires: 3 } as never,
      'test',
    )).toThrow(/unknown key "maxRetires"/)
  })

  it('rejects an empty allow-list, which is a mistake rather than "never retry"', () => {
    expect(() => resolveRetryPolicy(
      { mode: 'normal', retryableCodes: [] },
      'test',
    )).toThrow(/must not be empty/)
    // `maxRetries: 0` is how you actually say "never retry".
    expect(resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test')).toBeDefined()
  })

  it('rejects a delay a timer cannot hold', () => {
    expect(() => resolveRetryPolicy(
      { mode: 'normal', backoff: { maxDelayMs: MAX_TIMER_DELAY_MS + 1 } },
      'test',
    )).toThrow(/no greater than/)
  })

  it('rejects an initial delay above the ceiling', () => {
    expect(() => resolveRetryPolicy(
      { mode: 'normal', backoff: { initialDelayMs: 5_000, maxDelayMs: 1_000 } },
      'test',
    )).toThrow(/less than or equal to maxDelayMs/)
  })
})

describe('backoffDelayMs', () => {
  const policy = resolveRetryPolicy(
    { mode: 'normal', backoff: { initialDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 } },
    'test',
  )

  it('grows exponentially and then clamps at the ceiling', () => {
    expect(backoffDelayMs(policy, 1, () => 0.5)).toBe(100)
    expect(backoffDelayMs(policy, 2, () => 0.5)).toBe(200)
    expect(backoffDelayMs(policy, 3, () => 0.5)).toBe(400)
    expect(backoffDelayMs(policy, 20, () => 0.5)).toBe(1_000)
  })

  it('stays bounded for an absurd attempt number', () => {
    // Without clamping the exponent, 2 ** huge is Infinity and Math.min would
    // propagate it instead of capping.
    expect(backoffDelayMs(policy, 1e9, () => 0.5)).toBe(1_000)
  })

  it('applies symmetric jitter within the configured ratio', () => {
    const jittered = resolveRetryPolicy(
      { mode: 'normal', backoff: { initialDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0.5 } },
      'test',
    )
    expect(backoffDelayMs(jittered, 1, () => 0)).toBe(50)
    expect(backoffDelayMs(jittered, 1, () => 1)).toBe(150)
  })
})

describe('isRetryable', () => {
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries: 2 }, 'test')

  it('honours both the allow-list and the attempt ceiling', () => {
    expect(isRetryable(policy, 'SERVER', 0)).toBe(true)
    expect(isRetryable(policy, 'SERVER', 2)).toBe(false)
    expect(isRetryable(policy, 'AUTH', 0)).toBe(false)
  })

  it('always retries under an unbounded policy', () => {
    const always = resolveRetryPolicy({ mode: 'always' }, 'test')
    expect(isRetryable(always, 'AUTH', 9_999)).toBe(true)
  })
})
