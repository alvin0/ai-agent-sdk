import { describe, expect, it, vi } from 'vitest'
import * as canonicalAgent from '@ai-agent-sdk/core/agent'
import * as legacyAgent from '@ai-agent-sdk/core/agent'
import { cloneAgent, defineAgent } from '@ai-agent-sdk/core/agent'
import type { AgentRunEvent } from '@ai-agent-sdk/core/agent'
import { defineTool } from '@ai-agent-sdk/core/agent'
import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ResolvedModelInfo } from '@ai-agent-sdk/core'
import { ReasoningEffortId, ToolCallId } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const low = ReasoningEffortId('low')
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: {
        efforts: [{ id: low, name: 'low' }, { id: medium, name: 'medium' }],
        defaultEffort: medium,
      },
    })
  }
}

function textRound(text: string): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolRound(id: string, name: string, args: unknown): StreamChunk[] {
  return [
    {
      type: 'block-end', index: 0,
      block: {
        type: 'tool-call', id: ToolCallId(id), name,
        arguments: JSON.stringify(args),
      },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function model(rounds: readonly (readonly StreamChunk[])[]) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return { adapter, registry }
}

describe('declarative agent definitions', () => {
  it('keeps every legacy runtime export identical to its canonical core owner', () => {
    expect(Object.keys(legacyAgent).sort()).toEqual(Object.keys(canonicalAgent).sort())
    for (const name of Object.keys(legacyAgent) as (keyof typeof legacyAgent)[]) {
      expect(legacyAgent[name], name).toBe(canonicalAgent[name])
    }
  })

  it('provides friendly Codex defaults and immutable normalized values', () => {
    const agent = defineAgent({ id: 'ada', instructions: 'Be precise.' })

    expect(agent).toMatchObject({
      id: 'ada', name: 'ada', provider: 'codex', model: 'gpt-5.6-luna',
      effort: 'medium', mode: 'basic', maxTurns: 16, maxToolCalls: 64, commentary: 'concise',
    })
    expect(agent.tools).toEqual([])
    expect(agent.nativeTools).toEqual([])
    expect(agent.memory).toMatchObject({ autoCaptureObjective: true, maxInjectedChars: 12_000 })
    expect(agent.compaction).toMatchObject({ auto: true, thresholdRatio: 0.8, retainRatio: 0.2 })
    expect(Object.isFrozen(agent)).toBe(true)
    expect(Object.isFrozen(agent.tools)).toBe(true)
  })

  it('validates mistakes at definition time', () => {
    expect(() => defineAgent({ id: 'not friendly', instructions: 'Valid.' })).toThrow(/agent id/)
    expect(() => defineAgent({ id: 'valid', instructions: '  ' })).toThrow(/instructions/)
    expect(() => defineAgent({ id: 'valid', instructions: 'Valid.', maxTurns: 0 })).toThrow(/maxTurns/)
    expect(() => defineAgent({ id: 'valid', instructions: 'Valid.', maxToolCalls: 0 })).toThrow(/maxToolCalls/)

    const tool = defineTool({
      name: 'lookup', description: 'Look up a value.', parameters: { type: 'object' },
      execute: () => ({ ok: true }),
    })
    expect(() => defineAgent({
      id: 'duplicate-tools', instructions: 'Valid.', tools: [tool, tool],
    })).toThrow(/duplicate host tool 'lookup'/)
    expect(() => defineAgent({
      id: 'invalid-tool', instructions: 'Valid.',
      tools: [{ ...tool, description: '' }],
    })).toThrow(/non-empty description/)
    expect(() => defineAgent({
      id: 'invalid-compaction', instructions: 'Valid.',
      compaction: { thresholdRatio: 0.5, retainRatio: 0.6 },
    })).toThrow(/retainRatio must be lower/)
    expect(() => defineAgent({
      id: 'invalid-summary-route', instructions: 'Valid.',
      compaction: { summarizationProvider: 'test' },
    })).toThrow(/must be set together/)
  })

  it('derives variants with with() and cloneAgent()', () => {
    const base = defineAgent({
      id: 'ada', name: 'Ada', instructions: 'Be precise.', provider: 'test', model: 'small',
      skillIds: ['typescript-review'],
    })

    const deeper = base.with({ mode: 'deep', maxTurns: 24, maxToolCalls: 96 })
    const reviewer = cloneAgent(base, { id: 'reviewer', name: 'Reviewer', instructions: 'Review carefully.' })

    expect(deeper).toMatchObject({
      id: 'ada', name: 'Ada', mode: 'deep', maxTurns: 24, maxToolCalls: 96, model: 'small',
      skillIds: ['typescript-review'],
    })
    expect(reviewer).toMatchObject({
      id: 'reviewer', name: 'Reviewer', instructions: 'Review carefully.', provider: 'test', model: 'small',
      skillIds: ['typescript-review'],
    })
    expect(base).toMatchObject({ id: 'ada', mode: 'basic', maxTurns: 16 })
  })

  it('captures, freezes, validates, and forwards the selected output format', async () => {
    const state = model([textRound('{"answer":"yes"}')])
    const schema = {
      type: 'object', properties: { answer: { type: 'string' } },
      required: ['answer'], additionalProperties: false,
    }
    const agent = defineAgent({
      id: 'structured-agent', provider: 'test', model: 'scripted', instructions: 'Answer.',
      outputFormat: { type: 'json_schema', name: 'answer', schema },
    })
    schema.properties.answer.type = 'number'

    expect(agent.outputFormat).toEqual({
      type: 'json_schema', name: 'answer',
      schema: { type: 'object', properties: { answer: { type: 'string' } },
        required: ['answer'], additionalProperties: false },
    })
    expect(Object.isFrozen(agent.outputFormat)).toBe(true)
    expect(Object.isFrozen(agent.outputFormat?.type === 'json_schema'
      ? agent.outputFormat.schema : undefined)).toBe(true)
    await agent.createSession({ registry: state.registry }).run('Return JSON.')
    expect(state.adapter.requests[0]?.outputFormat).toBe(agent.outputFormat)

    expect(() => defineAgent({
      id: 'bad-output', instructions: 'Answer.',
      outputFormat: { type: 'json_schema', name: 'not valid', schema: {} },
    })).toThrow(/outputFormat/)
  })

  it('validates and freezes the definition-owned skill allowlist', () => {
    const agent = defineAgent({
      id: 'scoped-agent', instructions: 'Use only explicitly attached skills.',
      skillIds: ['incident-triage', 'release-review'],
    })

    expect(agent.skillIds).toEqual(['incident-triage', 'release-review'])
    expect(Object.isFrozen(agent.skillIds)).toBe(true)
    expect(() => defineAgent({
      id: 'duplicate-skills', instructions: 'Invalid.',
      skillIds: ['incident-triage', 'incident-triage'],
    })).toThrow(/duplicate allowed skill/)
    expect(() => defineAgent({
      id: 'invalid-skills', instructions: 'Invalid.', skillIds: ['Not Valid'],
    })).toThrow(/kebab-case/)
  })

  it('runs a multi-turn session without manual history plumbing', async () => {
    const state = model([textRound('Hello Linh.'), textRound('Your name is Linh.')])
    const agent = defineAgent({
      id: 'memory-agent', provider: 'test', model: 'scripted', effort: 'low',
      instructions: 'Remember facts from this conversation.',
    })
    const session = agent.createSession({ registry: state.registry })

    const first = await session.run('My name is Linh.')
    const second = await session.run('What is my name?')

    expect(first.text).toBe('Hello Linh.')
    expect(second.text).toBe('Your name is Linh.')
    expect(state.adapter.requests[0]).toMatchObject({
      provider: 'test', model: 'scripted', reasoningEffort: 'low',
    })
    expect(state.adapter.requests[0]?.system).toContain('Remember facts from this conversation.')
    expect(state.adapter.requests[1]?.messages
      .filter(message => message.source.kind !== 'app').map(message => message.role)).toEqual([
      'user', 'assistant', 'user',
    ])
    expect(session.history.messages()).toHaveLength(4)
  })

  it('contains an invocation event observer that never settles', async () => {
    const state = model([textRound('Observer cannot block this response.')])
    const session = defineAgent({
      id: 'bounded-observer', provider: 'test', model: 'scripted', instructions: 'Answer.',
    }).createSession({ registry: state.registry, runtimeLimits: { observerTimeoutMs: 10 } })
    const started = Date.now()
    const response = await session.run('Continue.', {
      onEvent: async () => await new Promise<void>(() => {}),
    })
    expect(response.text).toBe('Observer cannot block this response.')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('snapshots and resumes a conversation without manual state hydration', async () => {
    const state = model([textRound('Saved progress.'), textRound('Resumed safely.')])
    const agent = defineAgent({
      id: 'resumable-agent', provider: 'test', model: 'scripted',
      instructions: 'Continue the same conversation.',
    })
    const first = agent.createSession({
      registry: state.registry,
      conversationId: 'conversation-42',
    })
    await first.run('Start the migration.')
    first.memory.remember({ kind: 'decision', content: 'Use the safe migration path.' })

    const persisted = JSON.parse(JSON.stringify(first.snapshot())) as ReturnType<typeof first.snapshot>
    const resumed = agent.resumeSession({ registry: state.registry, snapshot: persisted })
    const events: AgentRunEvent[] = []
    for await (const event of resumed.stream('Continue.')) events.push(event)

    expect(resumed.conversationId).toBe('conversation-42')
    expect(resumed.memory.items()).toContainEqual(expect.objectContaining({
      kind: 'decision', content: 'Use the safe migration path.',
    }))
    expect(state.adapter.requests[1]?.messages
      .filter(message => message.source.kind !== 'app').map(message => message.role)).toEqual([
      'user', 'assistant', 'user',
    ])
    expect(events.find(event => event.type === 'span-start' && event.kind === 'invoke_agent'))
      .toMatchObject({ attributes: { 'gen_ai.conversation.id': 'conversation-42' } })
    expect(resumed.snapshot()).toMatchObject({
      version: 1, agentId: 'resumable-agent', conversationId: 'conversation-42',
    })
  })

  it('rejects a snapshot from another agent and gives reset a fresh conversation id', () => {
    const state = model([])
    const sourceAgent = defineAgent({ id: 'source-agent', instructions: 'Source.' })
    const source = sourceAgent.createSession({
      registry: state.registry, conversationId: 'source-conversation',
    })
    const target = defineAgent({ id: 'target-agent', instructions: 'Target.' })

    expect(() => target.resumeSession({
      registry: state.registry,
      snapshot: source.snapshot(),
    })).toThrow(/cannot resume conversation for agent 'source-agent'/)
    expect(() => sourceAgent.resumeSession({
      registry: state.registry,
      snapshot: { ...source.snapshot(), version: 2 } as never,
    })).toThrow(/unsupported agent session snapshot/)

    source.reset()
    expect(source.conversationId).not.toBe('source-conversation')
  })

  it('streams the complete event surface when the caller needs a live UI', async () => {
    const state = model([textRound('Streamed answer.')])
    const session = defineAgent({
      id: 'stream-agent', provider: 'test', model: 'scripted', instructions: 'Answer.',
    }).createSession({ registry: state.registry })

    const types: string[] = []
    for await (const event of session.stream('Go.')) types.push(event.type)

    expect(types).toContain('text-delta')
    expect(types.at(-1)).toBe('agent-end')
  })

  it('serializes explicit compaction against turns and bounds restored skill state', async () => {
    const state = model([])
    const agent = defineAgent({
      id: 'session-guards', provider: 'test', model: 'scripted', instructions: 'Guard state.',
      skillOptions: { maxSkills: 1 },
    })
    const session = agent.createSession({ registry: state.registry })
    const compacting = session.compact()
    expect(session.isRunning).toBe(true)
    await expect(session.run('Race the compactor.')).rejects.toThrow(/already running/)
    await expect(compacting).resolves.toBeNull()
    expect(session.isRunning).toBe(false)

    const snapshot = session.snapshot()
    expect(() => agent.resumeSession({
      registry: state.registry,
      snapshot: {
        ...snapshot,
        skills: { activated: [
          { id: 'one', provider: 'fixture', source: 'one' },
          { id: 'two', provider: 'fixture', source: 'two' },
        ] },
      },
    })).toThrow(/1-activated-skill limit/)
  })

  it('declares host tools once and executes them through every session', async () => {
    const execute = vi.fn((input: unknown) => ({ doubled: (input as { value: number }).value * 2 }))
    const double = defineTool({
      name: 'double', description: 'Double a number.',
      parameters: {
        type: 'object', properties: { value: { type: 'number' } }, required: ['value'],
      },
      parse: raw => raw as { value: number },
      execute: input => execute(input),
    })
    const state = model([
      toolRound('double-1', 'double', { value: 21 }),
      textRound('The result is 42.'),
    ])
    const session = defineAgent({
      id: 'calculator', provider: 'test', model: 'scripted',
      instructions: 'Use the calculator.', tools: [double],
    }).createSession({ registry: state.registry })

    const response = await session.run('Double 21.')

    expect(response.text).toBe('The result is 42.')
    expect(execute).toHaveBeenCalledWith({ value: 21 })
    expect(state.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['double'])
    expect(session.history.entries().some(entry => entry.event.kind === 'tool-result')).toBe(true)
  })

  it('requires the human-input dependency when the selected mode needs it', () => {
    const state = model([])
    const agent = defineAgent({
      id: 'interactive', provider: 'test', model: 'scripted', instructions: 'Ask when blocked.',
      mode: 'deep-human-in-loop',
    })

    expect(() => agent.createSession({ registry: state.registry })).toThrow(/requires a userInput broker/)
  })
})
