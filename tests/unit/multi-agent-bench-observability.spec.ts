import { describe, expect, it } from 'vitest'
import { Collector } from '../../test-human/multi-agent-bench/metrics.ts'
import { execute } from '../../test-human/multi-agent-bench/execute.ts'

const event = (sequence: number, kind: string, extra: Record<string, unknown> = {}) => ({
  type: 'team-timeline', schemaVersion: 1, teamId: 't', sequence, member: 'lead', kind, ...extra,
})

describe('benchmark team timeline adapter', () => {
  it('prefers SDK facts over fallback inference and ignores replayed event ids', () => {
    const collector = new Collector()
    collector.spawns = 10
    collector.requests.push({ member: 'lead', evidence: 'same', repeated: true })
    collector.teamEvent(event(1, 'member-started'))
    collector.teamEvent(event(2, 'spawn-requested', { member: 'w' }))
    collector.teamEvent(event(2, 'spawn-requested', { member: 'w' }))
    collector.teamEvent(event(3, 'model-requested'))
    collector.teamEvent(event(4, 'model-requested', { member: 'w' }))
    expect(collector.metrics(0)).toMatchObject({ spawns: 1, wastedLeadTurns: 0,
      leadModelCalls: 1, totalModelCalls: 2 })
    collector.teamEvent(event(5, 'wasted-wake'))
    expect(collector.metrics(0).wastedLeadTurns).toBe(1)
  })

  it('can account from terminal team events alone without treating missing coverage as complete', () => {
    const collector = new Collector()
    collector.teamEvent(event(1, 'model-requested'))
    collector.teamEvent(event(2, 'member-settled', { runId: 'run', usage: {
      reported: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      authoritative: false, coverage: { logicalCalls: 1 },
    } }))
    expect(collector.metrics(0)).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120,
      usageComplete: false, usageIncomplete: true, usageMetricsSource: 'team-ledger' })
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
    expect(audit.teamEvents.some(event => event.kind === 'member-settled')).toBe(true)
    expect(result.metrics).toMatchObject({ spawns: 1, wastedLeadTurns: 0, usageComplete: true,
      teamMetricsSource: 'timeline-v1', usageMetricsSource: 'team-ledger' })
    expect(result.metrics.totalTokens).toBe(result.metrics.totalModelCalls * 120)
  })
})
