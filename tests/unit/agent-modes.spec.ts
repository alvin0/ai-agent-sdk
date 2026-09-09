import { describe, expect, it } from 'vitest'
import { History } from '@alvin0/ai-agent-sdk-core/agent'
import { runAgent, type AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { createUserInputBroker } from '@alvin0/ai-agent-sdk-core/agent'
import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import { ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import { createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    if (model === 'effort-model') {
      return Promise.resolve({ provider, id: model, name: model, reasoning: {
        efforts: ['medium', 'high', 'max'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('medium'),
      } })
    }
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
  it('bounds differently worded self-check claims after a submission was invalidated', async () => {
    const state = setup([
      toolRound('submit', 'submit_result', { summary: 'Done.', evidence: ['sources inspected'] }),
      toolRound('later', 'echo', { message: 'Report delivered after submission.' }),
      textRound('The self-check was already accepted.'),
      textRound('All checks passed previously.'),
      textRound('There is nothing else to verify.'),
      textRound('This unnecessary paid round must not run.'),
    ])
    const events = await collect({ mode: 'deep', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 'auto' })
    expect(state.adapter.requests).toHaveLength(5)
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { completed: false } })
  })

  it('explains invalidated submissions and lets the model resubmit after reviewing later work', async () => {
    const state = setup([
      toolRound('submit', 'submit_result', { summary: 'Done.', evidence: ['sources inspected'] }),
      toolRound('later', 'echo', { message: 'New evidence.' }),
      textRound('I already submitted.'),
      toolRound('resubmit', 'submit_result', { summary: 'Reviewed again.', evidence: ['new evidence reviewed'] }),
      textRound('Final verified report.'),
    ])
    const events = await collect({ mode: 'deep', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 'auto' })
    expect(JSON.stringify(state.adapter.requests[3]?.messages)).toContain('previously accepted submission is no longer current')
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: { completed: true, text: 'Final verified report.' } })
  })

  it.each(['basic', 'deep'] as const)('auto completes %s work beyond the old lead ceiling', async mode => {
    const state = setup([
      ...Array.from({ length: 70 }, (_, i) => toolRound(`inspect-${i}`, 'echo', { page: i })),
      ...(mode === 'deep' ? [
        textRound('Preliminary findings; verification still required.'),
        toolRound('submit', 'submit_result', { summary: 'Reviewed all pages.', evidence: ['70 pages inspected'] }),
      ] : []),
      textRound('Final report: all 70 pages reviewed.'),
    ])
    const events = await collect({ mode, registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 'auto', bounds: { onExhausted: 'continue' } })
    expect(events[0]).toMatchObject({ type: 'agent-start', maxTurns: 'auto' })
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: {
      completed: true, reason: { kind: 'completed' }, text: 'Final report: all 70 pages reviewed.',
      steps: mode === 'deep' ? 73 : 71,
    } })
    expect(state.adapter.requests.every(request => request.toolChoice !== 'none')).toBe(true)
    expect(JSON.stringify(state.history.messages())).not.toContain('work steps remain')
    expect(JSON.parse(JSON.stringify(events[0]))).toMatchObject({ maxTurns: 'auto' })
  })

  it('auto retains loop detection instead of repeating tools forever', async () => {
    const state = setup([
      ...Array.from({ length: 3 }, (_, i) => toolRound(`repeat-${i}`, 'echo', { page: 1 })),
      textRound('Blocked: repeated source returns no new evidence.'),
    ])
    const events = await collect({ mode: 'deep', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 'auto',
      bounds: { onExhausted: 'continue', repeatToolWarningAt: 2, repeatToolLimit: 3, toolCycleLimit: 10 } })
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: {
      completed: false, reason: { kind: 'budget-exhausted', budget: 'repeated-tool-call', forcedFinalAnswer: true },
    } })
    expect(state.adapter.requests).toHaveLength(4)
  })

  it('auto still honors an explicit tool-call wall and returns a bounded report', async () => {
    const state = setup([toolRound('a', 'echo', { n: 1 }), toolRound('b', 'echo', { n: 2 }), textRound('Partial report.')])
    const events = await collect({ mode: 'basic', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 'auto', bounds: { maxToolCalls: 1 } })
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: {
      reason: { kind: 'budget-exhausted', budget: 'tool-calls', forcedFinalAnswer: true }, text: 'Partial report.',
    } })
    expect(state.adapter.requests).toHaveLength(3)
    expect(state.adapter.requests.at(-1)?.toolChoice).toBe('none')
  })

  it.each(['tokens', 'abort'] as const)('auto stops without another call on %s', async limit => {
    const state = setup([[
      ...toolRound('inspect', 'echo', { page: 1 }).slice(0, -1),
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], textRound('Must not be called.')])
    const controller = new AbortController()
    if (limit === 'abort') {
      state.tools = new ToolRegistry()
      state.tools.register(defineTool({ name: 'echo', description: 'Stop.',
        parameters: { type: 'object' }, execute: () => { controller.abort(); return {} } }))
    }
    const events = await collect({ mode: 'basic', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 'auto', signal: controller.signal,
      bounds: { onExhausted: 'continue', ...(limit === 'tokens' ? { maxTotalTokens: 10 } : {}) } })
    expect(state.adapter.requests).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: {
      completed: false, reason: limit === 'tokens' ? { kind: 'budget-exhausted', budget: 'tokens' } : { kind: 'aborted' },
    } })
  })

  it.each([false, true])('keeps an accepted submission across a progress-only update (same batch=%s)', async sameBatch => {
    const submit = { id: 'submit', name: 'submit_result', args: { summary: 'Reconciled.', evidence: ['340 USD verified'] } }
    const progress = { id: 'plan', name: 'report_progress', args: { done: true } }
    const state = setup([
      ...(sameBatch ? [toolBatch([submit, progress])] : [toolBatch([submit]), toolBatch([progress])]),
      textRound('Verified total: 340 USD. Plan reconciled.'),
    ])
    state.tools.register(defineTool({
      name: 'report_progress', description: 'Publish progress only.', parameters: { type: 'object' },
      completionExempt: true, execute: () => ({ published: true }),
    }))
    const events = await collect({
      mode: 'deep', registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, maxTurns: 8,
    })
    const end = events.at(-1)
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(true)
    expect(state.adapter.requests).toHaveLength(sameBatch ? 2 : 3)
    expect(end?.type === 'agent-end' && end.outcome.text).toContain('340 USD')
  })

  it('still invalidates completion for new work even when the tool is budget-exempt', async () => {
    const state = setup([
      toolRound('submit', 'submit_result', { summary: 'Done.', evidence: ['checked'] }),
      toolRound('work', 'new_evidence', {}),
      textRound('Unverified new result.'),
    ])
    state.tools.register(defineTool({
      name: 'new_evidence', description: 'Read new evidence.', parameters: { type: 'object' },
      budgetExempt: true, execute: () => ({ changed: true }),
    }))
    const events = await collect({
      mode: 'deep', registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, maxTurns: 3,
    })
    const end = events.at(-1)
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(false)
  })

  it('does not claim completion when the final report fails after an accepted submission', async () => {
    const state = setup([
      toolRound('submit', 'submit_result', { summary: 'Checks passed.', evidence: ['test output'] }),
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UNAVAILABLE', message: 'report failed' } } }],
    ])
    const events = await collect({
      mode: 'deep', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, maxTurns: 1, bounds: { onExhausted: 'continue' },
    })
    const end = events.at(-1)
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(false)
    expect(end?.type === 'agent-end' && end.outcome.reason.kind).toBe('error')
  })

  it.each(['medium', 'high', 'max'])('writes a report after submission on the last step (%s)', async (effort) => {
    const state = setup([
      toolRound('submit-last', 'submit_result', {
        summary: 'Analysis checked.', evidence: ['Reconciled source totals'],
      }),
      textRound('Final report: totals reconcile; future figures are unavailable.'),
    ])
    const events = await collect({
      mode: 'deep', registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'effort-model', reasoningEffort: ReasoningEffortId(effort) },
      maxTurns: 1, bounds: { onExhausted: 'continue' },
    })
    const end = events.at(-1)
    expect(end?.type === 'agent-end' && end.outcome.text).toContain('Final report:')
    expect(end?.type === 'agent-end' && end.outcome.completed).toBe(true)
    expect(state.adapter.requests).toHaveLength(2)
    expect(state.adapter.requests[1]?.reasoningEffort).toBe(effort)
    expect(state.adapter.requests[1]?.toolChoice).toBe('none')
  })

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
