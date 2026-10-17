import { describe, expect, it, vi } from 'vitest'
import { progressActivity } from '../../packages/core/src/agent/team/team-progress-internal.ts'
import { fixture, events } from './team-progress.fixture.ts'

const reports = () => events.filter(event => event.phase === 'report')
function expectStopped(reason: string) {
  expect(events.filter(event => event.phase === 'stopped')).toHaveLength(1)
  expect(events.at(-1)?.reason).toBe(reason)
  expect(vi.getTimerCount()).toBe(0)
}

describe('invocation-wide progress updates', () => {
  it('follows two spawn waves and lead-only gaps with one schedule and cadence', async () => {
    const f = fixture({ stalledIntervals: 2, stallFloorMs: 200 }, undefined, {})
    f.start()
    await vi.advanceTimersByTimeAsync(10)
    vi.spyOn(f.session, 'isRunning', 'get').mockReturnValue(false)
    f.settled('a')
    f.settled('b')
    await Promise.resolve() // Settlement while yielded must not preempt the next synthesis/spawn.
    expect(f.progress.state().active).toBe(true)
    vi.spyOn(f.session, 'isRunning', 'get').mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(reports()).toHaveLength(1)
    expect(f.progress.state()).toMatchObject({ active: true, reportsSent: 1 })
    expect(vi.getTimerCount()).toBe(1)
    f.workers.push('later')
    f.busy.add('later')
    f.activity('later')
    expect(f.progress.state().targets).toEqual(['a', 'b', 'later'])
    await vi.advanceTimersByTimeAsync(10)
    expect(reports()).toHaveLength(2)
    expect(reports()[1]).toMatchObject({ targets: ['a', 'b', 'later'],
      members: [{ name: 'a' }, { name: 'b' }, { name: 'later', status: 'running' }] })
    f.settled('later')
    await Promise.resolve()
    expect(f.progress.state().active).toBe(true)
    f.progress.finishInvocation('run-ended')
    expectStopped('settled')
    expect(new Set(events.map(event => event.scheduleId))).toEqual(new Set([1]))
  })

  it('can start with no current workers and report workers admitted later', async () => {
    const f = fixture()
    f.workers.length = 0
    f.busy.clear()
    expect(f.start()).toMatchObject({ scheduled: true, targets: [] })
    await vi.advanceTimersByTimeAsync(40)
    expect(events).toEqual([])
    f.workers.push('new')
    f.busy.add('new')
    await vi.advanceTimersByTimeAsync(10)
    expect(reports()[0]?.targets).toEqual(['new'])
    f.progress.stop()
    expectStopped('host')
  })

  it('stalls a hung lead without busy workers but preserves short gaps with active lead', async () => {
    const f = fixture({ stalledIntervals: 2, stallFloorMs: 40 }, undefined, {})
    f.busy.clear()
    f.start()
    await vi.advanceTimersByTimeAsync(30)
    f.activity('lead')
    await vi.advanceTimersByTimeAsync(30)
    expect(events).toEqual([])
    expect(f.progress.state().active).toBe(true)
    // isRunning stays true: one hung response must still reach the inactivity bound.
    await vi.advanceTimersByTimeAsync(10)
    expect(reports()).toEqual([])
    expectStopped('stalled')
  })

  it.each(['model', 'tool'] as const)('lead %s activity resets the watchdog', async kind => {
    const f = fixture({ stalledIntervals: 2, stallFloorMs: 1 })
    f.start()
    await vi.advanceTimersByTimeAsync(10)
    if (kind === 'model') f.activity('lead')
    else progressActivity(f.team, { kind: 'tool', member: 'lead', name: 'read_file', args: {} })
    await vi.advanceTimersByTimeAsync(10)
    expect(f.progress.state().active).toBe(true)
    expect(reports()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10)
    expectStopped('stalled')
  })

  it('an identical untargeted call preserves scheduleId, next tick, counts and duration cap', async () => {
    const f = fixture({ maxDurationMs: 30, stalledIntervals: 10 }, undefined, {})
    const first = f.start()
    await vi.advanceTimersByTimeAsync(10)
    const state = f.progress.state()
    await vi.advanceTimersByTimeAsync(5)
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: new AbortController().signal })
    expect(f.start()).toEqual(first)
    expect(f.progress.state()).toEqual(state)
    expect(events.filter(event => event.reason === 'replaced')).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5)
    expect(reports()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10)
    expectStopped('max-duration')
    expect(new Set(events.map(event => event.scheduleId))).toEqual(new Set([1]))
  })

  it('keeps the duration bound during quiet lead-only work', async () => {
    const f = fixture({ maxDurationMs: 25 })
    f.busy.clear()
    f.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(reports()).toEqual([])
    expectStopped('max-duration')
  })

  it('deduplicates intervals that clamp to the same host limit', () => {
    const f = fixture()
    expect(f.progress.configure({ interval_ms: 1 })).toEqual(f.start())
    expect(events).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    f.progress.stop()
    expectStopped('host')
  })

  it.each([false, true])('ends an invocation with outstanding workers=%s', outstanding => {
    const f = fixture({}, undefined, {})
    f.start()
    if (!outstanding) f.busy.clear()
    f.progress.finishInvocation('run-ended')
    expectStopped(outstanding ? 'run-ended' : 'settled')
  })

  it.each([false, true])('ends a raw invocation with outstanding workers=%s', async outstanding => {
    const f = fixture()
    let idle!: () => void
    vi.spyOn(f.session, 'whenIdle').mockReturnValueOnce(new Promise<void>(resolve => { idle = resolve }))
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: f.invocation.signal })
    f.start()
    if (!outstanding) f.busy.clear()
    vi.spyOn(f.session, 'isRunning', 'get').mockReturnValue(false)
    idle()
    await Promise.resolve()
    expectStopped(outstanding ? 'run-ended' : 'settled')
  })

  it('keeps explicit targets frozen and settles them while the lead and later workers run', async () => {
    const f = fixture()
    f.start(['a'])
    f.workers.push('later')
    f.busy.add('later')
    await vi.advanceTimersByTimeAsync(10)
    expect(reports()[0]?.targets).toEqual(['a'])
    f.settled('a')
    await Promise.resolve()
    expectStopped('settled')
  })

  it.each([{ interval_ms: 20 }, { interval_ms: 10, targets: ['a', 'b'] }])
  ('still replaces an untargeted schedule when configuration changes: %j', async request => {
    const f = fixture()
    let timersAtStop: number | undefined
    f.team.subscribe(event => {
      if (event.type === 'team-progress' && event.phase === 'stopped') timersAtStop = vi.getTimerCount()
    })
    f.start()
    f.progress.configure(request)
    expectStoppedEventOnly()
    expect(timersAtStop).toBe(0)
    await vi.advanceTimersByTimeAsync(request.interval_ms)
    expect(reports()[0]?.scheduleId).toBe(2)
    f.progress.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not deduplicate repeated explicit calls', () => {
    const f = fixture()
    f.start(['a'])
    f.start(['a'])
    expectStoppedEventOnly()
    f.progress.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

function expectStoppedEventOnly() {
  expect(events.filter(event => event.phase === 'stopped').map(event => event.reason)).toEqual(['replaced'])
  expect(vi.getTimerCount()).toBe(1)
}
