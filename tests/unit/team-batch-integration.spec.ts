import { describe, expect, it, vi } from 'vitest'
import type { TeamTimelineEvent } from '../../packages/core/src/agent/index.ts'
import { Collector } from '../../test-human/multi-agent-bench/metrics.ts'
import { execute, fixture, tasks } from './helpers/team-batch-fixture.ts'

function observed(options: Parameters<typeof fixture>[0] = {}) {
  const collector = new Collector()
  const timeline: TeamTimelineEvent[] = []
  const teamFixture = fixture({ ...options, team: { minWaitTimeoutMs: 10, waitTimeoutMs: 1000,
    onEvent: event => {
      collector.teamEvent(event)
      if (event.type === 'team-timeline') timeline.push(event)
    } } })
  const events = () => timeline
  return { ...teamFixture, collector, events }
}

describe('batch spawning with lazy disclosure and timeline observation', () => {
  it('discloses after batch dispatch, observes every FIFO wave and accounts final runtime coverage', async () => {
    const { team, adapter, collector, events } = observed({ maxWorkers: 1 })
    adapter.join = false
    const running = team.run('Inspect independent inputs')
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    expect(adapter.leads[0]!.tools?.map(tool => tool.name)).toEqual(['spawn_agent', 'spawn_agents'])
    const initial = adapter.leads[0]!.tools!
    expect(team.lead.effectiveCatalog()?.has('wait_agents')).toBe(true)
    expect(events().filter(event => event.kind === 'spawn-accepted')).toMatchObject([{ member: 'a' }])
    for (const name of ['a', 'b', 'c']) {
      await vi.waitFor(() => expect(adapter.finishes.has(name)).toBe(true))
      adapter.finishes.get(name)!.resolve()
      await team.awaitWorker(name)
    }
    expect((await running).text).toBe('synthesis')
    expect(adapter.leads.at(-1)!.tools!.slice(0, initial.length)).toEqual(initial)
    expect(adapter.leads.at(-1)!.system).toBe(adapter.leads[0]!.system)
    expect(collector.metrics(0)).toMatchObject({ spawns: 3, spawnAttempts: 3, spawnsRejected: 0 })
    for (const kind of ['spawn-requested', 'spawn-accepted', 'slot-released'] as const) {
      expect(events().filter(event => event.kind === kind).map(event => event.member)).toEqual(['a', 'b', 'c'])
    }
    expect(events().filter(event => event.kind === 'member-started' && event.member !== 'lead')).toHaveLength(3)
    expect(events().some(event => event.kind === 'notice-delivered' && event.delivery === 'injection'
      && event.workers.length === 0)).toBe(true)
    expect(events().filter(event => event.kind === 'wasted-wake')).toHaveLength(0)
    expect(team.snapshot().members.filter(member => member.role === 'peer'))
      .toMatchObject(['a', 'b', 'c'].map(name => ({ name, status: 'completed', modelCalls: 1 })))
  })

  it('records failed batch setup without acceptance or disclosure', async () => {
    const { team, collector, events } = observed({ autoLeadCoordination: false,
      workerFactory: () => { throw new Error('setup refused') } })
    const result = await execute(team, 'spawn_agents', { tasks: tasks() })
    expect(result.workers).toHaveLength(3)
    expect(result.workers.every((worker: { status: string }) => worker.status === 'failed')).toBe(true)
    expect(result.guidance).toBeUndefined()
    expect(team.lead.effectiveCatalog()?.has('wait_agents')).toBe(false)
    expect(collector.metrics(0)).toMatchObject({ spawns: 0, spawnAttempts: 3, spawnsRejected: 3 })
    expect(events().filter(event => event.kind === 'spawn-accepted')).toHaveLength(0)
    expect(events().filter(event => event.kind === 'spawn-failed')).toHaveLength(3)
    expect(events().filter(event => event.kind === 'slot-released')).toHaveLength(3)
  })

  it.each(['invalid', 'overflow', 'duplicate'] as const)('accounts %s refusals without dispatch', async cause => {
    const { team, adapter, collector, events } = observed({
      maxWorkers: 1, maxQueued: cause === 'overflow' ? 0 : 2,
    })
    const requests = tasks().slice(0, 2).map(task => {
      if (cause === 'invalid') return { ...task, role: 'undeclared' }
      return cause === 'duplicate' ? { ...task, name: 'same' } : task
    })
    await expect(execute(team, 'spawn_agents', { tasks: requests })).rejects.toThrow()
    expect(adapter.workers.size).toBe(0)
    expect(collector.metrics(0)).toMatchObject({ spawns: 0, spawnAttempts: 2, spawnsRejected: 2 })
    expect(events().filter(event => event.kind === 'spawn-rejected')).toHaveLength(2)
    expect(team.lead.effectiveCatalog()?.has('wait_agents')).toBe(false)
  })

  it('accounts aborted queued items without releasing slots they never owned', async () => {
    const { team, collector, events } = observed({ maxWorkers: 1, autoLeadCoordination: false })
    const result = await execute(team, 'spawn_agents', { tasks: tasks() })
    expect(result.guidance).toContain('Fan out for many independent items when accuracy or time benefits justify')
    await team.dispose()
    expect(collector.metrics(0)).toMatchObject({ spawns: 1, spawnAttempts: 3, spawnsRejected: 2 })
    expect(events().filter(event => event.kind === 'spawn-requested').map(event => event.member)).toEqual(['a'])
    expect(events().filter(event => event.kind === 'spawn-rejected')).toMatchObject([
      { member: 'b', reason: 'aborted' }, { member: 'c', reason: 'aborted' },
    ])
    expect(events().filter(event => event.kind === 'slot-released').map(event => event.member)).toEqual(['a'])
  })

  it('records a pre-admission batch abort with no request or worker allocation', async () => {
    const { team, adapter, collector, events } = observed()
    const controller = new AbortController()
    controller.abort(new Error('cancel admission'))
    await expect(execute(team, 'spawn_agents', { tasks: tasks() }, controller.signal)).rejects.toThrow()
    expect(collector.metrics(0)).toMatchObject({ spawns: 0, spawnAttempts: 3, spawnsRejected: 3 })
    expect(events().filter(event => event.kind === 'spawn-requested')).toHaveLength(0)
    expect(adapter.workers.size).toBe(0)
    expect(team.lead.effectiveCatalog()?.has('wait_agents')).toBe(false)
  })

})
