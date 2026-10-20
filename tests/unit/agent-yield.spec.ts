import { describe, expect, it } from 'vitest'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { createUserMessage, ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
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
  it('offers continuation for a commentary-only stop before terminal recovery', async () => {
    class CommentaryAdapter extends YieldAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        for await (const chunk of super.stream(options)) {
          const phase = this.requests === 1 ? 'commentary' : 'final-answer'
          if (chunk.type === 'text-delta') yield { ...chunk, phase }
          else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
            yield { ...chunk, block: { ...chunk.block, phase } }
          } else yield chunk
        }
      }
    }
    const adapter = new CommentaryAdapter(), registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    let recoveries = 0, continued = false
    const session = defineAgent({ id: 'lead', provider: 'test', model: 'scripted', mode: 'basic',
      instructions: 'Finish the film.', maxTurns: 4 }).createSession({ registry,
      hooks: { onTerminalRecovery: () => { recoveries++; return 'Unfinished work remains.' },
        beforeCompletion: context => {
          if (continued || !context.canContinue) return
          continued = true
          return { kind: 'continue', messages: [createUserMessage({ source: { kind: 'app', producer: 'quality-gate' },
            content: [{ type: 'text', text: 'Finish the remaining scenes.' }] })] }
        } } })
    const result = await session.run('Create the film')
    expect(adapter.requests).toBe(2)
    expect(result.text).toBe('Synthesis')
    expect(result.outcome.completed).toBe(true)
    expect(recoveries).toBe(0)
  })

  it('does not let an empty continuation bypass deep-mode completion checks', async () => {
    const adapter = new YieldAdapter(), registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const session = defineAgent({ id: 'lead', provider: 'test', model: 'scripted', mode: 'deep',
      instructions: 'Finish the review.', maxTurns: 4 }).createSession({ registry,
      hooks: { onTurnEnd: () => ({ kind: 'continue', messages: [] }) } })
    const result = await session.run('Create the deliverable')
    expect(adapter.requests).toBe(3)
    expect(result.text).toBe('Synthesis')
    expect(result.outcome.completed).toBe(true)
  })

  it.each(['basic', 'deep'] as const)('continues a %s session through its public hook in one run', async mode => {
    const adapter = new YieldAdapter(), registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    let continued = false
    const session = defineAgent({ id: 'lead', provider: 'test', model: 'scripted', mode,
      instructions: 'Finish the pending review.', maxTurns: 4 }).createSession({ registry,
      hooks: { onTurnEnd: context => {
        if (continued || !context.canContinue) return
        continued = true
        return { kind: 'continue', messages: [createUserMessage({ source: { kind: 'app', producer: 'quality-gate' },
          content: [{ type: 'text', text: 'Review remains pending. Continue now.' }] })] }
      } } })
    const result = await session.run('Create the deliverable')
    expect(continued).toBe(true)
    expect(result.text).toBe('Synthesis')
    expect(result.outcome.completed).toBe(true)
    expect(adapter.requests).toBe(mode === 'basic' ? 2 : 3)
  })

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
