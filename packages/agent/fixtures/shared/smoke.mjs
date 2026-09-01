import {
  AgentTeam,
  defineAgent,
  defineTool,
} from '@ai-agent-sdk/agent'
import {
  ModelAdapter,
  ModelRegistry,
  ReasoningEffortId,
  ToolCallId,
} from '@ai-agent-sdk/core'

class FixtureAdapter extends ModelAdapter {
  calls = 0

  resolveModel(provider, model) {
    const low = ReasoningEffortId('low')
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 32_000 },
      reasoning: { efforts: [{ id: low, name: 'low' }], defaultEffort: low },
    })
  }

  async * stream() {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('fixture-tool-1'), name: 'lookup', arguments: '{}',
      } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = this.calls === 2 ? 'packed agent completed' : 'Short checkpoint.'
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function runPackedAgentFixture() {
  const adapter = new FixtureAdapter()
  const registry = new ModelRegistry()
  registry.registerAdapter(['fixture'], adapter)
  const lookup = defineTool({
    name: 'lookup',
    description: 'Return fixture evidence.',
    parameters: { type: 'object' },
    execute: () => ({ ok: true }),
  })
  const team = new AgentTeam()
  const agent = defineAgent({
    id: 'packed-agent',
    provider: 'fixture',
    model: 'model',
    effort: 'low',
    instructions: 'Exercise the packed universal runtime.',
    tools: [lookup],
    compaction: { auto: false, retainTokens: 1 },
  })
  const session = agent.createSession({ registry, team: { team } })
  const response = await session.run(`Exercise tool and history. ${'context '.repeat(800)}`)
  const compaction = await session.compact()
  return {
    text: response.text,
    totalTokens: response.report.usage.reported.totalTokens,
    toolCalls: response.report.operationCounts.tool.total,
    teamMembers: team.members().length,
    compaction: compaction === null ? 'none' : 'completed',
    adapterCalls: adapter.calls,
    buffer: typeof globalThis.Buffer,
    process: typeof globalThis.process,
  }
}
