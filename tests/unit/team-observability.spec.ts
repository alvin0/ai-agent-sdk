import { teamInternals } from '../../packages/core/src/agent/team/team-internal.ts'
import { createCoreSpan as internalSpan, type ObservationEvent as InternalEvent } from '../../packages/core/src/observation/index.ts'
import { TeamObservation } from '../../packages/core/src/agent/team/team-observation.ts'
import { describe, expect, it, vi } from 'vitest'
import { createCoreSpan, ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { AgentTeamEvent, TeamTimelineEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { create, deferred, GatedTeam, tool } from './team-push-join.fixture.ts'

const timeline = (events: readonly AgentTeamEvent[]) => events.filter(
  (event): event is TeamTimelineEvent => event.type === 'team-timeline')

class UsageTeam extends GatedTeam {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    for await (const chunk of super.stream(options)) {
      if (chunk.type === 'finish') yield { type: 'usage', usage: {
        inputTokens: 10, outputTokens: 2, totalTokens: 12,
      } }
      yield chunk
    }
  }
}

describe('host team timeline and snapshots', () => {
  it('reports real lifecycle boundaries with no periodic calls and immutable content-free metadata', async () => {
    const privateTask = 'PRIVATE/team-observability-lead-task-6b21'
    const privateFinding = 'PRIVATE/team-observability-worker-finding-9e2c'
    const adapter = new UsageTeam()
    adapter.workerText = privateFinding
    const events: AgentTeamEvent[] = []
    const subscribed: AgentTeamEvent[] = []
    const team = create(adapter, { team: { onEvent: event => {
      events.push(event)
      if (event.type === 'team-timeline') throw new Error('observer failed')
    } } })
    const unsubscribe = team.team.subscribe(event => subscribed.push(event))
    const running = team.run(privateTask)
    await vi.waitFor(() => expect(timeline(events).some(event => event.kind === 'lead-yielded')).toBe(true))
    const calls = adapter.leadRequests.length
    expect(team.snapshot().members.find(member => member.name === 'w')).toMatchObject({ status: 'running', runs: 1 })
    expect(adapter.leadRequests).toHaveLength(calls)
    adapter.gates.get('w')!.resolve()
    expect((await running).text).toBe('synthesis')
    const facts = timeline(events)
    expect(facts.map(event => event.sequence)).toEqual(facts.map((_, index) => index + 1))
    expect(timeline(subscribed)).toEqual(facts)
    expect(facts.filter(event => event.kind === 'worker-settled')).toHaveLength(1)
    expect(facts.find(event => event.kind === 'worker-settled')).toMatchObject({
      member: 'w', status: 'completed', usage: { authoritative: true, reported: { totalTokens: 12 } },
    })
    expect(facts.filter(event => event.kind === 'notice-delivered')).toHaveLength(1)
    expect(facts.some(event => event.kind === 'lead-woken' && event.reason === 'settlement')).toBe(true)
    expect(facts.filter(event => event.kind === 'wasted-wake')).toHaveLength(0)
    const snapshot = team.snapshot()
    expect(snapshot.members.find(member => member.name === 'w')).toMatchObject({
      status: 'completed', activeRuns: 0, modelCalls: 1, usage: { reported: { totalTokens: 12 } },
    })
    expect(Object.isFrozen(snapshot.members)).toBe(true)
    expect(Object.isFrozen(snapshot.members[0]?.usage?.reported)).toBe(true)
    expect(JSON.stringify(facts)).not.toContain(privateTask)
    expect(JSON.stringify(facts)).not.toContain(privateFinding)
    expect(Object.isFrozen(facts[0])).toBe(true)
    unsubscribe()
  })

  it('publishes settlement metadata after an active join has claimed its result', async () => {
    const adapter = new GatedTeam()
    adapter.join = true
    const claims: unknown[] = []
    const team = create(adapter, { team: { onEvent: event => {
      if (event.type === 'team-timeline' && event.kind === 'worker-settled') {
        claims.push(...teamInternals(team.team).takeResults('lead', ['w']))
      }
    } } })
    const capture = vi.spyOn(team.team, 'captureResults')
    const running = team.run('Research')
    await vi.waitFor(() => expect(capture).toHaveBeenCalled())
    adapter.gates.get('w')!.resolve()
    expect((await running).text).toBe('synthesis')
    expect(claims).toEqual([])
  })

  it('detects empty synthesis wakes and reports the existing retry budget', async () => {
    const events: AgentTeamEvent[] = []
    const adapter = new GatedTeam()
    const team = create(adapter, { team: { onEvent: event => events.push(event) },
      leadSessionOptions: { hooks: { onTurnEnd: () => ({ kind: 'yield' }) } } })
    const running = team.run('Research')
    const rejected = expect(running).rejects.toThrow('yielded after 3 synthesis wakes')
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    adapter.gates.get('w')!.resolve()
    await rejected
    expect(timeline(events).filter(event => event.kind === 'wasted-wake')).toHaveLength(3)
    expect(timeline(events).find(event => event.kind === 'budget' && event.budget === 'synthesis'))
      .toMatchObject({ action: 'exhausted', used: 3, limit: 3 })
  })

  it('adds usage once across managed inputs and scheduler follow-ups while preserving host observers', async () => {
    const events: AgentTeamEvent[] = []
    const capture = vi.fn(event => ({ eventId: event.eventId, status: 'accepted' as const,
      durable: false, boundary: 'none' as const }))
    const checkpoint = vi.fn()
    const adapter = new UsageTeam()
    adapter.gates.get('w')!.resolve()
    const team = create(adapter, { autoLeadCoordination: false, modelToolSurface: 'lean',
      team: { onEvent: event => events.push(event) }, workerSessionOptions: { observation: { mode: 'operational', openSpan: createCoreSpan, capture },
        hooks: { checkpoint } } })
    await team.spawn({ name: 'w', task: 'worker task' })
    await team.awaitWorker('w')
    await team.team.followup('lead', 'w', 'host follow-up')
    await team.whenQuiet()
    const send = team.lead.options.team!.team.toolsFor('lead').find(tool => tool.name === 'send_input')!
    await send.execute(send.parse!({ target: 'w', message: 'model follow-up' }),
      { signal: new AbortController().signal } as never)
    await team.whenQuiet()
    expect(capture).toHaveBeenCalled()
    expect(checkpoint).toHaveBeenCalled()
    expect(timeline(events).filter(event => event.kind === 'worker-settled')).toHaveLength(3)
    expect(team.snapshot().members.find(member => member.name === 'w')).toMatchObject({
      runs: 3, modelCalls: 3, activeRuns: 0, usage: { reported: { totalTokens: 36 }, authoritative: true },
    })
    expect(timeline(events).filter(event => event.kind === 'member-settled')).toHaveLength(3)
    expect(timeline(events).filter(event => event.kind === 'member-started' && event.member === 'w').at(-1))
      .toMatchObject({ activation: { source: 'follow-up', sender: 'lead' } })
  })

  it('keeps timeout status and missing usage explicit', async () => {
    const events: AgentTeamEvent[] = []
    const team = create(new GatedTeam(), { autoLeadCoordination: false, workerTimeoutMs: 25,
      team: { onEvent: event => events.push(event) } })
    await team.spawn({ name: 'w', task: 'blocked task' })
    await team.awaitWorker('w')
    expect(timeline(events).find(event => event.kind === 'worker-settled')).toMatchObject({
      status: 'timeout', usage: { authoritative: false },
    })
    expect(team.snapshot().members.find(member => member.name === 'w')?.status).toBe('timeout')
  })

  it('reports held and reactivated cancellation once without reusing old usage', async () => {
    const events: AgentTeamEvent[] = []
    const adapter = new UsageTeam()
    const team = create(adapter, { autoLeadCoordination: false, team: { onEvent: event => events.push(event) } })
    await team.spawn({ name: 'w', task: 'task' })
    await team.spawn({ name: 'held', task: 'dependent', dependsOn: ['w'] })
    expect(team.snapshot().members.find(member => member.name === 'held')?.status).toBe('pending')
    await team.closeWorker('held')
    expect(timeline(events).find(event => event.kind === 'worker-settled' && event.member === 'held'))
      .toMatchObject({ status: 'cancelled' })
    expect(timeline(events).find(event => event.kind === 'worker-settled' && event.member === 'held'))
      .not.toHaveProperty('usage')
    adapter.gates.get('w')!.resolve()
    await team.awaitWorker('w')
    adapter.gates.set('w', deferred())
    await team.team.followup('lead', 'w', 'new blocked task')
    await vi.waitFor(() => expect(adapter.rounds.get('w')).toBe(2))
    await team.closeWorker('w')
    const settled = timeline(events).filter((event): event is Extract<TeamTimelineEvent, { kind: 'worker-settled' }> =>
      event.kind === 'worker-settled' && event.member === 'w')
    expect(settled).toHaveLength(2)
    expect(settled.map(event => event.status)).toEqual(['completed', 'cancelled'])
    expect(settled[1]?.usage?.reported.totalTokens ?? 0).toBe(0)
  })

  it('preserves audit capture/checkpoint return values and absent checkpoint policy', async () => {
    const observation = new TeamObservation('test', () => {})
    const receipt = { eventId: 'test', status: 'accepted' as const, durable: true,
      boundary: 'local-durable' as const }
    const capture = vi.fn((_event: InternalEvent) => receipt)
    const checkpoint = vi.fn(async (_event: InternalEvent) => receipt)
    const options = observation.sessionOptions('lead', { registry: new ModelRegistry(), observation: {
      mode: 'audit', openSpan: internalSpan, capture, checkpoint,
    } })
    const event = { name: 'sdk.log', correlation: { runId: 'test' } } as never
    expect(options.observation.capture(event)).toBe(receipt)
    expect(await options.observation.checkpoint!(event)).toBe(receipt)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(checkpoint).toHaveBeenCalledTimes(1)
    const without = observation.sessionOptions('lead', { registry: new ModelRegistry(), observation: {
      mode: 'audit', openSpan: internalSpan, capture,
    } })
    expect(without.observation).not.toHaveProperty('checkpoint')
  })

  it('retains failed setup metadata after a prepared session is detached', async () => {
    const events: AgentTeamEvent[] = []
    const team = create(new GatedTeam(), { autoLeadCoordination: false,
      team: { maxMessages: 1, mailboxOverflow: 'reject', onEvent: event => events.push(event) } })
    await team.spawn({ name: 'w', task: 'task' })
    await expect(team.spawn({ name: 'setup-failure', task: 'over mailbox capacity' })).rejects.toThrow()
    expect(timeline(events).some(event => event.kind === 'spawn-failed' && event.member === 'setup-failure')).toBe(true)
    expect(team.snapshot().members.find(member => member.name === 'setup-failure')).toMatchObject({
      status: 'failed', attached: false, runs: 0,
    })
  })

  it('observes fallback injection without changing once-only notice delivery', async () => {
    const events: AgentTeamEvent[] = []
    const adapter = new GatedTeam()
    adapter.gates.get('w')!.resolve()
    const team = create(adapter, { autoLeadCoordination: false,
      team: { maxMessages: 1, mailboxOverflow: 'reject', onEvent: event => events.push(event) } })
    await team.spawn({ name: 'w', task: 'task' })
    await team.awaitWorker('w')
    expect(timeline(events).filter(event => event.kind === 'notice-delivered')).toMatchObject([
      { delivery: 'injection', workers: ['w'] },
    ])
    await team.whenQuiet()
    expect(timeline(events).filter(event => event.kind === 'notice-delivered')).toHaveLength(1)
    expect((await tool(team, 'wait_agents', { targets: ['w'] })).results).toEqual([])
  })

  it('records committed board operations and peer/worker budget exhaustion', async () => {
    const privateTitle = 'PRIVATE/team-observability-board-title-8d43'
    const privateNotes = 'PRIVATE/team-observability-board-notes-3f17'
    const privateResult = 'PRIVATE/team-observability-board-result-5a69'
    const events: AgentTeamEvent[] = []
    const adapter = new GatedTeam()
    const team = create(adapter, { autoLeadCoordination: false, maxWorkers: 1,
      collaboration: { maxPeerTurnsPerPair: 1 }, team: { onEvent: event => events.push(event) } })
    await team.spawn({ name: 'w', task: 'task' })
    await expect(team.spawn({ name: 'other', task: 'overflow' })).rejects.toThrow('limit')
    const board = team.collaboration!.board
    await board.create('lead', { id: 't', title: privateTitle, notes: privateNotes })
    await board.update('w', { id: 't', expectedRevision: 1, action: 'claim' })
    await expect(board.update('w', { id: 't', expectedRevision: 1, action: 'complete' })).rejects.toThrow()
    await board.update('w', { id: 't', expectedRevision: 2, action: 'complete', result: privateResult })
    await team.collaboration!.send('lead', 'w', 'context')
    await expect(team.collaboration!.send('lead', 'w', 'again')).rejects.toThrow('peer turn limit')
    expect(timeline(events).filter(event => event.kind === 'board-operation').map(event => event.operation))
      .toEqual(['create', 'claim', 'complete'])
    expect(timeline(events).filter(event => event.kind === 'budget')).toEqual(expect.arrayContaining([
      expect.objectContaining({ budget: 'workers', action: 'exhausted' }),
      expect.objectContaining({ budget: 'peer-turns', action: 'consumed', used: 1 }),
      expect.objectContaining({ budget: 'peer-turns', action: 'exhausted', limit: 1 }),
    ]))
    expect(JSON.stringify(timeline(events))).not.toContain(privateTitle)
    expect(JSON.stringify(timeline(events))).not.toContain(privateNotes)
    expect(JSON.stringify(timeline(events))).not.toContain(privateResult)
    adapter.gates.get('w')!.resolve()
    await team.whenQuiet()
  })
})
