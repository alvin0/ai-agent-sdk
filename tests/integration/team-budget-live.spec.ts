import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { createManagedAgentTeam, defineAgent, defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { codexNodeAdapter } from '@alvin0/ai-agent-sdk-auth-node/codex'

const model = process.env.CHAT_AGENTS_LIVE_MODEL ?? 'gpt-reserve'
const output = resolve('samples/chat-agents/.data/live-budget', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(output, { recursive: true })
const cases = ['medium', 'high', 'max'].flatMap(effort => [1, 2].map(repeat => ({ effort, repeat })))

describe('live worker budget finalization', () => {
  it.each(cases)('$effort / repeat $repeat', async ({ effort, repeat }) => {
    const registry = new ModelRegistry()
    registry.registerAdapter(['codex'], codexNodeAdapter())
    const events: AgentRunEvent[] = []
    let indexRead = false
    const team = createManagedAgentTeam({
      registry,
      lead: defineAgent({ id: 'lead', provider: 'codex', model, effort, mode: 'basic',
        instructions: 'Summarize the supplied worker report, stating whether it is complete. Do not delegate or use tools.',
      }),
      workerTemplate: defineAgent({ id: 'worker', provider: 'codex', model, effort, mode: 'deep', maxTurns: 2,
        instructions: 'Use read_evidence to read index first, then details using the returned key. Read the actual data before answering. These are synthetic fixtures. Preserve numeric findings in your final report even if your work is interrupted.',
        tools: [defineTool({
          name: 'read_evidence', description: 'Read index to obtain the details access key, then read details in a later call.',
          parameters: { type: 'object', properties: { document: { type: 'string', enum: ['index', 'details'] }, key: { type: 'string' } }, required: ['document'], additionalProperties: false },
          execute: raw => {
            const args = raw as { document: string; key?: string }
            if (args.document === 'index') { indexRead = true; return { next: 'details', key: 'fixture-47', observed: 100 } }
            if (!indexRead || args.key !== 'fixture-47') throw new Error('Read index first for the details key')
            return { observed: 120, baseline: 100, increase: '20%', forecast: '2026-10 not yet observed' }
          },
        })],
      }),
      workerSessionOptions: { runtimeLimits: { onExhausted: 'continue' } },
      onWorkerEvent: (_name, event) => { events.push(event) },
    })
    const start = Date.now()
    try {
      await team.spawn({ name: 'bounded', task: 'Read both evidence documents in order, calculate the percentage increase, distinguish the October 2026 forecast, and report findings. Do not guess the details key.' })
      const report = await team.awaitWorker('bounded', { timeoutMs: 600_000 })
      const terminal = events.findLast(e => e.type === 'agent-end')
      const outcome = terminal?.type === 'agent-end' ? terminal.outcome : undefined
      const lead = await team.lead.run('Summarize the worker evidence in under 100 words. Preserve the calculated percentage increase and label incomplete work honestly.')
      const checks = {
        report: (report?.text.trim().length ?? 0) >= 60,
        finalizer: outcome?.reason.kind === 'budget-exhausted' && outcome.reason.forcedFinalAnswer === true,
        bounded: outcome?.steps === 3,
        // A math block may render the same percentage as 20\% in LaTeX.
        evidence: /\b20\s*%/.test((report?.text ?? '').replaceAll('\\', ''))
          && /\b20\s*%/.test(lead.text.replaceAll('\\', '')),
        leadAnswer: lead.text.trim().length >= 60,
      }
      const id = `${effort}-${repeat}`
      writeFileSync(join(output, `${id}.json`), JSON.stringify({ id, model, durationMs: Date.now() - start, checks, report, lead: lead.text, outcome }, null, 2))
      console.log(JSON.stringify({ id, checks }))
      expect(Object.values(checks).every(Boolean)).toBe(true)
    } finally { await team.dispose() }
  }, 900_000)
})
