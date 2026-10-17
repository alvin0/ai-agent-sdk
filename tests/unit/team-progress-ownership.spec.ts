import { describe, expect, it, vi } from 'vitest'
import { progressActivity } from '../../packages/core/src/agent/team/team-progress-internal.ts'
import { fixture, events } from './team-progress.fixture.ts'

const stops = () => events.filter(event => event.phase === 'stopped')
const gate = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('progress invocation ownership and bounds', () => {
  it('keeps a busy long response past three short intervals until the five-minute default floor', async () => {
    const f = fixture({ minIntervalMs: 5000, maxIntervalMs: 5000, maxReports: 100 })
    f.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.progress.state().active).toBe(true)
    await vi.advanceTimersByTimeAsync(284_999)
    expect(f.progress.state().active).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(stops().map(event => event.reason)).toEqual(['stalled'])
    expect(vi.getTimerCount()).toBe(0)
    expect(f.start()).toMatchObject({ scheduled: true })
  })

  it.each([false, true])('retains duration across replacements for managed=%s', async managed => {
    const f = fixture({ maxDurationMs: 35 }, undefined, managed ? {} : undefined)
    f.start()
    await vi.advanceTimersByTimeAsync(10)
    const before = f.progress.state()
    f.progress.configure({ interval_ms: 20, targets: ['a'] })
    expect(f.progress.state()).toMatchObject({ startedAt: before.startedAt, reportsSent: 1 })
    await vi.advanceTimersByTimeAsync(25)
    expect(stops().map(event => event.reason)).toEqual(['replaced', 'max-duration'])
    expect(f.progress.state().reportsSent).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('retains report cap across replacements for managed=%s', async managed => {
    const f = fixture({ maxReports: 2 }, undefined, managed ? {} : undefined)
    f.start(['a'])
    await vi.advanceTimersByTimeAsync(10)
    f.progress.configure({ interval_ms: 20, targets: ['b'] })
    await vi.advanceTimersByTimeAsync(20)
    expect(stops().map(event => event.reason)).toEqual(['replaced', 'max-reports'])
    expect(f.progress.state().reportsSent).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)('ignores late raw idle %s when runs reuse one signal', async mode => {
    const first = gate()
    const second = gate()
    const whenIdle = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const f = fixture({}, undefined, undefined, { whenIdle })
    f.start()
    f.progress.stop('host')
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: f.invocation.signal })
    expect(f.start()).toMatchObject({ scheduled: true })
    if (mode === 'resolve') first.resolve()
    else first.reject(new Error('late raw failure'))
    await Promise.resolve()
    expect(f.progress.state().active).toBe(true)
    expect(stops().map(event => event.reason)).toEqual(['host'])
    second.resolve()
    await Promise.resolve()
    expect(stops().map(event => event.reason)).toEqual(['host', 'run-ended'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finishes only its token when a terminal observer admits another managed invocation', () => {
    const f = fixture({}, undefined, {}, { isRunning: false })
    f.start()
    f.team.subscribe(event => {
      if (event.type === 'team-progress' && event.reason === 'run-ended') {
        f.progress.beginManagedInvocation(f.invocation.signal)
      }
    })
    f.progress.finishInvocation('run-ended')
    expect(f.start()).toMatchObject({ scheduled: true })
    expect(vi.getTimerCount()).toBe(1)
  })

  it.each(['error', 'aborted'])('keeps one managed schedule across lead %s then wake', status => {
    const f = fixture({}, undefined, {})
    f.start()
    progressActivity(f.team, { kind: 'run-end', member: 'lead', status })
    f.endLead()
    progressActivity(f.team, { kind: 'invocation', member: 'lead', signal: new AbortController().signal })
    expect(f.start()).toMatchObject({ scheduled: true })
    expect(stops()).toEqual([])
    f.progress.finishInvocation('run-ended')
    expect(events.map(event => event.scheduleId)).toEqual([1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('ends a raw session invocation even when yielded=%s', async yielded => {
    const f = fixture({}, undefined, undefined, { yielded })
    f.start()
    f.endLead()
    await Promise.resolve()
    expect(stops().map(event => event.reason)).toEqual(['run-ended'])
    expect(vi.getTimerCount()).toBe(0)
    expect(() => f.start()).toThrow(/live lead invocation/)
  })
})
