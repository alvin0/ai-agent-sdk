

/**
 * A wake-up the run generator can wait on and anyone else can ring.
 *
 * The run's own event stream is not the only thing that produces output: a team
 * member reports through a callback, and permission answers arrive on their own
 * HTTP request. Without this the generator would only ever wake for a LEAD
 * event, and a lead parked in `wait_agents` emits none — so a member's
 * permission prompt would never reach the browser, the member could never be
 * answered, and the lead would wait for it forever.
 *
 * Rings are remembered, so one that lands while nobody is waiting is not lost.
 */
export interface Doorbell {
  ring(): void
  wait(): Promise<void>
}

/** One reason the run generator woke up. */
export type RunStep<L> = { readonly lead: L } | { readonly wake: true }

/**
 * Yield a step for every lead event AND every ring of the doorbell.
 *
 * The `wake` steps are the whole point: they let the consumer flush what other
 * producers queued while the lead is blocked. Iterating the lead alone is what
 * deadlocked team runs — the lead waits inside `wait_agents` for a member, and
 * the member waits for a permission prompt that only a lead event would have
 * flushed.
 * @param lead - The agent-the-user-talks-to event iterator.
 * @param wake - Rung by member events and by answers arriving on other requests.
 * @returns Steps until the lead stream ends.
 */
export async function* runSteps<L>(
  lead: AsyncIterator<L>,
  wake: Doorbell,
): AsyncGenerator<RunStep<L>> {
  let next = lead.next()
  try {
    for (;;) {
      const step = await Promise.race([
        next.then(result => ({ lead: result })),
        wake.wait().then(() => ({ lead: undefined })),
      ])
      if (step.lead === undefined) {
        yield { wake: true }
        continue
      }
      if (step.lead.done === true) return
      yield { lead: step.lead.value }
      next = lead.next()
    }
  } finally {
    // The client disconnecting abandons this generator mid-loop; close the
    // lead rather than leaving it holding the run open.
    await lead.return?.()
  }
}

/**
 * Build a doorbell.
 * @returns The ring/wait pair.
 */
export function createDoorbell(): Doorbell {
  let rung = false
  let open: (() => void) | undefined
  return {
    ring() {
      const waiter = open
      open = undefined
      // Remember the ring ONLY when nobody heard it. Setting the flag as well
      // as waking a waiter would spend the same ring twice, waking the run a
      // second time for work that was already flushed.
      if (waiter === undefined) rung = true
      else waiter()
    },
    async wait() {
      if (rung) {
        rung = false
        return
      }
      await new Promise<void>((resolve) => { open = resolve })
    },
  }
}
