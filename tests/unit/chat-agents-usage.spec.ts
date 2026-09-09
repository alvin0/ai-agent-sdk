import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'

process.env.CHAT_AGENTS_DB = join(mkdtempSync(join(tmpdir(), 'usage-')), 'chat-agents.db')

const { addToTally, recordUsage, turnShortfall, usageOf, usageSummary } =
  await import('../../samples/chat-agents/backend/src/usage.ts')

type Tally = ReturnType<typeof makeTally>
function makeTally() {
  return new Map<string, Record<string, number>>() as never
}

/** A turn-end event carrying what the SDK's own accounting reported. */
function turnEnd(reported: Record<string, number>): AgentRunEvent {
  return {
    type: 'turn-end',
    outcome: {
      reason: { kind: 'completed' },
      text: 'done',
      steps: 1,
      toolCalls: 0,
      traceId: 't',
      usageReport: { reported, coverage: {}, authoritative: true },
    },
    trace: { traceId: 't', spanId: 's', parentSpanId: null },
  } as unknown as AgentRunEvent
}

function usageEvent(usage: Record<string, number>): AgentRunEvent {
  return { type: 'usage', usage, trace: { traceId: 't', spanId: 's', parentSpanId: null } } as unknown as AgentRunEvent
}

/** Replays what `runPrompt` does with one run's events, in its own project. */
async function replay(group: string, events: readonly AgentRunEvent[]): Promise<void> {
  // One project per case: the store is shared and additive, exactly as it is
  // in the app.
  const context = {
    conversationId: `c-${group}`, groupId: group, runId: `r-${group}`,
    provider: 'codex', model: 'gpt-5.6-luna', effort: 'high',
  }
  const tally: Tally = makeTally()
  for (const event of events) {
    const streamed = usageOf(event)
    if (streamed !== undefined) {
      addToTally(tally, undefined, streamed)
      await recordUsage(streamed, context)
    }
    await recordUsage(turnShortfall(event, tally), context)
  }
}

describe('chat-agents usage accounting', () => {
  it('counts a provider that only reports when the turn ends', async () => {
    // The reported failure: a whole day of real runs and the Usage tab showed
    // zero, because the only source was a per-call event this route never
    // emits.
    await replay('only-at-end', [turnEnd({ inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 50 })])

    const summary = await usageSummary('only-at-end')
    expect(summary.totals).toMatchObject({
      inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 50, totalTokens: 1_250,
    })
  })

  it('does not double count a provider that streams its counters', async () => {
    await replay('streamed', [
      usageEvent({ inputTokens: 600, outputTokens: 100 }),
      usageEvent({ inputTokens: 400, outputTokens: 100 }),
      // The turn's report is the same tokens seen a second time, not more.
      turnEnd({ inputTokens: 1_000, outputTokens: 200 }),
    ])

    const summary = await usageSummary('streamed')
    expect(summary.totals).toMatchObject({ inputTokens: 1_000, outputTokens: 200 })
  })

  it('records only what the streamed events missed', async () => {
    await replay('partial', [
      usageEvent({ inputTokens: 600, outputTokens: 100 }),
      // The route reported one call and then went quiet; the turn's report
      // still has the whole thing.
      turnEnd({ inputTokens: 1_000, outputTokens: 250, reasoningTokens: 80 }),
    ])

    const summary = await usageSummary('partial')
    expect(summary.totals).toMatchObject({
      inputTokens: 1_000, outputTokens: 250, reasoningTokens: 80,
    })
    // Two rows: what streamed, and the remainder the turn's report added.
    expect(summary.totals.calls).toBe(2)
  })

  it('starts a fresh tally for each turn', async () => {
    // A run has many turns. Carrying one turn's streamed counters into the next
    // made the next turn's report look like tokens already counted, and a turn
    // the provider only reported at the end was swallowed whole.
    await replay('two-turns', [
      usageEvent({ inputTokens: 500, outputTokens: 100 }),
      turnEnd({ inputTokens: 500, outputTokens: 100 }),
      // Second turn: the route went quiet and only reported at the end.
      turnEnd({ inputTokens: 300, outputTokens: 60 }),
    ])

    const summary = await usageSummary('two-turns')
    expect(summary.totals).toMatchObject({ inputTokens: 800, outputTokens: 160 })
  })

  it('counts nothing when the provider reported nothing', async () => {
    // An honest zero. Estimates are flagged as estimates by the SDK, and
    // presenting one as a measurement would be worse than an empty table.
    await replay('silent', [turnEnd({})])
    expect((await usageSummary('silent')).totals.totalTokens).toBe(0)
  })
})
