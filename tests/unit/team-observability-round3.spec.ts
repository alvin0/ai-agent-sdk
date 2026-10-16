import { describe, expect, it, vi } from 'vitest'
import type { ManagedAgentTeamOptions } from '@alvin0/ai-agent-sdk-core/agent'
import { Collector } from '../../test-human/multi-agent-bench/metrics.ts'
import { create, deferred, GatedTeam } from './team-push-join.fixture.ts'

function observedTeam(adapter = new GatedTeam(), options: Partial<ManagedAgentTeamOptions> = {}) {
  const collector = new Collector()
  const team = create(adapter, { autoLeadCoordination: false, ...options, team: { onEvent: event => {
    collector.teamEvent(event)
    if (event.type === 'member-attached' && event.member.name !== 'lead') collector.spawns++
  } } })
  return { team, collector, adapter }
}

function expectAccounting(collector: Collector, spawns: number, spawnsRejected: number) {
  const metrics = collector.metrics(0)
  expect(metrics).toMatchObject({ spawns, spawnsRejected, spawnAttempts: spawns + spawnsRejected })
  expect(metrics.spawns + metrics.spawnsRejected!).toBe(metrics.spawnAttempts)
  expect(metrics).not.toHaveProperty('spawnRejected')
}

describe('spawn admission accounting review fixes', () => {
  it.each(['legacy', 'lean'] as const)('counts a %s delivery failure only as rejected, then accepts a successful retry', async modelToolSurface => {
    const { team, collector, adapter } = observedTeam(new GatedTeam(), { modelToolSurface })
    const delivery = vi.spyOn(team.team, 'sendMessage').mockRejectedValueOnce(new Error('delivery failed'))
    await expect(team.spawn({ name: 'w', task: 'task' })).rejects.toThrow('delivery failed')
    // Attachment fallback must not turn zero successful timeline admissions into a spawn.
    expect(collector.spawns).toBe(1)
    expectAccounting(collector, 0, 1)
    expect(collector.teamEvents.filter(event => event.kind === 'spawn-failed')).toHaveLength(1)
    expect(collector.teamEvents.filter(event => event.kind === 'spawn-rejected'))
      .toMatchObject([{ member: 'w', reason: 'setup', code: 'TEAM_SPAWN_SETUP_FAILED' }])
    expect(collector.teamEvents.some(event => event.kind === 'spawn-accepted')).toBe(false)
    expect(adapter.started.size).toBe(0)
    delivery.mockRestore()
    await team.spawn({ name: 'w', task: 'retry task' })
    expectAccounting(collector, 1, 1)
    const accepted = collector.teamEvents.find(event => event.kind === 'spawn-accepted')!
    const delivered = collector.teamEvents.find(event => event.type === 'message-accepted')!
    expect(collector.teamEvents.indexOf(accepted)).toBeGreaterThan(collector.teamEvents.indexOf(delivered))
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
  })

  it('records a lazy model spawn once before the disclosed synthesis request', async () => {
    const preparing = deferred()
    const { team, collector, adapter } = observedTeam(new GatedTeam(), {
      modelToolSurface: 'lean', autoLeadCoordination: true,
      workerSessionOptionsFactory: async () => { await preparing.promise; return {} },
    })
    const running = team.run('Research')
    await vi.waitFor(() => expect(collector.teamEvents.some(event => event.kind === 'spawn-requested')).toBe(true))
    expect(adapter.leadRequests[0]!.tools?.map(tool => tool.name)).toEqual(['spawn_agent', 'spawn_agents'])
    expect(team.lead.effectiveCatalog()!.has('wait_agents')).toBe(false)
    expect(collector.teamEvents.some(event => event.kind === 'spawn-accepted')).toBe(false)
    preparing.resolve()
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    expectAccounting(collector, 1, 0)
    expect(collector.teamEvents.filter(event => event.kind === 'spawn-requested')).toHaveLength(1)
    expect(collector.teamEvents.filter(event => event.kind === 'spawn-accepted')).toHaveLength(1)
    expect(adapter.leadRequests[1]!.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'spawn_agent', 'send_input', 'wait_agents', 'close_agent', 'get_agent_result',
    ]))
    adapter.gates.get('w')!.resolve()
    expect((await running).text).toBe('synthesis')
    expectAccounting(collector, 1, 0)
    expect(collector.teamEvents.filter(event => event.kind === 'spawn-accepted')).toHaveLength(1)
  })

  it('accepts a successfully held dependency without waiting for the worker to start', async () => {
    const { team, collector, adapter } = observedTeam(new GatedTeam(['producer', 'dependent']))
    await team.spawn({ name: 'producer', task: 'produce' })
    await team.spawn({ name: 'dependent', task: 'consume', dependsOn: ['producer'] })
    expect(adapter.started.has('dependent')).toBe(false)
    expectAccounting(collector, 2, 0)
    adapter.gates.get('producer')!.resolve()
    await team.awaitWorker('producer')
    adapter.gates.get('dependent')!.resolve()
    await team.awaitWorker('dependent')
    expectAccounting(collector, 2, 0)
  })

  it.each(['caller', 'team'] as const)('labels an already aborted %s signal separately from invalid input', async source => {
    const { team, collector } = observedTeam()
    const controller = new AbortController()
    const reason = new Error('cancelled admission')
    if (source === 'caller') controller.abort(reason)
    else await team.dispose()
    await expect(team.spawn({ name: 'w', task: 'valid task' }, controller.signal)).rejects.toThrow()
    expectAccounting(collector, 0, 1)
    expect(collector.teamEvents.filter(event => event.kind === 'spawn-rejected'))
      .toMatchObject([{ member: 'w', reason: 'aborted', code: 'TEAM_SPAWN_ABORTED', busy: 0, preparing: 0 }])
    expect(collector.teamEvents.some(event => event.kind === 'spawn-requested')).toBe(false)
    expect(collector.teamEvents.some(event => event.kind === 'spawn-failed')).toBe(false)
  })
})
