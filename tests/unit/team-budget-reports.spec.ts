import { describe, expect, it } from 'vitest'
import { createManagedAgentTeam, defineAgent, defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'

const scenarios = {
  research: 'Compare energy storage sources: dated observations available; October forecast unverified.',
  coding: 'Review pagination: duplicate cursor reproduced; patch and integration test still pending.',
  analysis: 'Reconcile quarterly revenue: missing rows identified and source totals verified.',
} as const

const answer = (text: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const call = (id: string, name: string, args: unknown): StreamChunk[] => [
  { type: 'block-end', index: 0, block: {
    type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args),
  } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

class ReportAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly rounds = new Map<string, number>()
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, reasoning: {
      efforts: ['medium', 'high', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })),
      defaultEffort: ReasoningEffortId('medium'),
    } })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const scenario = Object.keys(scenarios).find(key => options.system?.includes(`CASE:${key}`)) as keyof typeof scenarios | undefined
    if (scenario === undefined) {
      yield* answer('Synthesis: research forecast unverified; coding patch pending; revenue reconciled.')
      return
    }
    const round = (this.rounds.get(scenario) ?? 0) + 1
    this.rounds.set(scenario, round)
    if (round === 1) {
      yield* call(`${scenario}-inspect`, 'inspect_evidence', { topic: scenario, page: 1 })
    } else if (scenario === 'coding') {
      yield* answer(scenarios.coding).slice(0, -1)
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SOURCE_UNAVAILABLE', message: 'test service unavailable' } } }
    } else if (round === 2) {
      yield* scenario === 'analysis'
        ? call('analysis-submit', 'submit_result', { summary: scenarios.analysis, evidence: ['source totals checked'] })
        : call('research-next', 'inspect_evidence', { topic: scenario, page: 2 })
    } else {
      yield* answer(scenarios[scenario])
    }
  }
}

describe('research, coding and analysis reports at execution limits', () => {
  it.each(['medium', 'high', 'max'])('preserves evidence and distinguishes partial work (%s)', async effort => {
    const adapter = new ReportAdapter()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const team = createManagedAgentTeam({
      registry,
      lead: defineAgent({ id: 'lead', provider: 'test', model: 'reports', mode: 'basic', effort,
        instructions: 'Synthesize worker reports, preserving limitations.',
      }),
      workerFactory: request => defineAgent({
        id: request.name, provider: 'test', model: 'reports', effort, mode: 'deep', maxTurns: 2,
        instructions: `CASE:${request.name}`,
        tools: [defineTool({
          name: 'inspect_evidence', description: 'Read fixture evidence.', parameters: { type: 'object' },
          execute: () => ({ evidence: 'fixture source read', verified: true }),
        })],
      }),
      workerSessionOptions: { runtimeLimits: { onExhausted: 'continue' } },
    })
    try {
      for (const [name, task] of Object.entries(scenarios)) {
        await team.spawn({ name, task, ...(name === 'analysis' ? { dependsOn: ['coding'] } : {}) })
      }
      for (const name of Object.keys(scenarios)) await team.awaitWorker(name)
      expect(team.workers().find(w => w.name === 'research')).toMatchObject({
        status: 'failed', result: { text: scenarios.research, succeeded: false },
      })
      expect(team.workers().find(w => w.name === 'coding')).toMatchObject({
        status: 'failed', result: { text: scenarios.coding, succeeded: false },
      })
      expect(team.workers().find(w => w.name === 'analysis')).toMatchObject({
        status: 'completed', result: { text: scenarios.analysis, succeeded: true },
      })
      const final = await team.lead.run('Synthesize all three investigations and list unfinished work.')
      expect(final.text).toContain('Synthesis:')
      const request = adapter.requests.at(-1)!
      for (const evidence of Object.values(scenarios)) expect(JSON.stringify(request.messages)).toContain(evidence)
      expect(JSON.stringify(request.messages)).toContain('Partial findings (not a completed task)')
      const analysis = adapter.requests.filter(r => r.system?.includes('CASE:analysis'))
      expect(analysis).toHaveLength(3)
      expect(JSON.stringify(analysis[0]?.messages)).toContain(scenarios.coding)
      expect(JSON.stringify(analysis[0]?.messages)).toContain('FAILED:')
      expect(analysis.at(-1)?.toolChoice).toBe('none')
      expect(adapter.requests.every(r => r.reasoningEffort === effort)).toBe(true)
    } finally {
      await team.dispose()
    }
  })
})
