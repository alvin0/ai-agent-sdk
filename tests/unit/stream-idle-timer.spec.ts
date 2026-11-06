/** The idle deadline shared by the agent loop and the HTTP provider transport. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdleTimer, MAX_TIMER_MS } from '../../packages/core/src/stream/idle-timer.ts'

afterEach(() => { vi.useRealTimers() })

describe('IdleTimer', () => {
  it('fires once after an idle span, measured from the last arm, without a timer per arm', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const timer = new IdleTimer(100, onIdle, () => Date.now())
    timer.arm()
    for (let step = 0; step < 50; step++) { vi.advanceTimersByTime(10); timer.arm() }
    expect(onIdle).not.toHaveBeenCalled()
    // One timer for the first arm plus one re-check per elapsed span, not one per arm.
    expect(setTimer.mock.calls.length).toBeLessThan(10)
    vi.advanceTimersByTime(100)
    expect(onIdle).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1_000)
    expect(onIdle).toHaveBeenCalledOnce()
    timer.dispose()
  })

  it('does not measure while stopped and never fires after dispose', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const timer = new IdleTimer(50, onIdle, () => Date.now())
    timer.arm()
    timer.stop()
    vi.advanceTimersByTime(200)
    expect(onIdle).not.toHaveBeenCalled()
    timer.arm()
    timer.dispose()
    timer.arm()
    vi.advanceTimersByTime(200)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('clamps a timeout beyond the timer range instead of spinning on 1 ms timers', () => {
    vi.useFakeTimers()
    const onIdle = vi.fn()
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    for (const timeout of [MAX_TIMER_MS + 1, Number.POSITIVE_INFINITY]) {
      const timer = new IdleTimer(timeout, onIdle, () => Date.now())
      timer.arm()
      vi.advanceTimersByTime(1_000)
      timer.dispose()
    }
    expect(setTimer.mock.calls.every(([, delay]) => delay === MAX_TIMER_MS)).toBe(true)
    expect(setTimer).toHaveBeenCalledTimes(2)
    expect(onIdle).not.toHaveBeenCalled()
  })
})
