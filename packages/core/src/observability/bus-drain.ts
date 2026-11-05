/** Coalesced background export for the observation bus. */
import { systemMonotonicNow } from '../platform/adapter.ts'
import { DRAIN_POLICY, DrainBackoff } from '../primitives/drain-backoff.ts'
import type { FlushOutcome } from './bus-types.ts'

/** Internal tuning, shared with the runtime delivery scheduler; capture never awaits any of it. */
export const BACKGROUND_DRAIN = DRAIN_POLICY

export interface BackgroundDrainHost {
  /** Exporters exist and the bus still admits events. */
  canDrain(): boolean
  /** At least one batch worth of events or bytes is queued. */
  hasBatchBacklog(): boolean
  /** Event ids of the oldest queued entries for one step (`batchesPerStep` batches). */
  stepTargets(): Set<string>
  /**
   * Export the given ids on the bus's serial flush chain, stopping before the next
   * batch once `yieldBeforeBatch` returns true.
   */
  flush(targetIds: ReadonlySet<string>, yieldBeforeBatch: () => boolean): Promise<FlushOutcome>
  /** An explicit flush or shutdown is queued on the chain behind this step. */
  foregroundWaiting(): boolean
  /** Append a task to the bus's serial flush chain. */
  enqueue(task: () => Promise<void>): void
}

/**
 * Without this a long-lived bus holds every event until an explicit flush, then
 * evicts and finally rejects critical evidence once the queue is full. Requests
 * coalesce into one queued step that reads the queue when it runs; a step that
 * does not fully deliver pauses further background requests with backoff. A step
 * yields the chain between batches to a queued flush or shutdown, so their
 * deadlines wait for at most one batch in flight.
 */
export class BackgroundDrain {
  private queued = false
  private readonly backoff: DrainBackoff

  /** @param now - a monotonic clock in milliseconds. */
  constructor(private readonly host: BackgroundDrainHost, now: () => number = systemMonotonicNow) {
    this.backoff = new DrainBackoff(now)
  }

  request(): void {
    if (this.queued || this.backoff.paused || !this.host.canDrain() || !this.host.hasBatchBacklog()) return
    this.queued = true
    this.host.enqueue(async () => {
      this.queued = false
      if (!this.host.canDrain()) return
      let outcome: FlushOutcome | undefined
      let yielded = false
      try {
        outcome = await this.host.flush(this.host.stepTargets(), () => (yielded = this.host.foregroundWaiting()))
      } catch { outcome = undefined }
      // Queued again behind the waiting flush; not a delivery failure.
      if (yielded && outcome !== undefined) this.request()
      else this.settle(outcome)
    })
  }

  private settle(outcome: FlushOutcome | undefined): void {
    if (outcome?.complete !== true) {
      this.backoff.fail()
      return
    }
    this.backoff.succeed()
    this.request()
  }
}
