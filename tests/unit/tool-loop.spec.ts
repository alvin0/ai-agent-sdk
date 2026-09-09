import { describe, expect, it } from 'vitest'
import { History } from '@alvin0/ai-agent-sdk-core/agent'
import { AwaitedEventQueue } from '../../packages/core/src/agent/loop/queue.ts'
import { resolveBounds } from '../../packages/core/src/agent/loop/turn/config.ts'
import { resolveRuntimeLimits } from '../../packages/core/src/agent/define/session/config.ts'
import { runTurn } from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { createApprovalBroker, fixedApprovalBroker } from '@alvin0/ai-agent-sdk-core/agent'
import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import { ToolError } from '@alvin0/ai-agent-sdk-core/agent'
import { ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import { runToolCalls } from '@alvin0/ai-agent-sdk-core/agent'
import { createSpanId, createTraceId } from '../../packages/core/src/agent/trace/trace.ts'
import { buildTraceTree, type TraceEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import { createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'

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

describe('runToolCalls ownership', () => {
  it('observes a fatal sibling while another sibling is parked for approval', async () => {
    const tools = new ToolRegistry()
    tools.register(defineTool({
      name: 'fatal', description: 'Reject fatally.', parameters: { type: 'object' },
      isConcurrencySafe: () => true,
      execute: () => { throw ToolError.fatal('FATAL_WHILE_PARKED', 'FATAL_WHILE_PARKED') },
    }))
    tools.register(defineTool({
      name: 'parked', description: 'Wait for approval.', parameters: { type: 'object' },
      isConcurrencySafe: () => true, execute: () => ({ ok: true }),
    }))
    const approvals = createApprovalBroker()
    const parentTrace = {
      traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null,
    } as unknown as Parameters<typeof runToolCalls>[0]['parentTrace']
    const pending = runToolCalls({
      calls: [
        { callId: ToolCallId('fatal-call'), toolName: 'fatal', rawArguments: '{}' },
        { callId: ToolCallId('parked-call'), toolName: 'parked', rawArguments: '{}' },
      ],
      catalog: tools, history: new History(), position: { turn: 1, step: 1 },
      signal: new AbortController().signal, parentTrace, maxParallel: 2, approvals,
      interceptors: [{ name: 'approval', before: async call =>
        call.toolName === 'parked' ? { kind: 'ask' } : { kind: 'allow' } }],
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(approvals.resolve(approvals.pending()[0]!.approvalRequestId, 'allow')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'FATAL_WHILE_PARKED' })
  })

  it('drains an already-dispatched sibling when later admission fails', async () => {
    const tools = new ToolRegistry()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started = false
    let finished = false
    tools.register(defineTool({
      name: 'slow', description: 'Wait for the test gate.', parameters: { type: 'object' },
      isConcurrencySafe: () => true,
      execute: async () => { started = true; await gate; finished = true; return { ok: true } },
    }))
    tools.register(defineTool({
      name: 'later', description: 'Fails during admission.', parameters: { type: 'object' },
      isConcurrencySafe: () => true, execute: () => ({ ok: true }),
    }))
    const parentTrace = {
      traceId: createTraceId(), spanId: createSpanId(), parentSpanId: null,
    } as unknown as Parameters<typeof runToolCalls>[0]['parentTrace']
    const pending = runToolCalls({
      calls: [
        { callId: ToolCallId('slow-call'), toolName: 'slow', rawArguments: '{}' },
        { callId: ToolCallId('later-call'), toolName: 'later', rawArguments: '{}' },
      ],
      catalog: tools,
      history: new History(),
      position: { turn: 1, step: 1 },
      signal: new AbortController().signal,
      parentTrace,
      maxParallel: 2,
      teardownTimeoutMs: 500,
      interceptors: [{
        name: 'admission',
        before: async call => {
          if (call.toolName === 'later') throw new Error('LATER_ADMISSION_FAILED')
          return { kind: 'allow' }
        },
      }],
    })
    let settled = false
    void pending.finally(() => { settled = true }).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(started).toBe(true)
    expect(finished).toBe(false)
    expect(settled).toBe(false)
    release()
    await expect(pending).rejects.toThrow('LATER_ADMISSION_FAILED')
    expect(finished).toBe(true)
  })
})

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
    const settledText = events.filter(event => event.type === 'text-end')
    expect(settledText).toMatchObject([
      { index: 1, phase: 'commentary' }, { index: 0, phase: 'final-answer' },
    ])
    for (const event of settledText) {
      expect(events.findIndex(next => next.type === 'step-end' && next.trace.spanId === event.trace.spanId))
        .toBeGreaterThan(events.indexOf(event))
    }
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
    // No ladder on this route, so no level is claimed: a default nobody chose
    // is worse than a missing attribute.
    expect(tree[0]?.children[0]?.attributes).not.toHaveProperty('gen_ai.request.reasoning_effort')
  })

  it('reports the reasoning effort a model round ran at', async () => {
    // The same model at minimal and at high is two different requests, priced
    // and paced differently. A trace without the level cannot explain either,
    // and the level is per CALL: a run may change it between rounds.
    const state = await setup([textRound('done')])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry,
      config: { provider: 'test', model: 'm', reasoningEffort: ReasoningEffortId('high') },
      history: state.history, tools: state.tools,
    })) events.push(event)
    const tree = buildTraceTree(events.filter((event): event is TraceEvent =>
      event.type === 'span-start' || event.type === 'span-end'))
    expect(tree[0]?.children[0]?.attributes).toMatchObject({
      'gen_ai.request.model': 'm',
      'gen_ai.request.reasoning_effort': 'high',
    })
  })

  it('keeps long tool-loop rounds as text and applies JSON Schema only to the final answer', async () => {
    const state = await setup([
      toolRound([{ id: 'schema-loop-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'schema-loop-2', name: 'echo', arguments: '{"value":2}' }]),
      textRound('The process is complete.').map(chunk => chunk.type === 'block-end' && chunk.block.type === 'text'
        ? { ...chunk, block: { ...chunk.block, phase: 'final-answer' as const } }
        : chunk.type === 'text-delta' ? { ...chunk, phase: 'final-answer' as const } : chunk),
      textRound('{"answer":"done"}'),
    ])
    const events: AgentEvent[] = []
    const outputFormat = {
      type: 'json_schema' as const,
      name: 'final_answer',
      schema: {
        type: 'object', properties: { answer: { type: 'string' } },
        required: ['answer'], additionalProperties: false,
      },
    }

    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, outputFormat,
    })) events.push(event)

    expect(state.adapter.requests).toHaveLength(4)
    expect(events.filter(event => (event.type === 'text-delta' || event.type === 'text-end')
      && event.text === 'The process is complete.')).toMatchObject([
      { type: 'text-delta', phase: 'commentary' }, { type: 'text-end', phase: 'commentary' },
    ])
    expect(state.adapter.requests.slice(0, 3).map(request => request.outputFormat)).toEqual([
      { type: 'text' }, { type: 'text' }, { type: 'text' },
    ])
    expect(state.adapter.requests[3]).toMatchObject({
      outputFormat,
      toolChoice: 'none',
    })
    const visibleText = events.filter((event): event is Extract<AgentEvent, { type: 'assistant-text' }> =>
      event.type === 'assistant-text')
    expect(visibleText.map(event => ({ text: event.text, phase: event.phase }))).toEqual([
      { text: 'The process is complete.', phase: 'commentary' },
      { text: '{"answer":"done"}', phase: 'final-answer' },
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'turn-end',
      outcome: {
        text: '{"answer":"done"}', steps: 4, toolCalls: 2,
        reason: { kind: 'completed' },
      },
    })
  })

  it('applies JSON Schema to the reserved final answer after a process budget is exhausted', async () => {
    const state = await setup([
      toolRound([{ id: 'schema-budget-1', name: 'echo', arguments: '{"value":1}' }]),
      textRound('{"answer":"best available"}'),
    ])
    const outputFormat = {
      type: 'json_schema' as const,
      name: 'budget_answer',
      schema: {
        type: 'object', properties: { answer: { type: 'string' } },
        required: ['answer'], additionalProperties: false,
      },
    }
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined

    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, outputFormat,
      bounds: { maxSteps: 1 },
    })) if (event.type === 'turn-end') terminal = event

    expect(state.adapter.requests).toHaveLength(2)
    expect(state.adapter.requests[0]?.outputFormat).toEqual({ type: 'text' })
    expect(state.adapter.requests[1]).toMatchObject({ outputFormat, toolChoice: 'none' })
    expect(terminal?.outcome).toMatchObject({
      text: '{"answer":"best available"}', steps: 2, toolCalls: 1,
      reason: { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: true },
    })
  })

  it('fails closed when a final adapter response violates the requested JSON format', async () => {
    const state = await setup([textRound('this is not JSON')])
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined

    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history,
      outputFormat: {
        type: 'json_schema', name: 'answer',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    })) if (event.type === 'turn-end') terminal = event

    expect(state.adapter.requests[0]).toMatchObject({
      outputFormat: { type: 'json_schema', name: 'answer' },
    })
    expect(terminal?.outcome.reason).toEqual({
      kind: 'error',
      failure: {
        message: 'model returned invalid JSON or failed the structured output validator',
        code: 'MALFORMED_RESPONSE',
      },
    })
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
    // A declined call is not a failed call. Reporting it as a failure is what
    // sends a model back for a retry it cannot afford, and paints a finished
    // run red in the UI.
    expect(results[1]?.event.kind === 'tool-result' && results[1].event.result).toMatchObject({
      isError: false, meta: { declined: true, reason: 'tool-calls' },
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

  /** Every text block in the Nth model request, joined. */
  const requestText = (state: Awaited<ReturnType<typeof setup>>, index: number): string =>
    state.adapter.requests[index]?.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''

  it('warns the model before the tool-call budget is exhausted', async () => {
    const state = await setup([
      toolRound([{ id: 'budget-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'budget-2', name: 'echo', arguments: '{"value":2}' }]),
      toolRound([{ id: 'budget-3', name: 'echo', arguments: '{"value":3}' }]),
      textRound('Verified with one call still reserved.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 4, toolBudgetRemindAt: [1] },
    })) { /* drain */ }

    const text = requestText(state, 3)
    expect(text).toContain('Tool budget: 1 of 4 calls remain')
    expect(text).toContain('reserve calls for verification')
  })

  it('warns again at every threshold it crosses, not once per turn', async () => {
    // This was a single boolean: told once at a quarter left, a model still
    // exploring at two calls had heard nothing since, and hit the wall with no
    // notice. Codex counts crossed thresholds instead of remembering a flag.
    const state = await setup([
      toolRound([{ id: 'b1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'b2', name: 'echo', arguments: '{"value":2}' }]),
      toolRound([{ id: 'b3', name: 'echo', arguments: '{"value":3}' }]),
      toolRound([{ id: 'b4', name: 'echo', arguments: '{"value":4}' }]),
      textRound('Done.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 6, toolBudgetRemindAt: [4, 2] },
    })) { /* drain */ }

    // After two calls four remain (first threshold); after four calls two do.
    expect(requestText(state, 2)).toContain('4 of 6 calls remain')
    expect(requestText(state, 4)).toContain('2 of 6 calls remain')
  })

  it('collapses several thresholds crossed at once into the lowest', async () => {
    const state = await setup([
      // One round spending four calls jumps past both thresholds together.
      toolRound([
        { id: 'p1', name: 'echo', arguments: '{"value":1}' },
        { id: 'p2', name: 'echo', arguments: '{"value":2}' },
        { id: 'p3', name: 'echo', arguments: '{"value":3}' },
        { id: 'p4', name: 'echo', arguments: '{"value":4}' },
      ]),
      textRound('Done.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 6, toolBudgetRemindAt: [4, 2] },
    })) { /* drain */ }

    const text = requestText(state, 1)
    // Two notices saying different numbers about the same moment would be
    // worse than one saying the true one.
    expect(text).toContain('2 of 6 calls remain')
    expect(text).not.toContain('4 of 6 calls remain')
  })

  it('keeps one live budget notice instead of a pile of stale ones', async () => {
    // Two notices saying different remainders are both readable, and a model
    // planning against the older one plans against a budget it no longer has.
    // Codex keeps exactly one `<rollout_budget>` fragment for this reason.
    const state = await setup([
      toolRound([{ id: 'r1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'r2', name: 'echo', arguments: '{"value":2}' }]),
      toolRound([{ id: 'r3', name: 'echo', arguments: '{"value":3}' }]),
      toolRound([{ id: 'r4', name: 'echo', arguments: '{"value":4}' }]),
      textRound('Done.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 6, toolBudgetRemindAt: [4, 2] },
    })) { /* drain */ }

    const last = requestText(state, 4)
    expect(last).toContain('2 of 6 calls remain')
    expect(last).not.toContain('4 of 6 calls remain')
    const notices = state.history.messages()
      .flatMap(message => message.content)
      .filter(block => block.type === 'text' && block.text.startsWith('Tool budget'))
    expect(notices).toHaveLength(1)
  })

  it('survives a compaction that shadows the notice it was going to replace', async () => {
    // Compaction runs between steps and can shadow the earlier notice. A
    // replace whose target has left the surface is rejected, and that must cost
    // a reminder at most — never the turn.
    const state = await setup([
      toolRound([{ id: 'x1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'x2', name: 'echo', arguments: '{"value":2}' }]),
      toolRound([{ id: 'x3', name: 'echo', arguments: '{"value":3}' }]),
      toolRound([{ id: 'x4', name: 'echo', arguments: '{"value":4}' }]),
      textRound('Done.'),
    ])
    let shadowed = false
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 6, toolBudgetRemindAt: [4, 2] },
      hooks: {
        beforeStep: () => {
          // Stand in for compaction: shadow everything up to the first notice.
          if (shadowed) return { kind: 'proceed' as const }
          const notice = state.history.entries().find(entry => entry.event.kind === 'user'
            && entry.event.message.source.kind === 'app'
            && entry.event.message.source.producer === 'tool-loop-budget-guard')
          if (notice === undefined) return { kind: 'proceed' as const }
          shadowed = true
          state.history.append(
            { kind: 'user', message: createTextMessage('summary of earlier context') },
            { op: 'replace', from: notice.seq, to: notice.seq, targets: [notice.seq] },
          )
          return { kind: 'proceed' as const }
        },
      },
    })) if (event.type === 'turn-end') terminal = event

    expect(shadowed).toBe(true)
    expect(terminal?.outcome.reason).toEqual({ kind: 'completed' })
    // The later reminder still reached the model, as a fresh append.
    expect(requestText(state, 4)).toContain('2 of 6 calls remain')
  })

  it.each([undefined, 'auto'] as const)('continues beyond the former token ceiling (%s)', async maxTotalTokens => {
    const state = await setup([[
      ...toolRound([{ id: 'large', name: 'echo', arguments: '{"value":1}' }]).slice(0, -2),
      { type: 'usage', usage: { inputTokens: 600_000, outputTokens: 10, totalTokens: 600_010 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ], textRound('Verified report after large cumulative usage.')])
    const events: AgentEvent[] = []
    for await (const event of runTurn({ registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, bounds: { maxSteps: 'auto', finalReportReserveTokens: 100_000,
        ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }) },
    })) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', outcome: {
      reason: { kind: 'completed' }, toolCalls: 1, text: 'Verified report after large cumulative usage.',
    } })
    expect(state.adapter.requests).toHaveLength(2)
    expect(state.adapter.requests[1]?.toolChoice).not.toBe('none')
    expect(JSON.stringify(state.adapter.requests[1]?.messages)).not.toContain('Token budget:')
  })

  it.each([0, -1, NaN, Infinity, 1.5, 'AUTO', '500000'])('rejects invalid total token policy %s', value => {
    expect(() => resolveBounds({ maxTotalTokens: value as number })).toThrow(/maxTotalTokens/)
    expect(() => resolveRuntimeLimits({ maxTotalTokens: value as number })).toThrow(/maxTotalTokens/)
  })

  it.each(['report', 'hard-stop', 'explicit-stop'] as const)('reserves a final report without overriding %s', async kind => {
    const state = await setup([
      toolRound([{ id: 'source', name: 'echo', arguments: '{"value":1}' }]),
      textRound('Partial findings: one source inspected; other checks pending.'),
    ])
    const events: AgentEvent[] = []
    for await (const event of runTurn({ registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, bounds: { maxSteps: 'auto',
        maxTotalTokens: kind === 'hard-stop' ? 12 : 20, finalReportReserveTokens: 10,
        onExhausted: kind === 'explicit-stop' ? 'stop' : 'continue' },
    })) events.push(event)
    expect(state.adapter.requests).toHaveLength(kind === 'report' ? 2 : 1)
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', outcome: {
      reason: { kind: 'budget-exhausted', budget: 'tokens', forcedFinalAnswer: kind === 'report' },
    } })
    if (kind === 'report') {
      expect(events.at(-1)).toMatchObject({ outcome: { reason: { trigger: 'report-reserve' } } })
      expect(state.adapter.requests.at(-1)?.toolChoice).toBe('none')
      expect(events.at(-1)).toMatchObject({ outcome: { text: expect.stringContaining('Partial findings:') } })
    }
    if (kind === 'hard-stop') {
      const terminal = events.at(-1)
      expect(terminal?.type === 'turn-end' && terminal.outcome.reason).not.toHaveProperty('trigger')
    }
  })

  it('warns an auto run before the hard token limit so it can report', async () => {
    const state = await setup([
      toolRound([{ id: 'source-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'source-2', name: 'echo', arguments: '{"value":2}' }]),
      textRound('Report: verified sources and remaining gaps.'),
    ])
    for await (const _event of runTurn({ registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, bounds: { maxSteps: 'auto', maxTotalTokens: 40 },
    })) { /* drain */ }
    // Each fixture tool round reports 12 tokens; after two, 16 remain.
    expect(JSON.stringify(state.adapter.requests[1]?.messages)).not.toContain('Token budget:')
    expect(JSON.stringify(state.adapter.requests[2]?.messages)).toContain('Token budget: 16 of 40')
    expect(state.adapter.requests).toHaveLength(3)
  })

  it('allows rechecking the same evidence between distinct work steps in auto mode', async () => {
    const state = await setup([
      toolRound([{ id: 'check-1', name: 'echo', arguments: '{"value":"verify"}' }]),
      toolRound([{ id: 'edit-1', name: 'echo', arguments: '{"value":"fix pagination"}' }]),
      toolRound([{ id: 'check-2', name: 'echo', arguments: '{"value":"verify"}' }]),
      toolRound([{ id: 'edit-2', name: 'echo', arguments: '{"value":"fix empty input"}' }]),
      toolRound([{ id: 'check-3', name: 'echo', arguments: '{"value":"verify"}' }]),
      textRound('Verified both fixes. Final report.'),
    ])
    const events: AgentEvent[] = []
    for await (const event of runTurn({ registry: state.registry, history: state.history, tools: state.tools,
      config: { provider: 'test', model: 'm' }, bounds: {
        maxSteps: 'auto', onExhausted: 'continue', repeatToolWarningAt: 2, repeatToolLimit: 3,
      },
    })) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', outcome: {
      reason: { kind: 'completed' }, text: 'Verified both fixes. Final report.', toolCalls: 5,
    } })
    expect(state.adapter.requests.at(-1)?.toolChoice).not.toBe('none')
  })

  it('names the guard that declined the call rather than blaming the budget', async () => {
    // A model told "no remaining tool-call budget" when it actually tripped the
    // repeat guard learns to ask for fewer calls, and repeats the same call in
    // the next turn with a budget it was told it lacked.
    const state = await setup([
      toolRound([{ id: 'rep-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'rep-2', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'rep-3', name: 'echo', arguments: '{"value":1}' }]),
      textRound('Changed approach.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools,
      // The cycle guard would otherwise trip first on a single repeated call,
      // and this test is about the repeat guard naming itself.
      bounds: {
        repeatToolWarningAt: 2, repeatToolLimit: 3,
        toolCycleWarningAt: 8, toolCycleLimit: 9,
      },
    })) { /* drain */ }

    const declined = state.history.entries()
      .filter(entry => entry.event.kind === 'tool-result')
      .map(entry => entry.event.kind === 'tool-result' ? entry.event.result : undefined)
      .find(result => result?.isError === false && result.meta?.['declined'] === true)
    expect(declined).toMatchObject({ meta: { reason: 'repeated-tool-call' } })
    expect(JSON.stringify(declined)).toContain('repeats a call already made')
  })

  it('runs a budget-exempt tool after the budget is spent', async () => {
    // The screenshot case: a lead spends its budget researching, then cannot
    // hand the work over or submit, because the budget blocks the only calls
    // that could end the run.
    const state = await setup([
      toolRound([{ id: 'work-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'hand-1', name: 'handoff', arguments: '{}' }]),
      textRound('Handed over.'),
    ])
    let handoffs = 0
    state.tools.register(defineTool({
      name: 'handoff', description: 'Give the work to someone who can finish it.',
      parameters: { type: 'object' }, budgetExempt: true,
      execute: () => { handoffs++; return { ok: true } },
    }))
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 1 },
    })) if (event.type === 'turn-end') terminal = event

    expect(handoffs).toBe(1)
    // The exempt call also spends none of the budget, so the count stays at the
    // one work call that did.
    expect(terminal?.outcome).toMatchObject({ toolCalls: 1, reason: { kind: 'completed' } })
    const declined = state.history.entries()
      .filter(entry => entry.event.kind === 'tool-result')
      .some(entry => entry.event.kind === 'tool-result'
        && entry.event.result.isError === false
        && entry.event.result.meta?.['declined'] === true)
    expect(declined).toBe(false)
  })

  it('still runs an exempt tool while a loop guard is declining everything else', async () => {
    const state = await setup([
      toolRound([{ id: 'cyc-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'cyc-2', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([
        { id: 'cyc-3', name: 'echo', arguments: '{"value":1}' },
        { id: 'submit-1', name: 'handoff', arguments: '{}' },
      ]),
      textRound('Stopped repeating.'),
    ])
    let handoffs = 0
    state.tools.register(defineTool({
      name: 'handoff', description: 'Give the work to someone who can finish it.',
      parameters: { type: 'object' }, budgetExempt: true,
      execute: () => { handoffs++; return { ok: true } },
    }))
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools,
      bounds: {
        repeatToolWarningAt: 2, repeatToolLimit: 3,
        toolCycleWarningAt: 8, toolCycleLimit: 9,
      },
    })) { /* drain */ }

    expect(handoffs).toBe(1)
  })

  it('continues past a spent budget when the wall is turned off', async () => {
    // Neither reference harness fails a call to enforce a budget: Codex ends
    // the turn on a token budget, and the DeepSeek harness has no tool-call
    // budget at all. `continue` is that shape — a notice, not a wall.
    const state = await setup([
      toolRound([{ id: 'c-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 'c-2', name: 'echo', arguments: '{"value":2}' }]),
      toolRound([{ id: 'c-3', name: 'echo', arguments: '{"value":3}' }]),
      textRound('Wrapped up.'),
    ])
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 1, onExhausted: 'continue', toolBudgetRemindAt: [] },
    })) if (event.type === 'turn-end') terminal = event

    // Every call ran, and the turn ended on the model's own answer.
    expect(terminal?.outcome).toMatchObject({
      text: 'Wrapped up.', toolCalls: 3, reason: { kind: 'completed' },
    })
    const declined = state.history.entries()
      .filter(entry => entry.event.kind === 'tool-result')
      .some(entry => entry.event.kind === 'tool-result'
        && entry.event.result.isError === false
        && entry.event.result.meta?.['declined'] === true)
    expect(declined).toBe(false)
    // Told once per further budget spent, in the shape of Codex's budget_limit
    // prompt: no new work, wrap up, say what is left.
    expect(requestText(state, 3)).toContain('Do not start new substantive work')
  })

  it('still bounds an unwalled turn by steps', async () => {
    const state = await setup([
      toolRound([{ id: 's-1', name: 'echo', arguments: '{"value":1}' }]),
      toolRound([{ id: 's-2', name: 'echo', arguments: '{"value":2}' }]),
      textRound('Forced answer.'),
    ])
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools,
      bounds: { maxToolCalls: 1, maxSteps: 2, onExhausted: 'continue', toolBudgetRemindAt: [] },
    })) if (event.type === 'turn-end') terminal = event

    expect(terminal?.outcome).toMatchObject({
      text: 'Forced answer.', steps: 3, toolCalls: 2,
      reason: { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: true },
    })
    expect(state.adapter.requests).toHaveLength(3)
    expect(state.adapter.requests.at(-1)?.toolChoice).toBe('none')
    expect(requestText(state, 1)).toContain('1 work steps remain')
  })

  it.each(['max-tokens', 'aborted'] as const)('keeps narration as process when %s drops an unfinished tool call', async kind => {
    const state = await setup([[
      { type: 'text-delta', index: 8, text: 'I will inspect the evidence.' },
      { type: 'tool-call-delta', index: 19, id: ToolCallId('unfinished'), name: 'echo', argumentsDelta: '{"value":' },
      kind === 'max-tokens'
        ? { type: 'finish', reason: { kind } }
        : { type: 'finish', reason: { kind, failure: { code: 'ABORTED', message: 'Stopped' } } },
    ]])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools,
    })) events.push(event)
    expect(events.filter(e => e.type === 'text-end')).toMatchObject([
      { index: 8, text: 'I will inspect the evidence.', phase: 'commentary', incomplete: true },
    ])
    expect(events.filter(e => e.type === 'tool-call')).toEqual([])
    const last = events.at(-1)
    expect(last?.type === 'turn-end' && last.outcome.text).toBe('')
  })

  it.each(['aborted', 'broken-extension'] as const)('preserves native research phases after %s', async kind => {
    const state = await setup([[
      { type: 'text-delta', index: 18, text: 'I will search the sources.' },
      { type: 'block-end', index: 2, block: {
        type: 'native-tool-call', id: 'search', name: 'web-search', status: 'completed', content: [],
      } },
      { type: 'text-delta', index: 9, text: 'The source reports 120 USD.' },
      ...(kind === 'broken-extension' ? [{ type: 'block-start', index: 25, blockType: 'extension' } as unknown as StreamChunk] : []),
      kind === 'aborted'
        ? { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Stopped' } } }
        : { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
    })) events.push(event)
    expect(events.filter(e => e.type === 'text-end')).toMatchObject([
      { index: 18, phase: 'commentary', incomplete: true },
      { index: 9, phase: 'final-answer', incomplete: true },
    ])
    const last = events.at(-1)
    expect(last?.type === 'turn-end' && last.outcome.text).toBe('The source reports 120 USD.')
  })

  it.each(['stop', 'tokens', 'abort'] as const)('does not finalize across %s', async (limit) => {
    const state = await setup([
      toolRound([{ id: 'last', name: 'echo', arguments: '{"value":1}' }]),
      textRound('Must not be requested.'),
    ])
    const controller = new AbortController()
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, signal: controller.signal,
      bounds: { maxSteps: 1, onExhausted: limit === 'stop' ? 'stop' : 'continue',
        ...(limit === 'tokens' ? { maxTotalTokens: 12 } : {}),
      },
    })) {
      if (limit === 'abort' && event.type === 'tool-result') controller.abort()
    }
    expect(state.adapter.requests).toHaveLength(1)
  })

  it('ignores thresholds that do not fit the budget', async () => {
    // A list written for a bigger budget stays usable rather than throwing or
    // firing a reminder before the first call.
    const state = await setup([
      toolRound([{ id: 'f1', name: 'echo', arguments: '{"value":1}' }]),
      textRound('Done.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 2, toolBudgetRemindAt: [32, 16] },
    })) { /* drain */ }

    expect(requestText(state, 1)).not.toContain('calls remain')
  })

  it('tells a model that ran out what to do instead of only what happened', async () => {
    const state = await setup([
      toolRound([
        { id: 'o1', name: 'echo', arguments: '{"value":1}' },
        { id: 'o2', name: 'echo', arguments: '{"value":2}' },
      ]),
      textRound('Answered from what I had.'),
    ])

    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolCalls: 1 },
    })) { /* drain */ }

    // "No remaining budget" alone is not something a model can act on: its
    // usual recovery is to retry, and a retry spends calls that do not exist.
    // Read from the whole request: this arrives as a tool result, not as text.
    const text = JSON.stringify(state.adapter.requests[1])
    expect(text).toContain('the turn has spent its tool-call budget')
    expect(text).toContain('do not retry it')
    expect(text).toContain('Answer now from what you already have')
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
    // Declined for the TOKEN budget, and it says so: a model told its call
    // limit ran out learns to ask for fewer calls, which changes nothing here.
    expect(result?.event.kind === 'tool-result' && result.event.result).toMatchObject({
      isError: false, meta: { declined: true, reason: 'tokens' },
    })
    const declined = JSON.stringify(result?.event.kind === 'tool-result' && result.event.result)
    expect(declined).toContain('spent its token budget')
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
        resolved = approvals.resolve(event.request.approvalRequestId, 'allow')
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

  it('drops a repeated provider tool-call id and runs the first one', async () => {
    // A result pairs to exactly one call, so two calls sharing an id cannot both
    // be answered — but the FIRST is real work, and failing the turn threw it
    // away along with everything the model had done to get there.
    const state = await setup([
      toolRound([
        { id: 'duplicate-live', name: 'echo', arguments: '{"value":1}' },
        { id: 'duplicate-live', name: 'echo', arguments: '{"value":2}' },
      ]),
      textRound('carried on'),
    ])
    let outcome: Extract<AgentEvent, { type: 'turn-end' }>['outcome'] | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools,
    })) if (event.type === 'turn-end') outcome = event.outcome

    expect(outcome?.reason).toEqual({ kind: 'completed' })
    expect(outcome?.toolCalls).toBe(1)
    expect(() => History.fromSnapshot(state.history.snapshot())).not.toThrow()
    const calls = state.history.entries().filter(entry => entry.event.kind === 'tool-call')
    expect(calls).toHaveLength(1)
    // Told, rather than left to read one result for two calls as a tool that
    // ignored it.
    expect(requestText(state, 1)).toContain('reused the tool-call id')
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

  it.each(['stop', 'aborted'] as const)('preserves partial text beside an unfinished extension (%s)', async kind => {
    const state = await setup([[
      { type: 'text-delta', index: 17, text: '   ' },
      { type: 'text-delta', index: 3, text: 'Verified evidence before interruption.' },
      { type: 'block-start', index: 29, blockType: 'extension' } as unknown as StreamChunk,
      kind === 'stop' ? { type: 'finish', reason: { kind } }
        : { type: 'finish', reason: { kind, failure: { code: 'ABORTED', message: 'Stopped' } } },
    ]])
    const events: AgentEvent[] = []
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
    })) events.push(event)
    expect(events.filter(event => event.type === 'text-end')).toMatchObject([
      { index: 3, text: 'Verified evidence before interruption.', incomplete: true },
    ])
    const terminal = events.at(-1)
    expect(terminal?.type === 'turn-end' && terminal.outcome.reason.kind).toBe(kind === 'stop' ? 'error' : 'aborted')
    expect(terminal?.type === 'turn-end' && terminal.outcome.text).toBe('Verified evidence before interruption.')
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

describe('exhaustion policy configuration', () => {
  it('accepts the three policies and rejects anything else', () => {
    for (const onExhausted of ['force-final-answer', 'stop', 'continue'] as const) {
      expect(resolveBounds({ onExhausted }).onExhausted).toBe(onExhausted)
      expect(resolveRuntimeLimits({ onExhausted }).onExhausted).toBe(onExhausted)
    }
    // A typo here would silently keep the wall up, which is the behaviour the
    // caller was trying to turn off.
    expect(() => resolveBounds({ onExhausted: 'carry-on' as never })).toThrow(RangeError)
    expect(() => resolveRuntimeLimits({ onExhausted: 'carry-on' as never })).toThrow(RangeError)
  })
})
