import { describe, expect, it, vi } from 'vitest'
import { progressActivity } from '../../packages/core/src/agent/team/team-progress-internal.ts'
import { fixture, events } from './team-progress.fixture.ts'

const blocking = ['host', 'delivery-failed', 'aborted', 'steered', 'max-duration', 'max-reports', 'stalled'] as const

describe('progress stop policy for a managed invocation', () => {
  it.each(blocking)('keeps %s authoritative through wakes, invalid requests and lead stops', reason => {
    const f = fixture({}, undefined, {})
    f.start()
    f.progress.stop(reason)
    const state = f.progress.state()
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: new AbortController().signal })
    expect(() => f.start()).toThrow(/stopped.*for this run/)
    expect(() => f.progress.configure({ stop: true })).toThrow(/stopped.*for this run/)
    f.progress.stop('requested')
    f.progress.stop('replaced')
    expect(() => f.start()).toThrow(/stopped.*for this run/)
    expect(f.progress.state()).toEqual(state)
    expect(events.filter(event => event.phase === 'stopped')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    f.progress.finishInvocation('run-ended')
    f.progress.beginManagedInvocation(new AbortController().signal)
    expect(f.start()).toMatchObject({ scheduled: true })
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each(blocking)('records %s even before any schedule exists', reason => {
    const f = fixture({}, undefined, {})
    f.progress.stop(reason)
    expect(() => f.start()).toThrow(/stopped.*for this run/)
    expect(events).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['requested', 'replaced', 'settled', 'run-ended'] as const)
  ('allows rescheduling after %s within the same live invocation', reason => {
    const f = fixture({}, undefined, {})
    f.start(['a'])
    f.progress.stop(reason)
    expect(f.start()).toMatchObject({ scheduled: true })
    expect(vi.getTimerCount()).toBe(1)
    f.progress.stop('requested')
    expect(events.filter(event => event.phase === 'stopped').map(event => event.scheduleId)).toEqual([1, 2])
  })

  it('retains a raw invocation stop until a new raw invocation is admitted', () => {
    const f = fixture()
    f.start()
    f.progress.stop('host')
    expect(() => f.start()).toThrow('progress updates were stopped by the host for this run')
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: new AbortController().signal })
    expect(f.start()).toMatchObject({ scheduled: true })
  })

  it('keeps an abort reason when the last worker already settled', async () => {
    const f = fixture({}, undefined, {})
    f.start()
    f.busy.clear()
    f.progress.finishInvocation('aborted')
    expect(f.progress.state()).toMatchObject({ active: false, reason: 'aborted' })
    expect(events.filter(event => event.phase === 'stopped')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses managed admission without depending on lead activity or session liveness', async () => {
    const f = fixture()
    vi.spyOn(f.session, 'isRunning', 'get').mockReturnValue(false)
    const controller = new AbortController()
    f.progress.beginManagedInvocation(controller.signal)
    expect(f.start()).toMatchObject({ scheduled: true })
    f.busy.clear()
    f.settled('a')
    f.settled('b')
    await Promise.resolve()
    expect(f.progress.state().active).toBe(true)
    // A provisional turn's signal is not the managed invocation's cancellation signal.
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: f.invocation.signal })
    f.invocation.abort()
    expect(f.progress.state().active).toBe(true)
    expect(f.start()).toMatchObject({ scheduled: true })
    controller.abort()
    expect(f.progress.state()).toMatchObject({ active: false, reason: 'aborted' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
