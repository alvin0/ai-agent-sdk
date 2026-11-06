/**
 * The background drain shared by the observation bus and the runtime delivery
 * scheduler: it yields the serial chain to an explicit flush without counting
 * that as a failure, and paces failures on the monotonic clock it is given
 * rather than wall time.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BackgroundDrain, ExporterPacing, type BackgroundDrainHost, type DrainStepOutcome,
} from '../../packages/core/src/primitives/background-drain.ts'

type Host = BackgroundDrainHost<ReadonlySet<string>>

function outcome(complete: boolean): DrainStepOutcome {
  return { complete }
}

function host(flush: Host['flush'], foreground = () => false) {
  let chain: Promise<void> = Promise.resolve()
  const value: Host & { settled: () => Promise<void> } = {
    canDrain: () => true,
    hasBacklog: () => true,
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
    drainHost.hasBacklog = () => !stop
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
    drainHost.hasBacklog = () => steps < 2
    const drain = new BackgroundDrain(drainHost, () => 0)
    drain.request()
    await drainHost.settled()
    // Yielded once (incomplete, but not a failure), then ran again at once.
    expect(steps).toBe(2)
  })

  it('a forced request drains below one batch and upgrades an already-queued step', async () => {
    let queued = 3
    const seen: boolean[] = []
    const drainHost = host(async () => { queued--; return outcome(true) })
    drainHost.hasBacklog = (force) => { seen.push(force); return force ? queued > 0 : queued >= 10 }
    const drain = new BackgroundDrain(drainHost, () => 0)
    drain.request()
    expect(drainHost.flush).not.toHaveBeenCalled()
    drain.request({ force: true })
    await drainHost.settled()
    // The forced step keeps going until nothing is left, then stops on its own.
    expect(queued).toBe(0)
    expect(drainHost.flush).toHaveBeenCalledTimes(3)
    expect(seen.at(-1)).toBe(true)
  })

  it('keeps going after a step whose failed exporter is paced on its own, without pausing the others', async () => {
    const now = 0
    let steps = 0
    const drainHost = host(async () => ({ complete: false, paced: ++steps < 3 }))
    drainHost.hasBacklog = () => steps < 3
    const drain = new BackgroundDrain(drainHost, () => now)
    drain.request()
    await drainHost.settled()
    // Two paced steps run back to back; the third, which stopped for no exporter's failure, pauses all.
    expect(drainHost.flush).toHaveBeenCalledTimes(3)
    drainHost.hasBacklog = () => true
    drain.request()
    await drainHost.settled()
    expect(drainHost.flush).toHaveBeenCalledTimes(3)
  })
})

describe('ExporterPacing', () => {
  it('wakes itself when a pause ends instead of waiting for the next request, and not once stopped', async () => {
    let steps = 0
    const drainHost = host(async () => outcome(++steps > 1))
    drainHost.hasBacklog = () => steps < 2
    const drain = new BackgroundDrain(drainHost, () => performance.now())
    drain.request()
    await drainHost.settled()
    expect(steps).toBe(1)
    // The failed step paused the drain (250 ms); nothing else asks for it again.
    await vi.waitFor(() => expect(steps).toBe(2), { timeout: 1_000 })

    let other = 0
    const stoppedHost = host(async () => { other++; return outcome(false) })
    const stopped = new BackgroundDrain(stoppedHost, () => performance.now())
    stopped.request()
    await stoppedHost.settled()
    stopped.stop()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(other).toBe(1)
  })

  it('wakes when the host reports an exporter pause ending', async () => {
    let resumeAt: number | undefined = performance.now() + 100
    let steps = 0
    const drainHost = host(async () => { steps++; resumeAt = undefined; return outcome(true) })
    drainHost.hasBacklog = () => resumeAt === undefined ? steps < 1 : performance.now() >= resumeAt
    drainHost.resumeAt = () => resumeAt
    const drain = new BackgroundDrain(drainHost, () => performance.now())
    // Held back by the exporter's pause: no step now.
    drain.request()
    await drainHost.settled()
    expect(steps).toBe(0)
    await vi.waitFor(() => expect(steps).toBe(1), { timeout: 1_000 })
  })

  it('keeps going without backing off after a step that delivered before it was cut short', async () => {
    let steps = 0
    const drainHost = host(async () => {
      steps++
      return steps === 1 ? { complete: false, progressed: true } : outcome(true)
    })
    drainHost.hasBacklog = () => steps < 2
    const drain = new BackgroundDrain(drainHost, () => 1_000)
    drain.request()
    await drainHost.settled()
    expect(steps).toBe(2)
    // Nothing failed: a later request is not held back by a pause.
    drainHost.hasBacklog = () => steps < 3
    drain.request()
    await drainHost.settled()
    expect(steps).toBe(3)
  })

  it('pauses each exporter on its own, counts it down after its tentative failures, and resets on delivery', () => {
    let now = 0
    const pacing = new ExporterPacing<string>(() => now)
    expect(pacing.tentative('a')).toBe(true)
    pacing.failed(['a'])
    expect([pacing.paused('a'), pacing.paused('b')]).toEqual([true, false])
    expect([pacing.tentative('a'), pacing.down('a')]).toEqual([true, false])
    now += 250
    expect(pacing.paused('a')).toBe(false)
    pacing.failed(['a'])
    // After two failures the next one is no longer tentative; the exporter is down once it has failed three times.
    expect([pacing.tentative('a'), pacing.down('a')]).toEqual([false, false])
    now += 500
    pacing.failed(['a'])
    expect([pacing.paused('a'), pacing.down('a')]).toEqual([true, true])
    pacing.delivered('a')
    expect([pacing.paused('a'), pacing.tentative('a'), pacing.down('a')]).toEqual([false, true, false])
  })
})
