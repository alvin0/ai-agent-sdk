/** Shared pacing for background observation export. Internal. */

/** Tuning shared by the runtime delivery scheduler and the observation bus. */
export const DRAIN_POLICY = Object.freeze({
  /** Batches one background step may export before it yields the serial chain. */
  batchesPerStep: 4,
  /** First pause after a background step that did not fully deliver. Doubles per failure. */
  backoffMinMs: 250,
  backoffMaxMs: 30_000,
})

/** Exponent cap: the pause is already at its maximum long before this. */
const MAX_DOUBLINGS = 16

/**
 * Exponential pause for background drains after delivery failures. Runs on a
 * monotonic clock, so a wall-clock step cannot stretch or cut a pause.
 */
export class DrainBackoff {
  private failures = 0
  private resumeAt = 0

  /** @param now - a monotonic clock in milliseconds. */
  constructor(private readonly now: () => number) {}

  /** Background drains wait until the current pause ends. */
  get paused(): boolean { return this.now() < this.resumeAt }

  /** A delivery failed: pause, twice as long as after the previous failure. */
  fail(): void {
    this.failures = Math.min(this.failures + 1, MAX_DOUBLINGS + 1)
    const pause = DRAIN_POLICY.backoffMinMs * 2 ** (this.failures - 1)
    this.resumeAt = this.now() + Math.min(DRAIN_POLICY.backoffMaxMs, pause)
  }

  /** A delivery fully succeeded: end any pause and reset the doubling. */
  succeed(): void {
    this.failures = 0
    this.resumeAt = 0
  }
}
