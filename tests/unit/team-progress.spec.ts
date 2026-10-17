import { describe, expect, it, vi } from 'vitest'
import { progressTool, parseProgressRequest } from '../../packages/core/src/agent/team/managed-progress-tool.ts'
import { progressActivity } from '../../packages/core/src/agent/team/team-progress-internal.ts'
import { fixture, events } from './team-progress.fixture.ts'

const stopped = () => events.filter(event => event.phase === 'stopped')
function expectStopped(reason: string) {
  expect(stopped()).toHaveLength(1)
  expect(stopped()[0]?.reason).toBe(reason)
  expect(vi.getTimerCount()).toBe(0)
}

describe('bounded runtime progress schedule', () => {
  it.each([{}, { interval_ms: 0 }, { interval_ms: -5 }, { interval_ms: NaN }, { interval_ms: Infinity },
    { interval_ms: 1.5 }, { stop: 'yes' }, { interval_ms: 10, targets: [] },
    { interval_ms: 10, targets: [1] }, { interval_ms: 10, targets: [''] }])('rejects invalid %j', raw => {
    expect(() => parseProgressRequest(raw)).toThrow()
  })

  it('accepts stop without interval; clamps both ends and defaults to all current workers', () => {
    const f = fixture()
    expect(f.progress.state()).toEqual({ active: false, reportsSent: 0 })
    expect(vi.getTimerCount()).toBe(0)
    expect(f.progress.configure(parseProgressRequest({ interval_ms: 1 })))
      .toEqual({ scheduled: true, interval_ms: 10, targets: ['a', 'b'] })
    expect(f.progress.configure(parseProgressRequest({ interval_ms: 500, targets: ['b', 'b'] })))
      .toEqual({ scheduled: true, interval_ms: 100, targets: ['b'] })
    expect(stopped().map(event => event.reason)).toEqual(['replaced'])
    expect(vi.getTimerCount()).toBe(1)
    expect(f.progress.configure(parseProgressRequest({ stop: true }))).toEqual({ scheduled: false })
    expect(stopped().map(event => event.reason)).toEqual(['replaced', 'requested'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports snapshot facts, bounded automatic activity and per-report deltas', async () => {
    const f = fixture()
    f.start(['a'])
    f.tool({ file_path: 'a\n' + 'x'.repeat(200), api_key: 'progress/PRIVATE_ARGUMENT_SENTINEL' })
    await vi.advanceTimersByTimeAsync(10)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'team-progress', phase: 'report', reportsSent: 1,
      targets: ['a'], members: [{ name: 'a', status: 'running', modelCalls: 2, toolCalls: 1,
        lastTool: 'read_file', argumentHint: 'a ' + 'x'.repeat(118) }] })
    expect(events[0]!.text).toContain('read_file')
    expect(JSON.stringify(events)).not.toContain('progress/PRIVATE_ARGUMENT_SENTINEL')
    await vi.advanceTimersByTimeAsync(10)
    expect(events[1]!.members[0]!.toolCalls).toBe(0)
    expect(f.progress.state()).toMatchObject({ active: true, intervalMs: 10, reportsSent: 2 })
    expect(Object.isFrozen(f.progress.state().targets)).toBe(true)
    expect(Object.isFrozen(events[0]!.members)).toBe(true)
  })

  it('settles immediately with a single final report and clears its timer', async () => {
    const f = fixture()
    f.start(['a'])
    f.settled('a')
    await Promise.resolve()
    expectStopped('settled')
    expect(stopped()[0]!.members[0]!.status).toBe('completed')
    f.progress.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expectStopped('settled')
  })

  it('handles already settled targets without arming', () => {
    const f = fixture()
    f.busy.clear()
    expect(f.start()).toMatchObject({ scheduled: false })
    expectStopped('settled')
  })

  it.each(['host', 'requested', 'run-ended', 'aborted', 'closed', 'steered'] as const)
  ('actively stops %s exactly once', reason => {
    const f = fixture()
    f.start()
    f.progress.stop(reason)
    f.progress.stop(reason)
    expectStopped(reason)
    expect(f.progress.state()).toMatchObject({ active: false, reason })
  })

  it('removes the old timer before replacing and only ticks the new targets', async () => {
    const f = fixture()
    f.start(['a'])
    await vi.advanceTimersByTimeAsync(5)
    f.start(['b'])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5)
    expect(events).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5)
    expect(events.at(-1)).toMatchObject({ phase: 'report', scheduleId: 2, targets: ['b'] })
    f.progress.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([{ minIntervalMs: 0 }, { minIntervalMs: 101, maxIntervalMs: 100 },
    { maxReports: -1 }, { maxDurationMs: Infinity }, { stalledIntervals: 0 },
    { maxConsecutiveFailures: NaN }, { maxIntervalMs: 2 ** 32 }])('rejects unsafe host bounds %j', options => {
    expect(() => fixture(options)).toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('invalid replacement stops the old loop', () => {
    const f = fixture()
    f.start()
    expect(() => f.start(['unknown'])).toThrow(/current/)
    expectStopped('replaced')
  })

  it('stops on host lifecycle abort', () => {
    const f = fixture()
    f.start()
    f.controller.abort()
    expectStopped('closed')
  })

  it('stops immediately on invocation abort, including while yielded', () => {
    const f = fixture()
    f.start()
    f.invocation.abort()
    expectStopped('aborted')
    expect(() => f.start()).toThrow()
    expectStopped('aborted')
  })

  it('stops when the underlying team closes', async () => {
    const f = fixture()
    f.start()
    await f.team.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expectStopped('closed')
    expect(() => f.start()).toThrow()
  })

  it('unrefs timers and clears them on dispose', () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const f = fixture()
    f.start()
    const handle = spy.mock.results.at(-1)!.value as { hasRef(): boolean }
    expect(handle.hasRef()).toBe(false)
    f.progress.dispose()
    f.progress.dispose()
    expectStopped('closed')
  })

  it('honors max duration precisely even below the interval', async () => {
    const f = fixture({ maxDurationMs: 5 })
    f.start()
    await vi.advanceTimersByTimeAsync(5)
    expectStopped('max-duration')
  })

  it('stops after the report cap and emits one terminal event', async () => {
    const f = fixture({ maxReports: 2 })
    f.start()
    await vi.advanceTimersByTimeAsync(20)
    expect(events.filter(event => event.phase === 'report')).toHaveLength(2)
    expect(f.progress.state().reportsSent).toBe(2)
    expectStopped('max-reports')
  })

  it('stops on K inactive intervals, resetting only for targeted activity', async () => {
    const f = fixture({ stalledIntervals: 2 })
    f.start(['a'])
    await vi.advanceTimersByTimeAsync(10)
    f.activity('a')
    await vi.advanceTimersByTimeAsync(10)
    f.activity('b')
    await vi.advanceTimersByTimeAsync(20)
    expectStopped('stalled')
  })

  it('contains throwing host handlers, continues delivering to others, then fails closed', async () => {
    const f = fixture()
    f.team.subscribe(event => { if (event.type === 'team-progress') throw new Error('broken UI') })
    f.start()
    await expect(vi.advanceTimersByTimeAsync(20)).resolves.toBeDefined()
    expectStopped('delivery-failed')
    expect(f.progress.state().reportsSent).toBe(0)
  })

  it('contains throws from the host onEvent hook and sends a single terminal event', async () => {
    const f = fixture({}, () => { throw new Error('host onEvent failed') })
    f.start()
    await vi.advanceTimersByTimeAsync(20)
    expectStopped('delivery-failed')
  })

  it('stops if liveness disappears even when an end event is missing', async () => {
    const f = fixture()
    f.start()
    vi.spyOn(f.session, 'isRunning', 'get').mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(10)
    expectStopped('run-ended')
    expect(() => f.start()).toThrow(/live lead invocation/)
  })

  it('stops the old schedule if the model sends an invalid replacement', () => {
    const f = fixture()
    f.start()
    expect(() => progressTool(f.progress).parse!({ interval_ms: 'bad' })).toThrow()
    expectStopped('replaced')
  })

  it('fails closed on async observers and contains rejected promises', async () => {
    const f = fixture({}, async () => { throw new Error('async sink unsupported') })
    f.start()
    await vi.advanceTimersByTimeAsync(20)
    expectStopped('delivery-failed')
  })

  it('stops an old schedule at new invocation admission without a renewed request', () => {
    const f = fixture()
    f.start()
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: new AbortController().signal })
    f.invocation.abort()
    expectStopped('run-ended')
  })

  it('keeps the original signal authoritative across wakes owned by one managed invocation', () => {
    const f = fixture({}, undefined, {})
    f.start()
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: new AbortController().signal })
    expect(f.progress.state().active).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    f.invocation.abort()
    expectStopped('aborted')
  })

  it('contains report-building failure and still emits the terminal event once', async () => {
    const f = fixture()
    f.snapshotSpy.mockImplementation(() => { throw new Error('snapshot unavailable') })
    f.start()
    await vi.advanceTimersByTimeAsync(20)
    expectStopped('delivery-failed')
    expect(stopped()[0]!.members).toEqual([])
  })

  it('resets consecutive delivery failures after success', async () => {
    const f = fixture({ stalledIntervals: 10 })
    let fail = true
    f.team.subscribe(event => { if (event.type === 'team-progress' && fail) throw new Error('temporary') })
    f.start()
    await vi.advanceTimersByTimeAsync(10)
    fail = false
    await vi.advanceTimersByTimeAsync(10)
    fail = true
    await vi.advanceTimersByTimeAsync(10)
    expect(f.progress.state()).toMatchObject({ active: true, reportsSent: 1 })
    await vi.advanceTimersByTimeAsync(10)
    expectStopped('delivery-failed')
  })

  it('has no overlapping ticks or reentrant replacement; allows an active stop during delivery', async () => {
    const f = fixture()
    let timerCount: number | undefined
    let replacementError: unknown
    f.team.subscribe(event => {
      if (event.type !== 'team-progress' || event.phase !== 'report') return
      timerCount = vi.getTimerCount()
      try { f.start() } catch (error) { replacementError = error }
      f.progress.stop('host')
    })
    f.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(timerCount).toBe(0)
    expect(replacementError).toBeInstanceOf(Error)
    expect((replacementError as Error).message).toMatch(/delivering/)
    expect(events.filter(event => event.phase === 'report')).toHaveLength(1)
    expectStopped('host')
  })

  it.each(['resolve', 'reject'] as const)('isolates a late idle %s from a newer schedule', async mode => {
    const f = fixture()
    let finish!: () => void
    vi.spyOn(f.session, 'whenIdle').mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = mode === 'resolve' ? resolve : () => reject(new Error('late idle rejection'))
    }))
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: f.invocation.signal })
    f.start()
    progressActivity(f.team, { kind: 'run-end', member: 'lead', status: 'success' })
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: new AbortController().signal })
    expectStopped('run-ended')
    f.start(['b']) // The new invocation explicitly requests its own schedule.
    finish()
    await Promise.resolve()
    expect(f.progress.state()).toMatchObject({ active: true, targets: ['b'] })
    expect(vi.getTimerCount()).toBe(1)
    f.progress.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)('stops directly on idle %s with stale yielded and no run-end', async mode => {
    const f = fixture()
    let finish!: () => void
    vi.spyOn(f.session, 'whenIdle').mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = mode === 'resolve' ? resolve : () => reject(new Error('failed before run span'))
    }))
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: f.invocation.signal })
    f.start()
    vi.spyOn(f.session, 'isRunning', 'get').mockReturnValue(false)
    expect(f.session.lastOutcome()?.yielded).toBe(true)
    finish()
    await Promise.resolve()
    expectStopped('run-ended') // No clock advancement: invocation end clears the timer directly.
    expect(() => f.start()).toThrow(/live lead invocation/)
  })

  it('clears activity hints and the latest signal on disposal', () => {
    const f = fixture()
    f.tool()
    f.start()
    f.progress.dispose()
    expectStopped('closed')
    // Disposed instances must not retain path hints or invocation signals.
    const retained = f.progress as unknown as { activity: Map<string, unknown>; latestSignal: unknown }
    expect(retained.activity.size).toBe(0)
    expect(retained.latestSignal).toBeUndefined()
  })

  it.each(['error', 'aborted'])('stops on a failed lead run (%s)', status => {
    const f = fixture()
    f.start()
    progressActivity(f.team, { kind: 'run-end', member: 'lead', status })
    expectStopped(status === 'aborted' ? 'aborted' : 'run-ended')
  })
})
