/**
 * One idle deadline for a stream loop that is re-armed on every chunk.
 *
 * @module ai-agent-sdk/core/stream/idle-timer
 */

/** Longest delay a timer honors; Node and browsers fire a longer one after about 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Fires `onIdle` once the timer has been armed for `timeoutMs` without being
 * re-armed or stopped. Both halves run once per streamed chunk, so neither touches
 * a timer: `arm` and `stop` only record state, and the single pending timer
 * re-checks the elapsed span when it fires. Delays are clamped to
 * {@link MAX_TIMER_MS}, so a huge or infinite timeout re-checks rarely instead of
 * spinning on 1 ms timers. `dispose` clears the timer so nothing outlives the loop.
 */
export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private armedAt = 0
  private armed = false
  private disposed = false

  /**
   * @param timeoutMs - idle span that fires `onIdle`.
   * @param onIdle - called at most once per idle span, never after `dispose`.
   * @param now - a monotonic clock in milliseconds (default `performance.now`).
   */
  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Start (or restart) the idle span. */
  arm(): void {
    if (this.disposed) return
    this.armed = true
    this.armedAt = this.now()
    this.timer ??= setTimeout(this.fire, clampDelay(this.timeoutMs))
  }

  /** Pause: no idle span is measured until the next `arm`. */
  stop(): void { this.armed = false }

  dispose(): void {
    this.disposed = true
    this.armed = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private readonly fire = (): void => {
    this.timer = undefined
    if (!this.armed || this.disposed) return
    const waited = this.now() - this.armedAt
    if (waited < this.timeoutMs) {
      this.timer = setTimeout(this.fire, clampDelay(this.timeoutMs - waited))
      return
    }
    this.armed = false
    this.onIdle()
  }
}

function clampDelay(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_TIMER_MS)
}
