import { describe, expect, it } from 'vitest'
import { History } from '@ai-agent-sdk/core/agent'
import { runAgent, type AgentRunEvent } from '@ai-agent-sdk/core/agent'
import { createUserInputBroker } from '@ai-agent-sdk/core/agent'
import { defineTool } from '@ai-agent-sdk/core/agent'
import { ToolRegistry } from '@ai-agent-sdk/core/agent'
import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { ResolvedModelInfo } from '@ai-agent-sdk/core'
import { createTextMessage } from '@ai-agent-sdk/core'
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
    if (provider === 'codex' && model === 'gpt-5.6-luna') {
      const medium = ReasoningEffortId('medium')
      return Promise.resolve({
        provider, id: model, name: model,
        reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
      })
    }
    return Promise.resolve({ provider, id: model, name: model })
  }
}

function toolRound(id: string, name: string, args: unknown): StreamChunk[] {
  return toolBatch([{ id, name, args }])
}

function toolBatch(calls: readonly { id: string; name: string; args: unknown }[]): StreamChunk[] {
  return [
    ...calls.map((call, index): StreamChunk => ({
      type: 'block-end', index,
      block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.args) },
    })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textRound(text: string): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function setup(rounds: readonly (readonly StreamChunk[])[]) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('finish the task') })
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'echo', description: 'Echo a value.', parameters: { type: 'object' },
    execute: value => value as Record<string, string>,
  }))
  return { adapter, registry, history, tools }
}

async function collect(options: Parameters<typeof runAgent>[0]): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = []
  for await (const event of runAgent(options)) events.push(event)
  return events
}

describe('agent modes', () => {
  it('lets a deep run submit after the tool budget is spent', async () => {
    // A budget that can block submit_result leaves a deep run with no legal way
    // to finish: it has done the work and cannot say so.
    const state = setup([
      toolRound('work-1', 'echo', { value: 'a' }),
      toolRound('submit-1', 'submit_result', {
        summary: 'Objective met.', evidence: ['echo returned a'],
      }),
      textRound('Here is the final answer.'),
    ])

    const events = await collect({
      mode: 'deep', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 6, bounds: { maxToolCalls: 1 },
    })

    const end = events.at(-1)
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(true)
    expect(end?.type === 'agent-end' && end.outcome.completion).toMatchObject({
      summary: 'Objective met.',
    })
    // The submission spent none of the budget either: one work call did.
    expect(end?.type === 'agent-end' && end.outcome.toolCalls).toBe(1)
  })

  it('lets a blocked run ask the user after the tool budget is spent', async () => {
    const broker = createUserInputBroker()
    const state = setup([
      toolRound('work-1', 'echo', { value: 'a' }),
      toolRound('ask-1', 'request_user_input', {
        questions: [{
          id: 'q1', header: 'Which', question: 'Which one?',
          options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
        }],
      }),
      textRound('Understood.'),
    ])
    broker.onRequest((request) => {
      broker.resolve(request.requestId, { answers: { q1: { answers: ['A'] } } })
    })

    const events = await collect({
      mode: 'deep-human-in-loop', registry: state.registry, history: state.history,
      tools: state.tools, userInput: broker, config: { provider: 'test', model: 'm' },
      maxTurns: 6, bounds: { maxToolCalls: 1 },
    })

    expect(events.some(event => event.type === 'user-input-response')).toBe(true)
  })

  it('uses the caller-selected model without adding an implicit provider or effort', async () => {
    const adapter = new ScriptedAdapter([textRound('default response')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['selected'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('use selected model') })

    const events = await collect({ mode: 'basic', registry, history, maxTurns: 1,
      config: { provider: 'selected', model: 'chosen' } })

    expect(adapter.requests[0]).toMatchObject({ provider: 'selected', model: 'chosen' })
    expect(adapter.requests[0]).not.toHaveProperty('reasoningEffort')
    expect(events.at(-1)?.type).toBe('agent-end')
  })

  it('basic uses tools proactively and reserves a final response after maxTurns', async () => {
    const state = setup([
      toolRound('echo-1', 'echo', { value: 'observed' }),
      textRound('Best result from the gathered evidence.'),
    ])
    const events = await collect({
      mode: 'basic', registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, maxTurns: 1,
    })

    const end = events.at(-1)
    expect(end?.type).toBe('agent-end')
    if (end?.type !== 'agent-end') return
    expect(end.outcome).toMatchObject({
      mode: 'basic', text: 'Best result from the gathered evidence.', steps: 2,
      reason: { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: true },
    })
    expect(state.adapter.requests).toHaveLength(2)
    expect(state.adapter.requests[1]?.toolChoice).toBe('none')
    expect(state.adapter.requests[0]?.system).toContain('Use available tools proactively')
  })

  it('deep rejects a prose-only draft, self-checks, submits evidence, then answers', async () => {
    const state = setup([
      textRound('A plausible draft.'),
      toolRound('complete-1', 'submit_result', {
        summary: 'Objective satisfied', evidence: ['Compared the output with the requested constraint'],
      }),
      textRound('Verified final answer.'),
    ])
    const events = await collect({
      mode: 'deep', registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, maxTurns: 4,
    })

    const end = events.at(-1)
    expect(end?.type).toBe('agent-end')
    if (end?.type !== 'agent-end') return
    expect(end.outcome).toMatchObject({
      mode: 'deep', completed: true, text: 'Verified final answer.',
      completion: { summary: 'Objective satisfied' },
    })
    expect(state.adapter.requests).toHaveLength(3)
    expect(state.adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['echo', 'submit_result'])
    const reminder = state.adapter.requests[1]?.messages.flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.includes('Self-check required'))
    expect(reminder).toBeDefined()
  })

  it('deep human-in-loop parks by call id, supports suggestions and free-form, then resumes', async () => {
    const state = setup([
      toolRound('question-1', 'request_user_input', {
        questions: [{
          id: 'database', header: 'Database', question: 'Which database should the implementation target?',
          options: [
            { label: 'PostgreSQL (Recommended)', description: 'Use the production-oriented relational path.' },
            { label: 'SQLite', description: 'Use the smallest local setup.' },
          ],
        }],
      }),
      toolRound('complete-2', 'submit_result', {
        summary: 'Used the human decision', evidence: ['The user selected a database target'],
      }),
      textRound('Implemented for PostgreSQL 17.'),
    ])
    const broker = createUserInputBroker()
    broker.onRequest(request => {
      expect(broker.pending()).toHaveLength(1)
      expect(request.questions[0]?.allowFreeForm).toBe(true)
      broker.resolve(request.requestId, { answers: { database: { answers: ['PostgreSQL 17'] } } })
    })

    const events = await collect({
      mode: 'deep-human-in-loop', userInput: broker,
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, maxTurns: 5,
    })

    const requestIndex = events.findIndex(event => event.type === 'user-input-request')
    const responseIndex = events.findIndex(event => event.type === 'user-input-response')
    const resultIndex = events.findIndex(event => event.type === 'tool-result'
      && event.call.toolName === 'request_user_input')
    expect(requestIndex).toBeGreaterThan(-1)
    expect(responseIndex).toBeGreaterThan(requestIndex)
    expect(resultIndex).toBeGreaterThan(responseIndex)
    const response = events[responseIndex]
    expect(response?.type === 'user-input-response' ? response.response : undefined).toEqual({
      answers: { database: { answers: ['PostgreSQL 17'] } },
    })
    const end = events.at(-1)
    expect(end?.type === 'agent-end' ? end.outcome : undefined).toMatchObject({
      mode: 'deep-human-in-loop', completed: true, text: 'Implemented for PostgreSQL 17.',
    })
    expect(broker.pending()).toEqual([])
  })

  it('reports deep prose exhaustion as incomplete when submit_result was never called', async () => {
    const state = setup([textRound('draft one'), textRound('draft two')])
    const events = await collect({
      mode: 'deep', registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, maxTurns: 2,
    })
    const end = events.at(-1)
    expect(end?.type === 'agent-end' ? end.outcome.completed : undefined).toBe(false)
    expect(state.adapter.requests).toHaveLength(2)
  })

  it('does not accept submit_result batched with work whose result was not reviewed', async () => {
    const state = setup([
      toolBatch([
        { id: 'work-1', name: 'echo', args: { value: 'new evidence' } },
        { id: 'early-complete', name: 'submit_result', args: { summary: 'Too early', evidence: ['guess'] } },
      ]),
      textRound('Premature final.'),
      toolRound('valid-complete', 'submit_result', { summary: 'Reviewed', evidence: ['new evidence'] }),
      textRound('Reviewed final.'),
    ])
    const events = await collect({
      mode: 'deep', registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, maxTurns: 5,
    })
    const end = events.at(-1)
    expect(end?.type === 'agent-end' ? end.outcome : undefined).toMatchObject({
      completed: true, text: 'Reviewed final.', completion: { summary: 'Reviewed' },
    })
    expect(state.adapter.requests).toHaveLength(4)
  })
})
