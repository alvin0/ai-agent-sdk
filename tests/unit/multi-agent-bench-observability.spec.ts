import { describe, expect, it } from 'vitest'
import type { ObservationEvent } from '@alvin0/ai-agent-sdk-core'
import { Collector } from '../../test-human/multi-agent-bench/metrics.ts'
import { execute } from '../../test-human/multi-agent-bench/execute.ts'

const event = (sequence: number, kind: string, extra: Record<string, unknown> = {}) => ({
  type: 'team-timeline', schemaVersion: 1, teamId: 't', depth: 0, sequence,
  occurredAt: '2026-10-16T00:00:00.000Z', elapsedMs: sequence, member: 'lead', kind,
  ...(kind === 'spawn-requested' ? { context: 'fresh' } : {}),
  ...(kind === 'spawn-rejected' ? { reason: 'capacity', code: 'TEAM_WORKER_LIMIT',
    busy: 1, preparing: 0, limit: 1 } : {}),
  ...(['member-started', 'member-settled', 'model-requested'].includes(kind) ? { runId: 'r' } : {}),
  ...(kind === 'member-started' ? { activation: { source: 'initial' } } : {}),
  ...(kind === 'member-settled' ? { status: 'success', durationMs: 1, usage: {
    reported: {}, authoritative: true, coverage: { logicalCalls: 0 },
  } } : {}),
  ...extra,
})

function model(collector: Collector, member: string, runId: string, conversationId = member) {
  for (const phase of ['start', 'end']) collector.events.push({ member, event: {
    name: 'sdk.model.call', phase, correlation: { runId, modelCallId: runId, conversationId },
    data: phase === 'start' ? {} : { coverage: 'complete', reported: {
      inputTokens: 100, cacheReadTokens: 50, outputTokens: 20, totalTokens: 170,
    } },
  } as ObservationEvent })
}

describe('benchmark team timeline adapter', () => {
  it('prefers SDK facts over fallback inference and ignores replayed event ids', () => {
    const collector = new Collector()
    collector.spawns = 10
    collector.requests.push({ member: 'lead', evidence: 'same', repeated: true })
    model(collector, 'lead', 'r1')
    model(collector, 'w', 'r2')
    collector.teamEvent(event(2, 'spawn-accepted', { member: 'w' }))
    collector.teamEvent(event(1, 'spawn-requested', { member: 'w' }))
    collector.teamEvent(event(1, 'spawn-requested', { member: 'w' }))
    collector.teamEvent(event(3, 'model-requested'))
    collector.teamEvent(event(4, 'model-requested', { member: 'w' }))
    expect(collector.metrics(0)).toMatchObject({ spawns: 1, spawnAttempts: 1, spawnsRejected: 0,
      wastedLeadTurns: 1, wastedWakes: 0,
      leadModelCalls: 1, totalModelCalls: 2 })
    collector.teamEvent(event(5, 'wasted-wake'))
    expect(collector.metrics(0)).toMatchObject({ wastedLeadTurns: 1, wastedWakes: 1 })
  })

  it('requires observed starts before preferring terminal usage and preserves partial coverage', () => {
    const collector = new Collector()
    model(collector, 'lead', 'r1')
    collector.teamEvent(event(1, 'model-requested'))
    collector.teamEvent(event(2, 'member-settled', { runId: 'run', usage: {
      reported: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      authoritative: false, coverage: { logicalCalls: 1 },
    } }))
    expect(collector.metrics(0)).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120,
      usageComplete: false, usageIncomplete: true, usageMetricsSource: 'team-ledger' })
  })

  it('keeps missing root-lead usage visible as null input and incomplete coverage', () => {
    const collector = new Collector()
    collector.events.push({ member: 'lead', event: { name: 'sdk.model.call', phase: 'start',
      correlation: { runId: 'r', modelCallId: 'm', conversationId: 'lead' }, data: {},
    } as ObservationEvent })
    expect(collector.metrics(0)).toMatchObject({ leadCallInputTokens: [null], usageIncomplete: true,
      callMetricsSource: 'model-events', usageMetricsSource: 'model-events' })
  })

  it('keeps the old-branch path when timeline events are unavailable or unsupported', () => {
    const collector = new Collector()
    collector.spawns = 2
    collector.requests.push({ member: 'lead', evidence: 'same', repeated: true })
    collector.teamEvent({ type: 'member-attached', member: { name: 'w' } })
    collector.teamEvent({ ...event(1, 'member-started'), schemaVersion: 2 })
    expect(collector.metrics(0)).toMatchObject({ spawns: 2, wastedLeadTurns: 1 })
  })

  it('consumes offline managed ledger usage, counts and zero empty wakes end to end', async () => {
    const { result, audit } = await execute({ provider: 'fake', model: 'scripted',
      task: 'code-change', arm: 'team', rep: 1, timeoutMs: 20000, suite: 'smoke' })
    expect(result.pass).toBe(true)
    const timeline = audit.teamEvents.some(event => event.type === 'team-timeline')
    expect(audit.teamEvents.some(event => event.kind === 'member-settled')).toBe(timeline)
    expect(audit.teamEvents.some(event => event.type === 'message-accepted'
      && event.message?.sender === 'lead')).toBe(true)
    expect(audit.teamEvents.some(event => event.kind === 'member-started')).toBe(timeline)
    expect(audit.teamEvents.some(event => event.kind === 'team-joined')).toBe(timeline)
    expect(result.metrics).toMatchObject({ spawns: 1, spawnAttempts: 1, spawnsRejected: 0,
      wastedLeadTurns: 0, usageComplete: true,
      teamMetricsSource: timeline ? 'timeline-v1' : 'inferred',
      usageMetricsSource: timeline ? 'team-ledger' : 'model-events' })
    expect(result.metrics.totalTokens).toBe(result.metrics.totalModelCalls * 120)
  })
  it('falls back on partial timelines and excludes a nested lead even when its name is lead', () => {
    const collector = new Collector()
    model(collector, 'lead', 'root', 'root-conversation')
    model(collector, 'lead', 'child', 'child-conversation')
    model(collector, 'w', 'worker')
    collector.teamEvent(event(1, 'model-requested', { conversationId: 'root-conversation' }))
    expect(collector.metrics(0)).toMatchObject({ leadModelCalls: 1, totalModelCalls: 3,
      usageMetricsSource: 'model-events', leadCallInputTokens: [150] })
    collector.teamEvent(event(2, 'model-requested', { member: 'w' }))
    collector.teamEvent(event(1, 'model-requested', { teamId: 'child', parentTeamId: 't', depth: 1,
      conversationId: 'child-conversation' }))
    expect(collector.metrics(0)).toMatchObject({ leadModelCalls: 1, totalModelCalls: 3,
      memberUsage: { lead: { calls: 1 }, workers: { calls: 2 } },
      memberMetrics: [{ member: 'lead', calls: 1, inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 },
        { member: 'lead', calls: 1 }, { member: 'w', calls: 1 }] })
  })

  it('counts accepted spawns separately from every rejection class', () => {
    const collector = new Collector()
    collector.teamEvent(event(1, 'spawn-requested', { member: 'w' }))
    collector.teamEvent(event(2, 'spawn-accepted', { member: 'w' }))
    collector.teamEvent(event(3, 'spawn-rejected', { member: 'bad', reason: 'invalid' }))
    collector.teamEvent(event(4, 'spawn-requested', { member: 'w' }))
    collector.teamEvent(event(5, 'spawn-rejected', { member: 'w', reason: 'duplicate' }))
    collector.teamEvent(event(6, 'spawn-requested', { member: 'over' }))
    collector.teamEvent(event(7, 'spawn-rejected', { member: 'over', reason: 'capacity' }))
    collector.teamEvent(event(8, 'spawn-requested', { member: 'setup' }))
    collector.teamEvent(event(9, 'spawn-rejected', { member: 'setup', reason: 'setup' }))
    collector.teamEvent(event(10, 'spawn-rejected', { member: 'cancelled', reason: 'aborted' }))
    const metrics = collector.metrics(0)
    expect(metrics).toMatchObject({ spawns: 1, spawnAttempts: 6, spawnsRejected: 5 })
    expect(metrics.spawns + metrics.spawnsRejected!).toBe(metrics.spawnAttempts)
  })

  it('uses only timeline acceptance, context and run concurrency despite conflicting legacy estimates', () => {
    const collector = new Collector()
    collector.spawns = 20
    collector.delegation.running('legacy')
    collector.delegation.rejected('lead', { toolName: 'spawn_agent', callId: 'bad' }, 'estimated error')
    const facts = [
      event(1, 'spawn-requested', { member: 'setup', context: 'fork' }),
      event(2, 'spawn-rejected', { member: 'setup', reason: 'setup', code: 'SETUP_FAILED' }),
      event(3, 'spawn-failed', { member: 'setup', reason: 'setup', code: 'SETUP_FAILED' }),
      event(4, 'spawn-requested', { member: 'a', context: 'fresh' }),
      event(5, 'spawn-accepted', { member: 'a' }),
      event(6, 'spawn-requested', { member: 'b', context: 'fork' }),
      event(7, 'spawn-accepted', { member: 'b' }),
      event(8, 'member-started', { member: 'a', runId: 'a1' }),
      event(9, 'member-started', { member: 'b', runId: 'b1' }),
      event(10, 'member-settled', { member: 'a', runId: 'a1' }),
      event(11, 'member-settled', { member: 'b', runId: 'b1' }),
      event(12, 'slot-released', { member: 'a' }),
      event(13, 'lead-returned', { busy: 0, preparing: 0 }),
      event(14, 'team-joined', { busy: 0, preparing: 0 }),
    ]
    // Observer reentry delivered a settlement ahead of an earlier start; replay is harmless.
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 9, 8, 10, 11, 12, 13, 1]) collector.teamEvent(facts[index])
    expect(collector.metrics(0)).toMatchObject({ teamMetricsSource: 'timeline-v1',
      spawns: 2, spawnsAccepted: 2, spawnsRejected: 1, spawnAttempts: 3,
      spawnRejectionReasons: { setup: 1 }, forkSpawns: 2, freshSpawns: 1,
      maxConcurrentWorkers: 2, delegated: true })
    const audit = JSON.parse(JSON.stringify(collector))
    expect(audit.teamEvents).toHaveLength(facts.length)
    expect(audit.delegation.teamEvents).toBeUndefined()
    expect(audit.delegation.timelineEvents).toBeUndefined()
    expect(audit.teamEvents[1]).toMatchObject({ type: 'team-timeline', kind: 'spawn-rejected',
      reason: 'setup', code: 'SETUP_FAILED', busy: 1, preparing: 0, limit: 1 })
  })

  it('does not sum worker settlement projections with finalized ledger usage', () => {
    const collector = new Collector()
    model(collector, 'lead', 'r1')
    model(collector, 'w', 'r2')
    collector.teamEvent(event(1, 'model-requested', { runId: 'r1' }))
    collector.teamEvent(event(2, 'model-requested', { member: 'w', runId: 'r2' }))
    const usage = { reported: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20, totalTokens: 170 },
      authoritative: true, coverage: { logicalCalls: 1 } }
    collector.teamEvent(event(3, 'member-settled', { runId: 'r1', usage }))
    collector.teamEvent(event(4, 'member-settled', { member: 'w', runId: 'r2', usage }))
    collector.teamEvent(event(5, 'worker-settled', { member: 'w', runId: 'r2', usage }))
    expect(collector.metrics(0)).toMatchObject({ usageMetricsSource: 'team-ledger', totalTokens: 340,
      usageComplete: true, memberUsage: { lead: { calls: 1 }, workers: { calls: 1 } },
      leadCallInputTokens: [150] })
  })

  it('retains content-free member-run and accepted-message audit metadata', () => {
    const collector = new Collector()
    collector.rootTeamId = 't'
    collector.teamEvent({ type: 'member-run-start', member: 'w' })
    collector.teamEvent({ type: 'member-run-end', member: 'w', response: {
      text: 'private response', report: { runId: 'r' }, outcome: { yielded: false },
    } })
    collector.teamEvent({ type: 'message-accepted', message: { id: 'm', teamId: 't', sender: 'lead',
      target: 'w', delivery: 'wakeup', createdAt: 'now', content: ['private task'] } })
    expect(collector.teamEvents).toMatchObject([
      { type: 'member-run-start', member: 'w' }, { type: 'member-run-end', member: 'w', runId: 'r', yielded: false },
      { type: 'message-accepted', message: { sender: 'lead', target: 'w', delivery: 'wakeup' } },
    ])
    expect(JSON.stringify(collector.teamEvents)).not.toContain('private')
  })

  it('exposes no-spawn lead costs in result JSON without reading audit observations', async () => {
    for (const arm of ['single', 'team'] as const) {
      const { result } = await execute({ provider: 'fake', model: 'scripted',
        task: 'sequential', arm, rep: 1, timeoutMs: 20000, suite: 'smoke' })
      expect(result.pass).toBe(true)
      const metrics = JSON.parse(JSON.stringify(result.metrics))
      expect(metrics.spawns).toBe(0)
      expect(metrics.memberMetrics).toHaveLength(1)
      expect(metrics.memberMetrics[0]).toMatchObject({ member: 'lead', calls: metrics.leadModelCalls,
        inputTokens: metrics.inputTokens, cachedInputTokens: metrics.cachedInputTokens,
        outputTokens: metrics.outputTokens })
      expect(metrics.leadCallInputTokens).toHaveLength(metrics.leadModelCalls)
      expect(metrics.leadCallInputTokens.every((tokens: number) => tokens > 0)).toBe(true)
    }
  })

})
