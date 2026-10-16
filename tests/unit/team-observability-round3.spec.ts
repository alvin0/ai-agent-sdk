import { describe, expect, it, vi } from 'vitest'
import { Collector } from '../../test-human/multi-agent-bench/metrics.ts'
import { create, GatedTeam } from './team-push-join.fixture.ts'

function observedTeam(adapter = new GatedTeam()) {
  const collector = new Collector()
  const team = create(adapter, { autoLeadCoordination: false, team: { onEvent: event => {
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
  it('counts a post-attachment delivery failure only as rejected, then accepts a successful retry', async () => {
    const { team, collector, adapter } = observedTeam()
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
