import { joinManagedTeam } from '../../packages/core/src/agent/team/managed-join.ts'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTeamEvent, TeamTimelineEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { TeamObservation } from '../../packages/core/src/agent/team/team-observation.ts'
import { ManagedSynthesisGuard } from '../../packages/core/src/agent/team/managed-lead.ts'
import { CollaborationTaskBoard } from '../../packages/core/src/agent/team/collaboration-board.ts'
import { NOOP_OBSERVATION_PORT, type ObservationEvent } from '../../packages/core/src/observation/index.ts'
import { AgentTeam } from '../../packages/core/src/agent/team/team.ts'
import { managedControlPlane } from '../../packages/core/src/agent/team/managed-options.ts'
import { observeTeamSession } from '../../packages/core/src/agent/team/team-observation-internal.ts'
import type { TeamTimelineData } from '../../packages/core/src/agent/team/team-timeline.ts'
import { create, deferred, GatedTeam } from './team-push-join.fixture.ts'

const timeline = (events: AgentTeamEvent[]) => events.filter(
  (event): event is TeamTimelineEvent => event.type === 'team-timeline')
const observationEvent = (name: string, phase: string, runId: string, conversationId = 'root', data = {}) => ({
  name, phase, correlation: { runId, conversationId }, occurredAt: new Date().toISOString(), data,
}) as ObservationEvent
const member = { name: 'lead', agentId: 'lead', conversationId: 'root', role: 'lead' as const,
  kind: 'local' as const, status: 'idle' as const, deliveries: [] }

describe('reviewed team observability boundaries', () => {
  it('emits one rejection per invalid, duplicate, capacity and setup attempt with capacity context', async () => {
    const events: AgentTeamEvent[] = []
    const adapter = new GatedTeam()
    const team = create(adapter, { autoLeadCoordination: false, maxWorkers: 1,
      team: { onEvent: event => events.push(event) } })
    await expect(team.spawn({ name: 'bad', task: '' })).rejects.toThrow()
    await team.spawn({ name: 'w', task: 'task' })
    await expect(team.spawn({ name: 'w', task: 'duplicate' })).rejects.toThrow('already exists')
    await expect(team.spawn({ name: 'overflow', task: 'task' })).rejects.toThrow('limit')
    expect(timeline(events).filter(event => event.kind === 'spawn-rejected')).toMatchObject([
      { member: 'bad', reason: 'invalid', code: 'TEAM_SPAWN_INVALID', busy: 0, preparing: 0, limit: 1 },
      { member: 'w', reason: 'duplicate', code: 'TEAM_WORKER_ALREADY_EXISTS', busy: 1, preparing: 0, limit: 1 },
      { member: 'overflow', reason: 'capacity', code: 'TEAM_WORKER_LIMIT', busy: 1, preparing: 0, limit: 1 },
    ])
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    await team.closeWorker('w')
    expect(timeline(events).filter(event => event.kind === 'slot-released' && event.member === 'w')).toHaveLength(1)
    expect(timeline(events).filter(event => event.kind === 'member-closed' && event.member === 'w')).toHaveLength(1)
    const failed = create(new GatedTeam(), { autoLeadCoordination: false,
      workerFactory: () => { throw new Error('factory failed') }, team: { onEvent: event => events.push(event) } })
    await expect(failed.spawn({ name: 'setup', task: 'task' })).rejects.toThrow('factory failed')
    expect(timeline(events).filter(event => event.kind === 'spawn-rejected' && event.member === 'setup'))
      .toMatchObject([{ reason: 'setup', code: 'TEAM_SPAWN_SETUP_FAILED', busy: 0, preparing: 1, limit: 7 }])
    expect(timeline(events).find(event => event.kind === 'spawn-failed')).toMatchObject({ reason: 'setup' })
    expect(timeline(events).find(event => event.kind === 'slot-released' && event.member === 'setup')).toBeDefined()
  })

  it('includes preparing reservations in cap refusals', async () => {
    const events: AgentTeamEvent[] = []
    const gate = deferred()
    const team = create(new GatedTeam(), { autoLeadCoordination: false, maxWorkers: 1,
      workerFactory: async () => { await gate.promise; throw new Error('setup aborted') },
      team: { onEvent: event => events.push(event) } })
    const preparing = team.spawn({ name: 'preparing', task: 'task' })
    const failure = expect(preparing).rejects.toThrow('setup aborted')
    await expect(team.spawn({ name: 'overflow', task: 'task' })).rejects.toThrow('limit')
    expect(timeline(events).find(event => event.kind === 'spawn-rejected')).toMatchObject({
      member: 'overflow', busy: 0, preparing: 1, limit: 1,
    })
    gate.resolve()
    await failure
  })

  it('distinguishes the raw lead return from the joined final boundary and records wake senders', async () => {
    const events: AgentTeamEvent[] = []
    const adapter = new GatedTeam()
    const team = create(adapter, { team: { onEvent: event => events.push(event) } })
    const running = team.run('task')
    await vi.waitFor(() => expect(timeline(events).some(event => event.kind === 'lead-returned')).toBe(true))
    expect(timeline(events).find(event => event.kind === 'lead-returned')).toMatchObject({ busy: 1, preparing: 0 })
    expect(timeline(events).some(event => event.kind === 'team-joined')).toBe(false)
    expect(timeline(events).find(event => event.kind === 'member-started' && event.member === 'w'))
      .toMatchObject({ activation: { source: 'initial', sender: 'lead' } })
    adapter.gates.get('w')!.resolve()
    await running
    expect(timeline(events).find(event => event.kind === 'team-joined')).toMatchObject({ busy: 0, preparing: 0 })
    await team.team.followup('lead', 'w', 'new task')
    await team.whenQuiet()
    expect(timeline(events).filter(event => event.kind === 'member-started' && event.member === 'w').at(-1))
      .toMatchObject({ activation: { source: 'message', sender: 'lead' } })
  })

  it('exposes active workers when an unjoined lead returns', async () => {
    const events: AgentTeamEvent[] = []
    const adapter = new GatedTeam()
    const team = create(adapter, { autoLeadCoordination: false, team: { onEvent: event => events.push(event) } })
    await team.run('task')
    expect(timeline(events).find(event => event.kind === 'lead-returned')).toMatchObject({ busy: 1, preparing: 0 })
    expect(timeline(events).some(event => event.kind === 'team-joined')).toBe(false)
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    const returned = timeline(events).findIndex(event => event.kind === 'lead-returned')
    expect(timeline(events).findIndex(event => event.kind === 'worker-settled')).toBeGreaterThan(returned)
  })

  it('observes starts before attachment and child conversations without resetting counters on attach', () => {
    const facts: TeamTimelineData[] = []
    const observer = new TeamObservation('t', event => facts.push(event))
    const port = observer.sessionOptions('lead', { observation: NOOP_OBSERVATION_PORT }).observation
    port.capture(observationEvent('sdk.agent.run', 'start', 'early', 'early-child'))
    port.capture(observationEvent('sdk.model.call', 'start', 'early', 'early-child'))
    observer.attach(member)
    port.capture(observationEvent('sdk.agent.run', 'start', 'nested', 'child'))
    const call = observationEvent('sdk.model.call', 'start', 'nested', 'child')
    port.capture(call)
    port.capture(call)
    expect(facts.filter(event => event.kind === 'model-requested')).toHaveLength(2)
    expect(facts.filter(event => event.kind === 'member-started')).toHaveLength(2)
    expect(observer.snapshot([member]).members[0]).toMatchObject({ modelCalls: 2, runs: 2, activeRuns: 2, role: 'lead' })
  })

  it('infers nested ancestry and attributes inherited calls to their closest team', () => {
    const facts: TeamTimelineData[] = []
    const root = new AgentTeam({ id: 'root-team', onEvent: event => {
      if (event.type === 'team-timeline') facts.push(event)
    } })
    const rootOptions = observeTeamSession(root, 'lead', { observation: NOOP_OBSERVATION_PORT })
    const child = managedControlPlane({ leadSessionOptions: rootOptions,
      team: { id: 'child-team', onEvent: (event: AgentTeamEvent) => {
        if (event.type === 'team-timeline') facts.push(event)
      } } } as never, 1)
    const childOptions = observeTeamSession(child, 'lead', rootOptions)
    rootOptions.observation.capture(observationEvent('sdk.model.call', 'start', 'root-call'))
    childOptions.observation.capture(observationEvent('sdk.model.call', 'start', 'child-call', 'child'))
    expect(facts.filter(event => event.kind === 'model-requested')).toHaveLength(2)
    expect(facts[1]).toMatchObject({ teamId: 'child-team', parentTeamId: 'root-team', depth: 1 })
    expect(child.snapshot()).toMatchObject({ parentTeamId: 'root-team', depth: 1 })
    expect(root.snapshot().members[0]?.modelCalls).toBe(1)
    expect(child.snapshot().members[0]?.modelCalls).toBe(1)
  })

  it('skips payload cloning without listeners while maintaining snapshot sequence and state', () => {
    const emit = vi.fn()
    const observer = new TeamObservation('t', emit, () => false)
    observer.attach(member)
    observer.record({ kind: 'spawn-failed', member: 'lead', reason: 'setup',
      get code(): string { throw new Error('payload must not be read without listeners') } })
    expect(emit).not.toHaveBeenCalled()
    expect(observer.snapshot([member])).toMatchObject({ sequence: 1, members: [{ status: 'failed' }] })
  })

  it('preserves settlement wake precedence and upgrades a settlement when its report arrives', () => {
    const facts: TeamTimelineData[] = []
    const observer = new TeamObservation('t', event => facts.push(event))
    observer.attach(member)
    const port = observer.sessionOptions('lead', { observation: NOOP_OBSERVATION_PORT }).observation
    port.capture(observationEvent('sdk.model.call', 'start', 'initial'))
    observer.wake('lead', 'settlement')
    observer.wake('lead', 'host')
    port.capture(observationEvent('sdk.model.call', 'start', 'later'))
    expect(facts.filter(event => event.kind === 'wasted-wake')).toHaveLength(1)
    observer.attach({ ...member, name: 'w', role: 'peer' })
    const workerPort = observer.sessionOptions('w', { observation: NOOP_OBSERVATION_PORT }).observation
    workerPort.capture(observationEvent('sdk.agent.run', 'start', 'worker'))
    const outcome = { kind: 'completed' as const, text: 'result' }
    observer.outcome('w', outcome)
    const usage = { reported: { inputTokens: 10 }, authoritative: true, coverage: { logicalCalls: 1 } } as never
    observer.outcome('w', outcome, { runId: 'worker', usage })
    observer.outcome('w', outcome, { runId: 'worker', usage })
    expect(facts.filter(event => event.kind === 'worker-settled')).toHaveLength(2)
    expect(facts.filter(event => event.kind === 'worker-settled').at(-1)).toMatchObject({ runId: 'worker', usage })
  })

  it('commits no-op annotations with an explicit task even if the observer throws', async () => {
    const changed = vi.fn((_before, _after, _actor, change) => {
      expect(change.task.id).toBe('a')
      throw new Error('observer failed after commit')
    })
    const board = new CollaborationTaskBoard({}, { lead: 'lead', signal: new AbortController().signal,
      assertMember() {}, changed })
    await expect(board.create('lead', { id: 'a', title: 'task' })).resolves.toMatchObject({ revision: 1 })
    await expect(board.update('lead', { id: 'a', expectedRevision: 1, action: 'annotate', notes: '' }))
      .resolves.toMatchObject({ revision: 2 })
    expect(board.snapshot().tasks[0]?.revision).toBe(2)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('does not call an unrelated synthesis failure budget exhaustion', async () => {
    const facts: TeamTimelineData[] = []
    const team = new AgentTeam({ onEvent: event => {
      if (event.type === 'team-timeline') facts.push(event)
    } })
    vi.spyOn(team, 'whenIdle').mockResolvedValue()
    const wake = vi.spyOn(ManagedSynthesisGuard.prototype, 'wake').mockImplementation(() => {
      throw new Error('unrelated failure')
    })
    try {
      await expect(joinManagedTeam({ team, leadName: 'lead', settlements: { deliveredRevision: 0,
        hasPending: false, throwLeadFailure() {}, whenFlushed: async () => {} },
        workers: () => [], preparing: () => [], hasInputs: () => false, closing: () => [],
        needsSynthesis: () => true, joinMembers: async () => {}, joinCollaboration: () => undefined,
      } as never)).rejects.toThrow('unrelated failure')
      expect(facts.filter(event => event.kind === 'budget')).toEqual([])
    } finally { wake.mockRestore() }
  })

  it('uses the synthesis guard limit as the source of exhaustion', () => {
    const guard = new ManagedSynthesisGuard(0, 1)
    expect(guard.exhausted).toBe(false)
    guard.wake()
    expect(guard.used).toBe(1)
    expect(guard.limit).toBe(1)
    expect(guard.exhausted).toBe(true)
    expect(() => guard.wake()).toThrow('after 1 synthesis wakes')
    guard.observe(1, 0)
    expect(guard.exhausted).toBe(false)
  })
})
