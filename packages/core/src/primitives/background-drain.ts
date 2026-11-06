/** Shared pacing for background observation export. Internal. */

/** Tuning shared by the runtime delivery scheduler and the observation bus. */
export const DRAIN_POLICY = Object.freeze({
  /** Batches one background step may export before it yields the serial chain. */
  batchesPerStep: 4,
  /** First pause after a failure. Doubles per consecutive failure. */
  backoffMinMs: 250,
  backoffMaxMs: 30_000,
  /**
   * Consecutive failures after which an exporter counts as down. Before that its
   * background failures are tentative: its items stay queued and nothing is
   * reported, so a sink that is back within the first pauses loses nothing. From
   * then on its failures are recorded. Its pause ends with one probe attempt, so
   * a sink that stays down is not hammered.
   */
  backgroundAttempts: 3,
  /**
   * Share of the queue's event or byte capacity in use from which background
   * steps settle a down best-effort exporter's items as failed (without calling
   * it while it is paused), so a sink that stays down cannot fill the queue for
   * the others. Below it they stay queued for the exporter's next probe.
   */
  shedPressure: 0.5,
})

/** Exponent cap: the pause is already at its maximum long before this. */
const MAX_DOUBLINGS = 16

/**
 * Exponential pause after delivery failures. Runs on a monotonic clock, so a
 * wall-clock step cannot stretch or cut a pause.
 */
export class DrainBackoff {
  private consecutive = 0
  private resumeAt = 0

  /** @param now - a monotonic clock in milliseconds. */
  constructor(private readonly now: () => number) {}

  /** Background work waits until the current pause ends. */
  get paused(): boolean { return this.now() < this.resumeAt }

  /** Failures since the last full success. */
  get failures(): number { return this.consecutive }

  /** Monotonic time the current pause ends; `undefined` when not paused. */
  get resumesAt(): number | undefined { return this.paused ? this.resumeAt : undefined }

  /** A delivery failed: pause, twice as long as after the previous failure. */
  fail(): void {
    this.consecutive = Math.min(this.consecutive + 1, MAX_DOUBLINGS + 1)
    const pause = DRAIN_POLICY.backoffMinMs * 2 ** (this.consecutive - 1)
    this.resumeAt = this.now() + Math.min(DRAIN_POLICY.backoffMaxMs, pause)
  }

  /** A delivery fully succeeded: end any pause and reset the doubling. */
  succeed(): void {
    this.consecutive = 0
    this.resumeAt = 0
  }
}

/**
 * Pacing per exporter, so one exporter that keeps failing pauses only itself and
 * never holds back the others (see `DRAIN_POLICY.backgroundAttempts`). Any
 * delivery by the exporter, background or not, resets it.
 */
export class ExporterPacing<Key> {
  private readonly backoffs = new Map<Key, DrainBackoff>()

  /** @param now - a monotonic clock in milliseconds. */
  constructor(private readonly now: () => number) {}

  /** The exporter failed and has not delivered since. */
  failing(key: Key): boolean { return this.backoffs.has(key) }

  /** Background steps do not call the exporter until its pause ends. */
  paused(key: Key): boolean { return this.backoffs.get(key)?.paused === true }

  /** Monotonic time the earliest pause among `keys` that `hasWork` ends; `undefined` when none is paused. */
  earliestResume(keys: Iterable<Key>, hasWork: (key: Key) => boolean): number | undefined {
    let at: number | undefined
    for (const key of keys) {
      const resumes = this.backoffs.get(key)?.resumesAt
      if (resumes !== undefined && (at === undefined || resumes < at) && hasWork(key)) at = resumes
    }
    return at
  }

  /** Whether a background failure of `key` now would still be tentative. */
  tentative(key: Key): boolean {
    return (this.backoffs.get(key)?.failures ?? 0) < DRAIN_POLICY.backgroundAttempts - 1
  }

  /** The exporter counts as down: it has failed `backgroundAttempts` times in a row. */
  down(key: Key): boolean { return (this.backoffs.get(key)?.failures ?? 0) >= DRAIN_POLICY.backgroundAttempts }

  /** These exporters failed in one step or flush: pause each, longer per consecutive failure. */
  failed(keys: Iterable<Key>): void {
    for (const key of keys) {
      let backoff = this.backoffs.get(key)
      if (backoff === undefined) this.backoffs.set(key, backoff = new DrainBackoff(this.now))
      backoff.fail()
    }
  }

  /** The exporter delivered: no pause, and its next failure starts a new count. */
  delivered(key: Key): void { this.backoffs.delete(key) }
}

/** What a background step reports back. */
export interface DrainStepOutcome {
  /** Every exporter the step called delivered everything it was given. */
  readonly complete: boolean
  /**
   * An exporter failed and is now paused on its own. The step may be incomplete
   * without pausing the others: requests continue for the exporters still active.
   */
  readonly paced?: boolean
  /**
   * Something was delivered before the step was cut short (its deadline, or a
   * yield). That is progress, not a failure: the drain continues without backing off.
   */
  readonly progressed?: boolean
}

export interface BackgroundDrainRequest {
  /** Drain even when less than one batch is queued (e.g. a run just finished). */
  readonly force?: boolean
}

/** The queue owner's side of a {@link BackgroundDrain}. */
export interface BackgroundDrainHost<Targets> {
  /** Exporters exist and the owner still admits and delivers events. */
  canDrain(): boolean
  /**
   * Work worth one step for an exporter that is not paused: a full batch, or with
   * `force` anything not yet in flight.
   */
  hasBacklog(force: boolean): boolean
  /** The oldest queued work for one step (`batchesPerStep` batches); `undefined` when there is none. */
  stepTargets(): Targets | undefined
  /**
   * Export `targets` on the owner's serial flush chain as a background attempt,
   * stopping before the next batch once `yieldBeforeBatch` returns true.
   */
  flush(targets: Targets, yieldBeforeBatch: () => boolean): Promise<DrainStepOutcome>
  /** An explicit flush, checkpoint or shutdown is queued on the chain behind this step. */
  foregroundWaiting(): boolean
  /** Append a task to the owner's serial flush chain. */
  enqueue(task: () => Promise<void>): void
  /**
   * Monotonic time the earliest pause of an exporter with queued work ends, or
   * `undefined`. The drain wakes itself then, so work held back by a pause is
   * retried without waiting for the next capture.
   */
  resumeAt?(): number | undefined
}

/**
 * Coalesced background export shared by the observation bus and the runtime
 * delivery scheduler. Without it a long-lived owner holds every event until an
 * explicit flush, then evicts and finally rejects critical evidence once its
 * queue is full.
 *
 * Requests coalesce into one queued step that reads the queue when it runs (a
 * forced request upgrades an already-queued step). Failing exporters are paced
 * one by one by the owner ({@link ExporterPacing}); a step that is incomplete
 * for any other reason (e.g. a partial acknowledgment) pauses all requests with
 * backoff, so it cannot spin. A forced step keeps going until the backlog is
 * empty, a threshold step only while a full batch is waiting. A step yields the
 * chain between batches to a queued foreground flush, so their deadlines wait
 * for at most one batch in flight, and re-queues behind it without counting
 * that as a failure.
 */
export class BackgroundDrain<Targets> {
  private queued = false
  private force = false
  private stopped = false
  private wakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly backoff: DrainBackoff

  /** @param now - a monotonic clock in milliseconds. */
  constructor(private readonly host: BackgroundDrainHost<Targets>, private readonly now: () => number) {
    this.backoff = new DrainBackoff(now)
  }

  /** Synchronous and non-throwing: safe to call from capture. */
  request(request: BackgroundDrainRequest = {}): void {
    const force = request.force === true
    if (this.queued) {
      if (force) this.force = true
      return
    }
    if (this.stopped || !this.host.canDrain()) return
    if (this.backoff.paused || !this.host.hasBacklog(force)) {
      this.wake()
      return
    }
    this.queued = true
    this.force = force
    this.host.enqueue(() => this.step())
  }

  private async step(): Promise<void> {
    const force = this.force
    this.queued = false
    this.force = false
    if (!this.host.canDrain()) return
    const targets = this.host.stepTargets()
    if (targets === undefined) return
    let yielded = false
    let outcome: DrainStepOutcome | undefined
    try {
      outcome = await this.host.flush(targets, () => (yielded = this.host.foregroundWaiting()))
    } catch { outcome = undefined }
    if (yielded && outcome !== undefined) {
      // Queued again behind the waiting flush; not a delivery failure.
      this.request({ force })
      return
    }
    // Keep going while an active exporter has work: the failed ones are paused on their own.
    if (this.continues(outcome)) this.request({ force })
    else this.wake()
  }

  /** No more wake-ups: the owner is closing. */
  stop(): void {
    this.stopped = true
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer)
    this.wakeTimer = undefined
  }

  /**
   * Work is held back only by a pause: drain again once the earliest pause ends
   * (one probe per pause), instead of waiting for the next capture. The timer does
   * not keep a Node process alive.
   */
  private wake(): void {
    if (this.wakeTimer !== undefined || this.stopped) return
    const at = earliest(this.backoff.resumesAt, this.host.resumeAt?.())
    if (at === undefined) return
    const delay = Math.min(Math.max(Math.ceil(at - this.now()) + 1, 1), DRAIN_POLICY.backoffMaxMs + 1)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined
      this.request({ force: true })
    }, delay)
    ;(this.wakeTimer as { unref?: () => void }).unref?.()
  }

  private continues(outcome: DrainStepOutcome | undefined): boolean {
    if (outcome?.complete === true) {
      this.backoff.succeed()
      return true
    }
    if (outcome?.paced === true) return true
    // Only a delivery counts, so a step that can never deliver (e.g. a zero-length deadline) cannot spin.
    if (outcome?.progressed === true) {
      this.backoff.succeed()
      return true
    }
    if (!this.backoff.paused) this.backoff.fail()
    return false
  }
}

function earliest(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  return right === undefined ? left : Math.min(left, right)
}
