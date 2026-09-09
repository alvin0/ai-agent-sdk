import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { defineAgent } from '@ai-agent-sdk/core/agent'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import { codexNodeAdapter } from '@ai-agent-sdk/auth-node/codex'

describe('live current-run self-check', () => {
  it.each(['medium', 'high', 'max'])('%s', async effort => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['codex'], codexNodeAdapter())
    const model = process.env.CHAT_AGENTS_LIVE_MODEL ?? 'gpt-reserve'
    const session = defineAgent({ id: 'analyst', provider: 'codex', model, effort, mode: 'deep', maxTurns: 8,
      compaction: false, instructions: 'Analyze the supplied synthetic numbers. Give a concise final report after the required self-check. Do not delegate. Each response must be under 100 words.',
    }).createSession({ registry })
    const first = await session.run('Synthetic revenue: 100 USD plus 200 EUR, exchange rate 1.2 USD/EUR. Calculate total USD.')
    expect(first.outcome.completed).toBe(true)
    const events: AgentRunEvent[] = []
    const handle = session.stream('Follow-up: change only the exchange rate to 1.3 USD/EUR. Recheck the total and report the revised result, even though the earlier report was already accepted.')
    for await (const event of handle) if (event.type !== 'reasoning-delta' && event.type !== 'assistant-reasoning') events.push(event)
    const result = await handle.result
    const output = resolve('samples/chat-agents/.data/live-followup')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, `${new Date().toISOString().replaceAll(':', '-')}-${effort}.json`),
      JSON.stringify({ model, effort, first: first.text, final: result.text, outcome: result.outcome,
        submissions: events.filter(e => e.type === 'tool-call' && e.call.toolName === 'submit_result').length }, null, 2))
    expect(result.outcome.completed).toBe(true)
    expect(result.outcome.steps).toBeLessThanOrEqual(4)
    expect(result.text).toMatch(/360/)
    expect(events.filter(e => e.type === 'tool-call' && e.call.toolName === 'submit_result')).toHaveLength(1)
  }, 180_000)
})
