import { describe, expect, it } from 'vitest'
import { History } from '../../src/agent/history/history.ts'
import { AwaitedEventQueue } from '../../src/agent/loop/queue.ts'
import { runTurn } from '../../src/agent/loop/run-turn.ts'
import type { AgentEvent } from '../../src/agent/loop/types.ts'
import { createApprovalBroker, fixedApprovalBroker } from '../../src/agent/tool/approval.ts'
import { defineTool } from '../../src/agent/tool/definition.ts'
import { ToolError } from '../../src/agent/tool/errors.ts'
import { ToolRegistry } from '../../src/agent/tool/registry.ts'
import { buildTraceTree, type TraceEvent } from '../../src/agent/trace/trace.ts'
import { ModelAdapter } from '@ai-agent-sdk/core'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import { createTextMessage } from '@ai-agent-sdk/core'
import { ToolCallId } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
}

function toolRound(calls: readonly { id: string; name: string; arguments: string }[]): StreamChunk[] {
  return [
    ...calls.map((call, index): StreamChunk => ({
      type: 'block-end', index,
      block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments },
    })),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
function abortedToolRound(): StreamChunk[] {
  return [
    {
      type: 'block-end', index: 0,
      block: {
        type: 'tool-call', id: ToolCallId('interrupted-call'),
        name: 'echo', arguments: '{"value":1}',
      },
    },
    {
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stream interrupted' } },
    },
  ]
}
function narratedToolRound(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'I should inspect the source.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'I should inspect the source.' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'I’ll check that now.' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'I’ll check that now.' } },
    { type: 'block-end', index: 2, block: {
      type: 'tool-call', id: ToolCallId('c1'), name: 'echo', arguments: '{"value":1}',
    } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
function textRound(text: string): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function nativeImageRound(): StreamChunk[] {
  return [
    {
      type: 'image-delta', index: 0, itemId: 'ig_1', data: 'PART',
      mediaType: 'image/webp', partialIndex: 0,
    },
    { type: 'block-end', index: 0, block: {
      type: 'native-tool-call', id: 'ig_1', name: 'image-generation', status: 'completed',
      content: [{
        type: 'image', source: { kind: 'base64', mediaType: 'image/webp', data: 'FINAL' },
      }],
    } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function narratedNativeRound(): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text: 'I will search.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'I will search.' } },
    { type: 'block-end', index: 1, block: {
      type: 'native-tool-call', id: 'ws_1', name: 'web-search', status: 'completed', content: [],
    } },
    { type: 'text-delta', index: 2, text: 'The final result.' },
    { type: 'block-end', index: 2, block: { type: 'text', text: 'The final result.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function setup(rounds: readonly (readonly StreamChunk[])[]) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('do it') })
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'echo', description: 'Echo input.', parameters: { type: 'object' },
    parse: value => value as { value: number }, execute: ({ value }) => ({ value }),
    isConcurrencySafe: () => true,
  }))
  return { adapter, registry, history, tools }
}

describe('runTurn', () => {
  it('rejects a pending event consumer with the original producer failure', async () => {
    const queue = new AwaitedEventQueue<string>()
    const pending = queue.take()
    const failure = new Error('producer failed')

    queue.fail(failure)

    await expect(pending).rejects.toBe(failure)
    await expect(queue.take()).rejects.toBe(failure)
  })

  it('does not swallow an approval abort while the event consumer is waiting', async () => {
    const state = await setup([
      toolRound([{ id: 'approval-abort', name: 'echo', arguments: '{"value":1}' }]),
    ])
    const drain = async (): Promise<void> => {
      for await (const _event of runTurn({
        registry: state.registry, config: { provider: 'test', model: 'm' },
        history: state.history, tools: state.tools,
        interceptors: [{
          name: 'approval-required',
          before: async () => ({ kind: 'ask', reason: 'confirm mutation' }),
        }],
        approvals: fixedApprovalBroker('abort'),
      })) { /* drain */ }
    }

    await expect(drain()).rejects.toThrow('the turn was withdrawn while awaiting approval')
  })

  it('does not persist a tool call from an interrupted model round', async () => {
    const state = await setup([abortedToolRound()])
    const events: AgentEvent[] = []

    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools,
    })) events.push(event)

    expect(state.history.entries().map(entry => entry.event.kind)).toEqual(['user'])
    expect(state.history.messages().flatMap(message => message.content)).not.toContainEqual(
      expect.objectContaining({ type: 'tool-call', id: 'interrupted-call' }),
    )
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool-call' }))
    expect(events.at(-1)).toMatchObject({
      type: 'turn-end', outcome: { reason: { kind: 'aborted' } },
    })
  })

  it('separates unphased native-tool commentary from the final outcome text', async () => {
    const state = await setup([narratedNativeRound()])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      nativeTools: [{ type: 'native', name: 'web-search' }],
    })) events.push(event)

    const text = events.filter((event): event is Extract<AgentEvent, { type: 'assistant-text' }> =>
      event.type === 'assistant-text')
    expect(text.map(event => ({ text: event.text, phase: event.phase }))).toEqual([
      { text: 'I will search.', phase: 'commentary' },
      { text: 'The final result.', phase: 'final-answer' },
    ])
    const terminal = events.at(-1)
    expect(terminal?.type === 'turn-end' && terminal.outcome.text).toBe('The final result.')
  })

  it('forwards provider-native tools and image progress without host scheduling', async () => {
    const state = await setup([nativeImageRound()])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history,
      nativeTools: [{ type: 'native', name: 'image-generation', format: 'webp', partialImages: 1 }],
      toolChoice: { type: 'native', name: 'image-generation' },
    })) events.push(event)

    expect(state.adapter.requests[0]?.tools).toEqual([
      { type: 'native', name: 'image-generation', format: 'webp', partialImages: 1 },
    ])
    expect(state.adapter.requests[0]?.toolChoice).toEqual({
      type: 'native', name: 'image-generation',
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'image-delta', itemId: 'ig_1', data: 'PART', mediaType: 'image/webp', partialIndex: 0,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'assistant-native-tool', call: expect.objectContaining({
        id: 'ig_1', name: 'image-generation', status: 'completed',
      }),
    }))
    const terminal = events.at(-1)
    expect(terminal?.type === 'turn-end' && terminal.outcome).toMatchObject({
      steps: 1, toolCalls: 0, reason: { kind: 'completed' },
    })
  })

  it('separates provider reasoning, pre-tool commentary, and post-tool final text', async () => {
    const state = await setup([narratedToolRound(), textRound('The tool returned 1.')])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, commentary: 'concise',
    })) events.push(event)

    const textEvents = events.filter((event): event is Extract<AgentEvent, { type: 'assistant-text' }> => event.type === 'assistant-text')
    expect(textEvents).toMatchObject([
      { text: 'I’ll check that now.', phase: 'commentary', timing: 'before-tools', toolCallIds: ['c1'], afterToolCallIds: [] },
      { text: 'The tool returned 1.', phase: 'final-answer', timing: 'after-tools', toolCallIds: [], afterToolCallIds: ['c1'] },
    ])
    expect(events.find(event => event.type === 'assistant-reasoning')).toMatchObject({
      type: 'assistant-reasoning', text: 'I should inspect the source.', timing: 'before-tools', toolCallIds: ['c1'],
    })
    expect(events.findIndex(event => event.type === 'assistant-text')).toBeLessThan(
      events.findIndex(event => event.type === 'tool-call'),
    )
    expect(state.adapter.requests[0]?.system).toContain('user-visible progress update')
    const assistant = state.history.entries().find(entry => entry.event.kind === 'assistant')
    expect(assistant?.event.kind === 'assistant' ? assistant.event.message.content : []).toContainEqual({
      type: 'text', text: 'I’ll check that now.', phase: 'commentary',
    })
  })

  it('runs a multi-step tool loop and exposes a Foundry-shaped trace graph', async () => {
    const state = await setup([toolRound([{ id: 'c1', name: 'echo', arguments: '{"value":1}' }]), textRound('done')])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, trace: { agentId: 'worker', agentName: 'Worker' },
    })) events.push(event)
    const terminal = events.at(-1)
    expect(terminal?.type).toBe('turn-end')
    if (terminal?.type !== 'turn-end') return
    expect(terminal.outcome).toMatchObject({ text: 'done', steps: 2, toolCalls: 1, reason: { kind: 'completed' } })
    expect(state.adapter.requests).toHaveLength(2)
    expect(state.history.entries().map(entry => entry.event.kind)).toEqual(['user', 'assistant', 'tool-call', 'tool-result', 'assistant'])
    const tree = buildTraceTree(events.filter((event): event is TraceEvent => event.type === 'span-start' || event.type === 'span-end'))
    expect(tree).toHaveLength(1)
    expect(tree[0]?.children.map(child => child.kind)).toEqual(['chat', 'execute_tool', 'chat'])
    expect(tree[0]?.children[1]?.attributes).toMatchObject({ 'gen_ai.tool.call.id': 'c1' })
  })

  it('synthesizes declined results and reserves one no-tools forced-final request', async () => {
    const state = await setup([
      toolRound([
        { id: 'c1', name: 'echo', arguments: '{"value":1}' },
        { id: 'c2', name: 'echo', arguments: '{"value":2}' },
      ]),
      textRound('partial answer'),
    ])
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 1 },
    })) if (event.type === 'turn-end') terminal = event
    expect(terminal?.outcome).toMatchObject({
      text: 'partial answer', steps: 2, toolCalls: 1,
      reason: { kind: 'budget-exhausted', budget: 'tool-calls', forcedFinalAnswer: true },
    })
    expect(state.adapter.requests[1]?.toolChoice).toBe('none')
    const results = state.history.entries().filter(entry => entry.event.kind === 'tool-result')
    expect(results).toHaveLength(2)
    expect(results[1]?.event.kind === 'tool-result' && results[1].event.result).toMatchObject({
      isError: true, error: { code: 'TOOL_BUDGET_EXHAUSTED' },
    })
  })

  it.each([
    {
      label: 'error',
      finalRound: [{
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'PROVIDER_DOWN', message: 'forced final failed' } },
      }] satisfies StreamChunk[],
      expectedReason: { kind: 'error', failure: { code: 'PROVIDER_DOWN', message: 'forced final failed' } },
      expectedSpanStatus: 'error',
      expectedText: '',
    },
    {
      label: 'abort',
      finalRound: [{
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled final' } },
      }] satisfies StreamChunk[],
      expectedReason: { kind: 'aborted' },
      expectedSpanStatus: 'aborted',
      expectedText: '',
    },
    {
      label: 'max tokens',
      finalRound: [
        { type: 'block-end', index: 0, block: { type: 'text', text: 'partial final' } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ] satisfies StreamChunk[],
      expectedReason: { kind: 'max-tokens' },
      expectedSpanStatus: 'success',
      expectedText: 'partial final',
    },
  ])('propagates a forced-final $label finish as the terminal outcome', async scenario => {
    const state = await setup([
      toolRound([{ id: 'forced-final-trigger', name: 'echo', arguments: '{"value":1}' }]),
      scenario.finalRound,
    ])
    const events: AgentEvent[] = []

    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, bounds: { maxSteps: 1 },
    })) events.push(event)

    const terminal = events.at(-1)
    expect(terminal).toMatchObject({
      type: 'turn-end',
      outcome: { reason: scenario.expectedReason, text: scenario.expectedText, steps: 2 },
    })
    const rootEnd = events.findLast(event =>
      event.type === 'span-end' && event.trace.parentSpanId === null)
    expect(rootEnd).toMatchObject({ type: 'span-end', status: scenario.expectedSpanStatus })
  })

  it('runs beforeStep maintenance before the reserved forced-final request', async () => {
    const state = await setup([
      toolRound([{ id: 'large-result', name: 'echo', arguments: '{"value":1}' }]),
      textRound('final after maintenance'),
    ])
    const steps: number[] = []

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, bounds: { maxSteps: 1 },
      hooks: {
        beforeStep: context => {
          steps.push(context.step)
          return { kind: 'proceed' }
        },
      },
    })) { /* drain */ }

    expect(steps).toEqual([1, 2])
  })

  it('prepares and classifies each parallel call exactly once', async () => {
    const adapter = new ScriptedAdapter([
      toolRound([
        { id: 'parallel-once-1', name: 'counted', arguments: '{"value":1}' },
        { id: 'exclusive-once', name: 'counted', arguments: '{"value":2}' },
        { id: 'parallel-once-2', name: 'counted', arguments: '{"value":3}' },
      ]),
      textRound('done'),
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('run once') })
    let parses = 0
    let classifications = 0
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'counted', description: 'Count preparation.', parameters: { type: 'object' },
      parse: value => { parses++; return value as { value: number } },
      execute: ({ value }) => value,
      isConcurrencySafe: ({ value }) => { classifications++; return value !== 2 },
    }))

    for await (const _event of runTurn({
      registry, config: { provider: 'test', model: 'm' }, history, tools,
    })) { /* drain */ }

    expect({ parses, classifications }).toEqual({ parses: 3, classifications: 3 })
  })

  it('warns the model before the tool-call budget is exhausted', async () => {
    const state = await setup([
      toolRound([{ id: 'budget-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'budget-2', name: 'echo', arguments: '{"value":2}' }]),
      toolRound([{ id: 'budget-3', name: 'echo', arguments: '{"value":3}' }]),
      textRound('Verified with one call still reserved.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 4 },
    })) { /* drain */ }

    const finalRequest = state.adapter.requests[3]
    const text = finalRequest?.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(text).toContain('Tool budget warning: 1 of 4 calls remain')
    expect(text).toContain('reserve calls for verification')
  })

  it('detects a repeating multi-step tool cycle before dispatching the final cycle call', async () => {
    const state = await setup([
      toolRound([{ id: 'cycle-a1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'cycle-b1', name: 'other', arguments: '{"value":2}' }]),
      toolRound([{ id: 'cycle-a2', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'cycle-b2', name: 'other', arguments: '{"value":2}' }]),
      toolRound([{ id: 'cycle-a3', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'cycle-b3', name: 'other', arguments: '{"value":2}' }]),
      textRound('Stopped the cycle.'),
    ])
    let otherExecutions = 0
    state.tools.register(defineTool({
      name: 'other', description: 'Second cyclic action.', parameters: { type: 'object' },
      execute: () => { otherExecutions++; return { ok: true } },
    }))
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools,
    })) if (event.type === 'turn-end') terminal = event

    expect(otherExecutions).toBe(2)
    expect(terminal?.outcome).toMatchObject({
      steps: 7, toolCalls: 5,
      reason: { kind: 'budget-exhausted', budget: 'tool-call-cycle', forcedFinalAnswer: true },
    })
    expect(state.adapter.requests[6]?.toolChoice).toBe('none')
    const finalPrompt = state.adapter.requests[6]?.messages
      .flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n') ?? ''
    expect(finalPrompt).toContain('Tool-use pattern repeated 2 times')
  })

  it('treats the reported token budget as a hard stop without buying a forced-final round', async () => {
    const state = await setup([
      toolRound([{ id: 'token-stop', name: 'echo', arguments: '{"value":1}' }]),
    ])
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, bounds: { maxTotalTokens: 10 },
    })) if (event.type === 'turn-end') terminal = event

    expect(terminal?.outcome).toMatchObject({
      steps: 1, toolCalls: 0,
      reason: { kind: 'budget-exhausted', budget: 'tokens', forcedFinalAnswer: false },
    })
    expect(state.adapter.requests).toHaveLength(1)
    const result = state.history.entries().find(entry => entry.event.kind === 'tool-result')
    expect(result?.event.kind === 'tool-result' && result.event.result).toMatchObject({
      isError: true, error: { code: 'TOOL_BUDGET_EXHAUSTED' },
    })
  })

  it('lets onTurnEnd append context to request another bounded step', async () => {
    const state = await setup([textRound('draft'), textRound('revised')])
    let objected = false
    let canContinue: boolean | undefined
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      hooks: {
        onTurnEnd: ({ outcome, canContinue: continuation }) => {
          canContinue = continuation
          if (objected || outcome.reason.kind !== 'completed') return
          objected = true
          state.history.append({ kind: 'user', message: createTextMessage('Please revise once.') })
        },
      },
    })) if (event.type === 'turn-end') terminal = event
    expect(terminal?.outcome).toMatchObject({ text: 'revised', steps: 2, reason: { kind: 'completed' } })
    expect(state.adapter.requests).toHaveLength(2)
    expect(canContinue).toBe(true)
  })

  it.each([
    { label: 'completed at maxSteps', rounds: [textRound('done')] },
    {
      label: 'budget exhaustion',
      rounds: [
        toolRound([{ id: 'terminal-budget', name: 'echo', arguments: '{"value":1}' }]),
        textRound('forced final'),
      ],
    },
    {
      label: 'provider error',
      rounds: [[{
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'PROVIDER_DOWN', message: 'offline' } },
      }] satisfies StreamChunk[]],
    },
    { label: 'abort', rounds: [abortedToolRound()] },
    {
      label: 'max tokens',
      rounds: [[{ type: 'finish', reason: { kind: 'max-tokens' } }] satisfies StreamChunk[]],
    },
  ])('marks terminal $label as unable to consume appended hook context', async ({ rounds }) => {
    const state = await setup(rounds)
    let canContinue: boolean | undefined

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, bounds: { maxSteps: 1 },
      hooks: { onTurnEnd: context => { canContinue = context.canContinue } },
    })) { /* drain */ }

    expect(canContinue).toBe(false)
  })

  it('refreshes the current request when beforeStep appends live steering', async () => {
    const state = await setup([textRound('steered result')])
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      hooks: {
        beforeStep: () => {
          state.history.append({ kind: 'user', message: createTextMessage('Use a blue theme instead.') })
          return { kind: 'proceed' }
        },
      },
    })) { /* drain */ }

    const messages = state.adapter.requests[0]?.messages ?? []
    expect(messages.at(-1)?.content).toContainEqual({
      type: 'text', text: 'Use a blue theme instead.',
    })
  })

  it('awaits tool checkpoints and refuses the side effect when durability fails', async () => {
    const adapter = new ScriptedAdapter([
      toolRound([{ id: 'c1', name: 'mutate', arguments: '{}' }]),
      textRound('reported failure'),
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('mutate') })
    let executions = 0
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'mutate', description: 'Mutate state.', parameters: { type: 'object' },
      execute: () => { executions++; return 'changed' },
    }))
    const checkpointKinds: string[] = []
    for await (const _event of runTurn({
      registry, config: { provider: 'test', model: 'm' }, history, tools,
      hooks: {
        checkpoint: (context) => {
          checkpointKinds.push(context.kind)
          if (context.kind === 'before-tool-dispatch') throw new Error('disk unavailable')
        },
      },
    })) { /* drain */ }
    expect(executions).toBe(0)
    expect(checkpointKinds).toEqual(['before-model-request', 'before-tool-dispatch', 'before-model-request'])
    const result = history.entries().find(entry => entry.event.kind === 'tool-result')
    expect(result?.event.kind === 'tool-result' && result.event.result).toMatchObject({
      isError: true, error: { code: 'CHECKPOINT_FAILED' },
    })
  })

  it('registers an approval waiter before publishing the streamed request event', async () => {
    const state = await setup([
      toolRound([{ id: 'approval-live', name: 'echo', arguments: '{"value":1}' }]),
      textRound('approved'),
    ])
    const approvals = createApprovalBroker()
    let resolved = false
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, approvals,
      interceptors: [{ name: 'ask', before: async () => ({ kind: 'ask' }) }],
    })) {
      if (event.type === 'approval-request') {
        resolved = approvals.resolve(event.request.callId, 'allow')
      }
    }
    expect(resolved).toBe(true)
    expect(state.adapter.requests).toHaveLength(2)
  })

  it('propagates fatal tool errors while closing tool and root trace spans', async () => {
    const state = await setup([
      toolRound([{ id: 'fatal-live', name: 'fatal', arguments: '{}' }]),
    ])
    state.tools.register(defineTool({
      name: 'fatal', description: 'Fail fatally.', parameters: { type: 'object' },
      execute: () => { throw ToolError.fatal('fatal contract', 'FATAL_CONTRACT') },
    }))
    const events: AgentEvent[] = []
    await expect(async () => {
      for await (const event of runTurn({
        registry: state.registry, config: { provider: 'test', model: 'm' },
        history: state.history, tools: state.tools,
      })) events.push(event)
    }).rejects.toMatchObject({ code: 'FATAL_CONTRACT' })
    const ended = events.filter(event => event.type === 'span-end')
    expect(ended).toHaveLength(3)
    expect(ended.at(-1)).toMatchObject({ status: 'error', error: { code: 'FATAL_CONTRACT' } })
  })

  it('publishes detached frozen tool results that cannot alter loop control', async () => {
    const state = await setup([
      toolRound([{ id: 'immutable-result', name: 'echo', arguments: '{"value":1}' }]),
      textRound('normal final'),
    ])
    let mutationBlocked = false
    let outcome: Extract<AgentEvent, { type: 'turn-end' }>['outcome'] | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools,
    })) {
      if (event.type === 'tool-result') {
        try {
          ;(event.result as { concludesTurn?: true }).concludesTurn = true
        } catch {
          mutationBlocked = true
        }
      }
      if (event.type === 'turn-end') outcome = event.outcome
    }
    expect(mutationBlocked).toBe(true)
    expect(state.adapter.requests).toHaveLength(2)
    expect(outcome?.reason).toEqual({ kind: 'completed' })
  })

  it('rejects duplicate provider tool-call ids without corrupting the snapshot', async () => {
    const state = await setup([
      toolRound([
        { id: 'duplicate-live', name: 'echo', arguments: '{"value":1}' },
        { id: 'duplicate-live', name: 'echo', arguments: '{"value":2}' },
      ]),
    ])
    let outcome: Extract<AgentEvent, { type: 'turn-end' }>['outcome'] | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools,
    })) if (event.type === 'turn-end') outcome = event.outcome
    expect(outcome?.reason).toMatchObject({ kind: 'error', failure: { code: 'INVALID_TOOL_CALL' } })
    expect(() => History.fromSnapshot(state.history.snapshot())).not.toThrow()
    expect(state.history.entries().some(entry => entry.event.kind === 'tool-call')).toBe(false)
  })

  it('bounds consumer teardown when an active adapter ignores cancellation', async () => {
    const registry = {
      stream: () => ({
        async * [Symbol.asyncIterator]() {
          yield { type: 'text-delta', index: 0, text: 'partial' } as StreamChunk
          await new Promise<void>(() => {})
        },
      }),
    } as unknown as ModelRegistry
    const iterator = runTurn({
      registry, config: { provider: 'test', model: 'm' }, history: new History(),
      teardownTimeoutMs: 10,
    })[Symbol.asyncIterator]()
    while ((await iterator.next()).value?.type !== 'text-delta') { /* advance */ }
    const started = Date.now()
    await expect(iterator.return?.()).rejects.toMatchObject({ code: 'TURN_TEARDOWN_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('bounds an uncooperative model round with a total deadline', async () => {
    const registry = {
      stream: () => ({
        async * [Symbol.asyncIterator]() {
          await new Promise<void>(() => {})
        },
      }),
    } as unknown as ModelRegistry
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('never hang') })
    const started = Date.now()
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry, config: { provider: 'test', model: 'm' }, history,
      modelTimeoutMs: 10, teardownTimeoutMs: 10,
    })) if (event.type === 'turn-end') terminal = event
    expect(Date.now() - started).toBeLessThan(250)
    expect(terminal?.outcome.reason).toMatchObject({
      kind: 'error', failure: { code: 'MODEL_TEARDOWN_TIMEOUT' },
    })
  })

  it('rejects oversized model requests and response streams before retention grows', async () => {
    const requestState = await setup([textRound('unused')])
    requestState.history.append({ kind: 'user', message: createTextMessage('x'.repeat(1_000)) })
    let requestTerminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: requestState.registry, config: { provider: 'test', model: 'm' },
      history: requestState.history, maxModelRequestBytes: 128,
    })) if (event.type === 'turn-end') requestTerminal = event
    expect(requestState.adapter.requests).toHaveLength(0)
    expect(requestTerminal?.outcome.reason).toMatchObject({
      kind: 'error', failure: { code: 'MODEL_REQUEST_TOO_LARGE' },
    })

    const responseState = await setup([textRound('response payload')])
    let responseTerminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: responseState.registry, config: { provider: 'test', model: 'm' },
      history: responseState.history, maxModelStreamEvents: 1,
    })) if (event.type === 'turn-end') responseTerminal = event
    expect(responseTerminal?.outcome.reason).toMatchObject({
      kind: 'error', failure: { code: 'MODEL_RESPONSE_TOO_LARGE' },
    })
  })

  it('normalizes malformed adapter chunks into an invalid-stream outcome', async () => {
    const state = await setup([[
      { type: 'usage', usage: { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 } } as StreamChunk,
    ]])
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
    })) if (event.type === 'turn-end') terminal = event
    expect(terminal?.outcome.reason).toMatchObject({
      kind: 'error', failure: { code: 'INVALID_MODEL_STREAM' },
    })

    const malformedBlock = await setup([[
      { type: 'block-end', index: 0, block: { type: 'text', text: 42 } } as unknown as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    terminal = undefined
    for await (const event of runTurn({
      registry: malformedBlock.registry, config: { provider: 'test', model: 'm' },
      history: malformedBlock.history,
    })) if (event.type === 'turn-end') terminal = event
    expect(terminal?.outcome.reason).toMatchObject({
      kind: 'error', failure: { code: 'INVALID_MODEL_STREAM' },
    })

    const incompleteExtension = await setup([[
      { type: 'block-start', index: 0, blockType: 'extension' } as unknown as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    terminal = undefined
    for await (const event of runTurn({
      registry: incompleteExtension.registry, config: { provider: 'test', model: 'm' },
      history: incompleteExtension.history,
    })) if (event.type === 'turn-end') terminal = event
    expect(terminal?.outcome.reason).toMatchObject({
      kind: 'error', failure: { code: 'INVALID_MODEL_STREAM' },
    })
  })

  it('turns an oversized tool result into a bounded model-visible failure', async () => {
    const state = await setup([
      toolRound([{ id: 'large-result', name: 'large', arguments: '{}' }]),
      textRound('handled bounded failure'),
    ])
    state.tools.register(defineTool({
      name: 'large', description: 'Return a large payload.', parameters: { type: 'object' },
      execute: () => 'x'.repeat(10_000),
    }))
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools,
      bounds: { maxToolResultBytes: 512 },
    })) { /* drain */ }
    const result = state.history.entries().find(entry => entry.event.kind === 'tool-result')
    expect(result?.event.kind === 'tool-result' && result.event.result).toMatchObject({
      isError: true, error: { code: 'INVALID_TOOL_RESULT' },
    })
    expect(JSON.stringify(state.history.snapshot()).length).toBeLessThan(5_000)
    expect(() => History.fromSnapshot(state.history.snapshot())).not.toThrow()
  })

  it('bounds tools without their own timeout and stops after non-cooperative teardown', async () => {
    const state = await setup([
      toolRound([{ id: 'hung-tool', name: 'hung', arguments: '{}' }]),
    ])
    state.tools.register(defineTool({
      name: 'hung', description: 'Never settle.', parameters: { type: 'object' },
      execute: () => new Promise(() => {}),
    }))
    const started = Date.now()
    await expect(async () => {
      for await (const _event of runTurn({
        registry: state.registry, config: { provider: 'test', model: 'm' },
        history: state.history, tools: state.tools,
        bounds: { maxToolDurationMs: 10, toolTeardownTimeoutMs: 10 },
      })) { /* drain */ }
    }).rejects.toMatchObject({ code: 'TOOL_TEARDOWN_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('bounds policy hooks that ignore cancellation', async () => {
    const state = await setup([textRound('unused')])
    const started = Date.now()
    await expect(async () => {
      for await (const _event of runTurn({
        registry: state.registry, config: { provider: 'test', model: 'm' },
        history: state.history, hookTimeoutMs: 10, hookTeardownTimeoutMs: 10,
        hooks: { beforeStep: () => new Promise(() => {}) },
      })) { /* drain */ }
    }).rejects.toMatchObject({ code: 'HOOK_TEARDOWN_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
  })
})
