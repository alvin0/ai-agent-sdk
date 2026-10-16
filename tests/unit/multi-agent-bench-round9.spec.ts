import { describe, expect, it } from 'vitest'
import type { ObservationEvent } from '@alvin0/ai-agent-sdk-core'
import { Collector } from '../../test-human/multi-agent-bench/metrics.ts'
import type { BenchTeamEvent } from '../../test-human/multi-agent-bench/team-events.ts'

const reported = { inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 5, outputTokens: 20 }
const usage = { reported, authoritative: true, coverage: { logicalCalls: 1 } }
const timeline = (sequence: number, kind: string, member: string,
  extra: Partial<BenchTeamEvent> = {}): BenchTeamEvent => ({
  type: 'team-timeline', schemaVersion: 1, teamId: 't', depth: 0, sequence, kind, member,
  occurredAt: '2026-10-16T00:00:00.000Z', elapsedMs: sequence, ...extra,
})

// Admission ordering/shapes from observability's managed-spawn.ts: assertSpawnAvailable
// records the request before the capacity check, then budget/refusal; acceptance is after
// startWorker. Run/usage facts come from team-observation.ts, not worker-settled projections.
const spawnFacts = [
  timeline(1, 'spawn-requested', 'fork-worker', { context: 'fork' }),
  timeline(2, 'member-started', 'fork-worker', { runId: 'fork-run',
    conversationId: 'fork-worker', activation: { source: 'initial' } }),
  timeline(3, 'spawn-accepted', 'fork-worker'),
  timeline(4, 'model-requested', 'fork-worker', { runId: 'fork-run', conversationId: 'fork-worker' }),
  timeline(5, 'spawn-requested', 'rejected-worker', { context: 'fork' }),
  { ...timeline(6, 'budget', 'lead', { limit: 1 }), budget: 'workers', action: 'exhausted' },
  timeline(7, 'spawn-rejected', 'rejected-worker', { reason: 'capacity', code: 'TEAM_WORKER_LIMIT',
    busy: 1, preparing: 0, limit: 1 }),
  { ...timeline(8, 'member-settled', 'fork-worker', { runId: 'fork-run', usage }),
    status: 'success', durationMs: 1 },
  { ...timeline(9, 'worker-settled', 'fork-worker', { runId: 'fork-run', usage }), status: 'completed' },
  timeline(10, 'slot-released', 'fork-worker'),
  timeline(11, 'spawn-requested', 'fresh-worker', { context: 'fresh' }),
  timeline(12, 'member-started', 'fresh-worker', { runId: 'fresh-run',
    conversationId: 'fresh-worker', activation: { source: 'initial' } }),
  timeline(13, 'spawn-accepted', 'fresh-worker'),
  timeline(14, 'model-requested', 'fresh-worker', { runId: 'fresh-run', conversationId: 'fresh-worker' }),
  { ...timeline(15, 'member-settled', 'fresh-worker', { runId: 'fresh-run', usage }),
    status: 'success', durationMs: 1 },
  { ...timeline(16, 'worker-settled', 'fresh-worker', { runId: 'fresh-run', usage }), status: 'completed' },
  timeline(17, 'slot-released', 'fresh-worker'),
]

function fallbackEvidence(collector: Collector) {
  collector.spawns = 2
  for (const [member, context, runId] of [
    ['fork-worker', 'fork', 'fork-run'], ['fresh-worker', 'fresh', 'fresh-run'],
  ] as const) {
    collector.delegation.resolved(member, context)
    collector.teamEvent({ type: 'member-attached', member: { name: member } })
    // Initial managed runs are observed through session checkpoints; queued attachments alone
    // do not count as running. Each worker finishes before the next starts (capacity = 1).
    collector.delegation.running(member)
    collector.delegation.settled(member)
    for (const phase of ['start', 'end']) collector.events.push({ member, event: {
      name: 'sdk.model.call', phase, correlation: { runId, modelCallId: runId, conversationId: member },
      data: phase === 'start' ? {} : { coverage: 'complete', reported },
    } as ObservationEvent })
  }
  collector.delegation.rejected('lead', { toolName: 'spawn_agent', callId: 'rejected' }, 'capacity')
}

describe('Round 9 delegation metric parity', () => {
  it('counts accepted fork/fresh spawns identically with the observability SDK sequence or fallback', () => {
    const fallback = new Collector(), canonical = new Collector()
    fallbackEvidence(fallback)
    fallbackEvidence(canonical)
    for (const fact of spawnFacts) canonical.teamEvent(fact)
    const inferred = fallback.metrics(1), observed = canonical.metrics(1)
    const expected = { spawns: 2, spawnsAccepted: 2, forkSpawns: 1, freshSpawns: 1,
      contextUnknownSpawns: 0, spawnAttempts: 3, spawnsRejected: 1, spawnRejectionReasons: { capacity: 1 },
      maxConcurrentWorkers: 1, delegated: true }
    expect(inferred).toMatchObject(expected)
    expect(observed).toMatchObject(expected)
    expect(observed.memberMetrics).toEqual(inferred.memberMetrics)
    expect(observed.memberMetrics).toHaveLength(2) // Refused worker has neither calls nor usage.
    expect(observed.memberUsage).toEqual(inferred.memberUsage)
    expect(observed.totalTokens).toBe(inferred.totalTokens)
    expect(observed.totalModelCalls).toBe(inferred.totalModelCalls)
    expect(observed.teamMetricsSource).toBe('timeline-v1')
    expect(inferred.teamMetricsSource).toBe('inferred')
    expect(observed.usageMetricsSource).toBe('team-ledger')
    expect(inferred.usageMetricsSource).toBe('model-events')
  })

  it('excludes rejected and unresolved requests from every accepted-context bucket', () => {
    const collector = new Collector()
    const facts = [
      timeline(1, 'spawn-rejected', 'invalid', { reason: 'invalid' }),
      timeline(2, 'spawn-rejected', 'aborted', { reason: 'aborted' }),
      timeline(3, 'spawn-requested', 'w', { context: 'fork' }),
      timeline(4, 'spawn-rejected', 'w', { reason: 'setup' }),
      timeline(5, 'spawn-requested', 'w', { context: 'fresh' }),
      timeline(6, 'spawn-accepted', 'w'),
      timeline(7, 'spawn-accepted', 'unknown'), // Missing request: accepted context is unknown.
      timeline(8, 'spawn-requested', 'pending', { context: 'fork' }),
    ]
    for (const fact of facts) collector.teamEvent(fact)
    expect(collector.metrics(0)).toMatchObject({ spawns: 2, spawnAttempts: 5, spawnsRejected: 3,
      forkSpawns: 0, freshSpawns: 1, contextUnknownSpawns: 1, maxConcurrentWorkers: 0 })
  })

  it('isolates pending contexts by team and preserves a preparing spawn after duplicate refusal', () => {
    const collector = new Collector()
    const facts = [
      timeline(1, 'spawn-requested', 'w', { context: 'fork' }),
      timeline(1, 'spawn-requested', 'w', { context: 'fresh', teamId: 'child', depth: 1 }),
      timeline(2, 'spawn-requested', 'w', { context: 'fresh' }),
      timeline(3, 'spawn-rejected', 'w', { reason: 'duplicate' }),
      timeline(4, 'spawn-accepted', 'w'),
      timeline(2, 'spawn-accepted', 'w', { teamId: 'child', depth: 1 }),
    ]
    // Sequence ordering and Collector's replay guard must preserve context matching too.
    for (const index of [0, 1, 2, 4, 3, 5, 4]) collector.teamEvent(facts[index])
    expect(collector.metrics(0)).toMatchObject({ spawns: 2, spawnAttempts: 3, spawnsRejected: 1,
      forkSpawns: 1, freshSpawns: 1, contextUnknownSpawns: 0 })
  })
})
