import { describe, expect, it } from 'vitest'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'

class YieldAdapter extends ModelAdapter {
  requests = 0

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    if (this.requests === 2 && options.tools?.some(tool => tool.name === 'submit_result')) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('check'), name: 'submit_result',
        arguments: JSON.stringify({ summary: 'Results synthesized', evidence: ['external result'] }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = this.requests === 1 ? 'Waiting for external work' : 'Synthesis'
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('host-directed turn yield', () => {
  it.each(['basic', 'deep'] as const)('ends a %s run without completion or self-check polling', async mode => {
    const adapter = new YieldAdapter()
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    let waiting = true
    const session = defineAgent({ id: 'lead', provider: 'test', model: 'scripted', mode,
      instructions: 'Synthesize external results.', maxTurns: 4 }).createSession({ registry,
      hooks: { onTurnEnd: () => waiting ? { kind: 'yield' } : undefined } })
    const first = await session.run('Delegate this work')
    expect(adapter.requests).toBe(1)
    expect(first.outcome.yielded).toBe(true)
    expect(first.outcome.completed).toBe(false)
    expect(session.isRunning).toBe(false)
    waiting = false
    const final = await session.run('External result: ready')
    expect(final.outcome.yielded).toBeUndefined()
    expect(final.outcome.completed).toBe(true)
    expect(final.text).toBe('Synthesis')
    expect(adapter.requests).toBe(mode === 'basic' ? 2 : 3)
  })
})
