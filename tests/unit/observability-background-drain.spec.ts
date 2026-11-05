/**
 * The observation bus's background drain: it yields the serial chain to an
 * explicit flush without counting that as a failure, and paces failures on the
 * monotonic clock it is given rather than wall time.
 */
import { describe, expect, it, vi } from 'vitest'
import { BackgroundDrain, type BackgroundDrainHost } from '../../packages/core/src/observability/bus-drain.ts'
import type { FlushOutcome } from '../../packages/core/src/observability/bus-types.ts'

function outcome(complete: boolean): FlushOutcome {
  return { complete, requiredComplete: complete, exportedEvents: 0, pendingEvents: complete ? 0 : 1, rejectedCritical: 0, timedOut: false }
}

function host(flush: BackgroundDrainHost['flush'], foreground = () => false) {
  let chain: Promise<void> = Promise.resolve()
  const value: BackgroundDrainHost & { settled: () => Promise<void> } = {
    canDrain: () => true,
    hasBatchBacklog: () => true,
    stepTargets: () => new Set(['id']),
    flush: vi.fn(flush),
    foregroundWaiting: foreground,
    enqueue: (task) => { chain = chain.then(task, task) },
    settled: async () => { for (let index = 0; index < 5; index++) await chain },
  }
  return value
}

describe('BackgroundDrain', () => {
  it('backs off on the injected monotonic clock and resumes when it has advanced', async () => {
    let now = 1_000
    let calls = 0
    const drainHost = host(async () => outcome(++calls > 1))
    const drain = new BackgroundDrain(drainHost, () => now)
    drain.request()
    await drainHost.settled()
    expect(drainHost.flush).toHaveBeenCalledTimes(1)
    // Paused: wall time is irrelevant, only the injected clock counts.
    drain.request()
    await drainHost.settled()
    expect(drainHost.flush).toHaveBeenCalledTimes(1)
    now += 250
    let stop = false
    drainHost.hasBatchBacklog = () => !stop
    drainHost.flush = vi.fn(async () => { stop = true; return outcome(true) })
    drain.request()
    await drainHost.settled()
    expect(drainHost.flush).toHaveBeenCalledTimes(1)
  })

  it('re-queues after yielding to a waiting flush without backing off', async () => {
    let waiting = true
    let steps = 0
    const drainHost = host(async (_ids, yieldBeforeBatch) => {
      steps++
      if (yieldBeforeBatch()) { waiting = false; return outcome(false) }
      return outcome(true)
    }, () => waiting)
    drainHost.hasBatchBacklog = () => steps < 2
    const drain = new BackgroundDrain(drainHost, () => 0)
    drain.request()
    await drainHost.settled()
    // Yielded once (incomplete, but not a failure), then ran again at once.
    expect(steps).toBe(2)
  })
})
