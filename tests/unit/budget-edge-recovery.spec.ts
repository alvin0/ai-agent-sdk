import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { History, ToolRegistry, defineTool, runAgent, UNCHANGED_ANSWER_MARKER, type AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import {
  ModelAdapter, ModelRegistry, ToolCallId, createTextMessage, withRetry, withoutRunReport,
  type GenerateOptions, type ResolvedModelInfo, type RuntimeAgentRunEvent, type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'

class Scripted extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
}

const reasoning: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'thinking' },
]
const failed: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'response failed' } } }
const answer: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: 'thinking again' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking again' } },
  { type: 'text-delta', index: 1, text: 'Answer.' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'Answer.' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

async function drain(adapter: ModelAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'test', model: 'm', messages: [createTextMessage('hi')] })) chunks.push(chunk)
  return chunks
}

const noWait = { policy: { mode: 'normal' as const, maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1 } } }

describe('withRetry reasoning prefix', () => {
  it('by default does not retry once reasoning has streamed', async () => {
    const inner = new Scripted([[...reasoning, failed], answer])
    const chunks = await drain(withRetry(inner, noWait))
    expect(inner.requests).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
  })

  it('retries a failure while only reasoning, without duplicating the failed reasoning', async () => {
    const inner = new Scripted([[...reasoning, failed], answer])
    const chunks = await drain(withRetry(inner, { ...noWait, bufferReasoningPrefix: true }))
    expect(inner.requests).toHaveLength(2)
    expect(chunks).toEqual(answer)
  })

  it('never retries once answer text has streamed', async () => {
    const inner = new Scripted([[...reasoning, { type: 'text-delta', index: 1, text: 'Part' }, failed], answer])
    const chunks = await drain(withRetry(inner, { ...noWait, bufferReasoningPrefix: true }))
    expect(inner.requests).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta')).toHaveLength(1)
  })

  it('forwards everything once the cap is reached', async () => {
    const inner = new Scripted([[...reasoning, { type: 'reasoning-delta', index: 0, text: 'more' }, failed], answer])
    const chunks = await drain(withRetry(inner, { ...noWait, bufferReasoningPrefix: { maxChunks: 2 } }))
    expect(inner.requests).toHaveLength(1)
    expect(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.type === 'reasoning-delta' && chunk.text))
      .toEqual(['thinking', 'more'])
  })

  it('preserves repeated chunk references when the reasoning cap is reached', async () => {
    const delta: StreamChunk = { type: 'reasoning-delta', index: 0, text: 'again' }
    const rounds: StreamChunk[] = [reasoning[0]!, delta, delta, failed]
    const inner = new Scripted([rounds])
    expect(await drain(withRetry(inner, { ...noWait, bufferReasoningPrefix: { maxChunks: 2 } }))).toEqual(rounds)
  })

  it('rejects an invalid reasoning cap before opening a provider stream', async () => {
    const inner = new Scripted([answer])
    await expect(drain(withRetry(inner, { ...noWait, bufferReasoningPrefix: { maxChunks: 0 } })))
      .rejects.toThrow('maxChunks must be a positive safe integer')
    expect(inner.requests).toHaveLength(0)
  })
})

describe('withoutRunReport', () => {
  it('removes the run report from terminal events only', () => {
    const base = { schemaVersion: 1 as const, runId: 'r', traceId: 't', sequence: 1 }
    const error = { ...base, type: 'error', error: { code: 'SERVER', stage: 'model', message: 'x' }, report: { secret: true } } as unknown as RuntimeAgentRunEvent
    expect(withoutRunReport(error)).not.toHaveProperty('report')
    expect(withoutRunReport(error)).toMatchObject({ type: 'error', error: { code: 'SERVER' } })
    const delta = { ...base, type: 'assistant-delta', text: 'hi', index: 0, blockId: 'b', phase: 'final-answer' } as unknown as RuntimeAgentRunEvent
    expect(withoutRunReport(delta)).toBe(delta)
  })
})

describe('final round retry', () => {
  it('retries a transient failure of the forced final answer through the request hook', async () => {
    const registry = new ModelRegistry()
    const adapter = new Scripted([
      [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('e1'), name: 'echo', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } }],
      [failed],
      [{ type: 'text-delta', index: 0, text: 'Forced.' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'Forced.' } },
        { type: 'finish', reason: { kind: 'stop' } }],
    ])
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('go') })
    const tools = new ToolRegistry()
    tools.register(defineTool({ name: 'echo', description: 'Echo.', parameters: { type: 'object' }, execute: () => ({ ok: true }) }))
    let retries = 0
    const events: AgentRunEvent[] = []
    for await (const event of runAgent({ mode: 'basic', registry, history, tools, config: { provider: 'test', model: 'm' }, maxTurns: 1,
      hooks: { onRequestError: () => { retries++; return 'retry' } } })) events.push(event)
    expect(retries).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'agent-end', outcome: {
      text: 'Forced.', reason: { kind: 'budget-exhausted', budget: 'steps', forcedFinalAnswer: true },
    } })
  })
})

describe('budget edges across modes', () => {
  const text = (value: string): StreamChunk[] => [
    { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const call = (id: string, name: string, args: unknown = {}): StreamChunk[] => [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  async function run(rounds: readonly (readonly StreamChunk[])[], options: Record<string, unknown>) {
    const registry = new ModelRegistry()
    const adapter = new Scripted(rounds)
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('go') })
    const tools = new ToolRegistry()
    tools.register(defineTool({ name: 'echo', description: 'Echo.', parameters: { type: 'object' }, execute: () => ({ ok: true }) }))
    const events: AgentRunEvent[] = []
    for await (const event of runAgent({ registry, history, tools, config: { provider: 'test', model: 'm' }, ...options } as never)) events.push(event)
    return { adapter, history, events, end: events.at(-1) }
  }

  it('confirms a plain answer written on the last work step', async () => {
    const { end } = await run([call('e1', 'echo'), text('Answer.'),
      call('s', 'submit_result', { summary: 'Checked.', evidence: ['echo'] }), text('Answer.')], { mode: 'deep', maxTurns: 2 })
    expect(end).toMatchObject({ outcome: { completed: true, text: 'Answer.', reason: { kind: 'completed' } } })
  })

  it('keeps the forced answer when the window ends on a note instead of a confirmation', async () => {
    const { end } = await run([call('e1', 'echo'), text('Substantive answer [1].'), text('Not supported: missing X.')], { mode: 'deep', maxTurns: 1 })
    expect(end).toMatchObject({ outcome: { completed: false, text: 'Substantive answer [1].' } })
  })

  it('does not void an accepted submission with a call an interceptor denied', async () => {
    const { adapter, end } = await run([call('e1', 'echo'), call('s', 'submit_result', { summary: 'Checked.', evidence: ['echo'] }),
      call('e2', 'echo', { again: true }), text('Final.')], {
      mode: 'deep', maxTurns: 6,
      interceptors: [{ name: 'deadline', before: async (ctx: { rawArguments: string }) => ctx.rawArguments.includes('again')
        ? { kind: 'deny', reason: 'deadline passed' } : { kind: 'allow' } }],
    })
    expect(end).toMatchObject({ outcome: { completed: true, text: 'Final.' } })
    expect(adapter.requests).toHaveLength(4)
  })

  it('a retried request does not leave its half-written answer in history', async () => {
    const broken: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'The fine is 5 and' },
      { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'down' } } }]
    const { adapter, end } = await run([broken, text('The fine is 5 million, from 2024.')],
      { mode: 'basic', maxTurns: 2, hooks: { onRequestError: () => 'retry' } })
    expect(end).toMatchObject({ outcome: { completed: true, text: 'The fine is 5 million, from 2024.' } })
    expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('The fine is 5 and')
  })

  it.each(['forced', 'structured'] as const)('does not retry a %s finalizer after its failed call spends the token budget', async kind => {
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } }
    const hook = vi.fn(() => 'retry' as const)
    const { adapter, end } = await run([
      kind === 'forced' ? call('e1', 'echo') : text('Evidence gathered.'),
      [usage, failed], text('Should never be requested.'),
    ], { mode: 'basic', maxTurns: kind === 'forced' ? 1 : 4,
      bounds: { maxTotalTokens: 10 }, hooks: { onRequestError: hook },
      ...kind === 'structured' ? { outputFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } } } : {},
    })
    expect(adapter.requests).toHaveLength(2)
    expect(hook).not.toHaveBeenCalled()
    expect(end).toMatchObject({ outcome: { usageReport: { budgetTokens: 10 } } })
  })

  it.each(['forced', 'structured'] as const)('keeps cancellation during a %s finalizer retry hook as an aborted turn', async kind => {
    const controller = new AbortController()
    const { adapter, history, end } = await run([
      kind === 'forced' ? call('e1', 'echo') : text('Evidence gathered.'), [failed], text('Should never be requested.'),
    ], { mode: 'basic', maxTurns: kind === 'forced' ? 1 : 4, signal: controller.signal,
      hooks: { onRequestError: () => { controller.abort(new Error('cancelled during backoff')); throw controller.signal.reason } },
      ...kind === 'structured' ? { outputFormat: { type: 'json_schema', name: 'result', schema: { type: 'object' } } } : {},
    })
    expect(adapter.requests).toHaveLength(2)
    expect(end).toMatchObject({ outcome: { reason: { kind: 'aborted' } } })
    expect(history.messages().at(-1)?.source).toEqual({ kind: 'app', producer: 'turn-interrupted' })
  })

  it('does not request another empty finalizer after its usage spends the token budget', async () => {
    const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } }
    const { adapter, end } = await run([call('e1', 'echo'), [...text('').slice(0, -1), usage, { type: 'finish', reason: { kind: 'stop' } }],
      text('Should never be requested.')], { mode: 'basic', maxTurns: 1, bounds: { maxTotalTokens: 10 } })
    expect(adapter.requests).toHaveLength(2)
    expect(end).toMatchObject({ outcome: { text: '', reason: { kind: 'budget-exhausted', forcedFinalAnswer: false } } })
  })

  it('reports no forced answer when both tools-off replies are empty', async () => {
    const { adapter, end } = await run([call('e1', 'echo'), text(''), text('')], { mode: 'basic', maxTurns: 1 })
    expect(adapter.requests).toHaveLength(3)
    expect(end).toMatchObject({ outcome: { text: '', reason: { kind: 'budget-exhausted', forcedFinalAnswer: false } } })
  })

  it('a question that is not answered in time is not the person dismissing it', async () => {
    const { createUserInputBroker } = await import('@alvin0/ai-agent-sdk-core/agent')
    const broker = createUserInputBroker()
    const { end, history } = await run([
      call('q', 'request_user_input', { questions: [{ id: 'q1', header: 'Scope', question: 'Which year?', options: [
        { label: '2024', description: 'Last year' }, { label: '2025', description: 'This year' }] }] }),
      call('s', 'submit_result', { summary: 'Assumed 2025.', evidence: ['no answer'] }), text('Answer for 2025.'),
    ], { mode: 'deep-human-in-loop', userInput: broker, userInputTimeoutMs: 20, maxTurns: 6, bounds: { maxToolDurationMs: 10 } })
    expect(end).toMatchObject({ outcome: { completed: true, text: 'Answer for 2025.' } })
    expect(JSON.stringify(history.messages())).toContain('did not answer within')
  })

  it('the broker refuses an answer that does not fit the questions and keeps them open', async () => {
    const { createUserInputBroker } = await import('@alvin0/ai-agent-sdk-core/agent')
    const broker = createUserInputBroker()
    const request = { requestId: ToolCallId('r'), callId: ToolCallId('r'), turn: 1, step: 1, isBlocking: true as const,
      questions: [{ id: 'q1', header: 'H', question: 'Q?', options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }] }] }
    const pending = broker.request(request as never)
    expect(broker.resolve(ToolCallId('r'), { answers: { other: { answers: ['x'] } } } as never)).toBe(false)
    expect(broker.pending()).toHaveLength(1)
    expect(broker.resolve(ToolCallId('r'), { answers: { q1: { answers: ['a'] } } })).toBe(true)
    await expect(pending).resolves.toMatchObject({ answers: { q1: { answers: ['a'] } } })
  })
})

describe('a spent budget ends with an answer', () => {
  const text = (value: string): StreamChunk[] => [
    { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const call = (id: string): StreamChunk[] => [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name: 'slow', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  async function run(rounds: readonly (readonly StreamChunk[])[], options: Record<string, unknown>) {
    const registry = new ModelRegistry()
    const adapter = new Scripted(rounds)
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('go') })
    const tools = new ToolRegistry()
    tools.register(defineTool({ name: 'slow', description: 'Slow.', parameters: { type: 'object' },
      execute: async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { ok: true } } }))
    const events: AgentRunEvent[] = []
    for await (const event of runAgent({ registry, history, tools, config: { provider: 'test', model: 'm' }, ...options } as never)) events.push(event)
    return { adapter, history, end: events.at(-1) }
  }

  it('answers when the time budget passes instead of being cancelled', async () => {
    const { adapter, end } = await run([call('a'), text('Answer from what was found.')],
      { mode: 'basic', maxTurns: 10, bounds: { maxTurnDurationMs: 30 } })
    expect(end).toMatchObject({ outcome: { text: 'Answer from what was found.',
      reason: { kind: 'budget-exhausted', budget: 'time', forcedFinalAnswer: true } } })
    expect(adapter.requests.at(-1)?.toolChoice).toBe('none')
  })

  it('does not charge a wait for a person to the time budget', async () => {
    const { createUserInputBroker } = await import('@alvin0/ai-agent-sdk-core/agent')
    const broker = createUserInputBroker()
    broker.onRequest(request => { setTimeout(() => broker.resolve(request.requestId, { answers: { q1: { answers: ['2025'] } } }), 60) })
    const ask: StreamChunk[] = [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('q'), name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{ id: 'q1', header: 'Year', question: 'Which year?', options: [
        { label: '2024', description: 'Last' }, { label: '2025', description: 'This' }] }] }) } },
      { type: 'finish', reason: { kind: 'tool-calls' } }]
    const submit: StreamChunk[] = [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('s'), name: 'submit_result',
      arguments: JSON.stringify({ summary: 'Asked.', evidence: ['answer 2025'] }) } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
    const { end } = await run([ask, submit, text('Answer for 2025.')],
      { mode: 'deep-human-in-loop', userInput: broker, maxTurns: 6, bounds: { maxTurnDurationMs: 50 } })
    expect(end).toMatchObject({ outcome: { completed: true, text: 'Answer for 2025.' } })
  })

  it('asks once more when the forced answer comes back empty', async () => {
    const { adapter, end } = await run([call('a'), text(''), text('Answer on the second try.')], { mode: 'basic', maxTurns: 1 })
    expect(end).toMatchObject({ outcome: { text: 'Answer on the second try.', reason: { kind: 'budget-exhausted', forcedFinalAnswer: true } } })
    expect(adapter.requests).toHaveLength(3)
  })
})

describe('review findings on the budget-edge changes', () => {
  const text = (value: string): StreamChunk[] => [
    { type: 'text-delta', index: 0, text: value }, { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const call = (id: string, name: string, args: unknown = {}): StreamChunk[] => [
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  class Slow extends Scripted {
    constructor(rounds: readonly (readonly StreamChunk[])[], private readonly delayMs: number) { super(rounds) }
    override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      await new Promise(resolve => setTimeout(resolve, this.delayMs))
      yield * super.stream(options)
    }
  }
  async function run(adapter: Scripted, options: Record<string, unknown>, executed?: () => void) {
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('go') })
    const tools = new ToolRegistry()
    tools.register(defineTool({ name: 'echo', description: 'Echo.', parameters: { type: 'object' }, execute: () => { executed?.(); return { ok: true } } }))
    const events: AgentRunEvent[] = []
    for await (const event of runAgent({ registry, history, tools, config: { provider: 'test', model: 'm' }, ...options } as never)) events.push(event)
    return { history, events, end: events.at(-1) }
  }
  const lastAssistantText = (history: History) => history.messages().filter(m => m.role === 'assistant').at(-1)
    ?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')

  it('the kept forced answer is also the last assistant message', async () => {
    const { history, events, end } = await run(new Scripted([call('e1', 'echo'), text('Substantive answer [1].'), text('Not supported: missing X.')]),
      { mode: 'deep', maxTurns: 1 })
    expect(end).toMatchObject({ outcome: { text: 'Substantive answer [1].' } })
    expect(lastAssistantText(history)).toBe('Substantive answer [1].')
    const lastMessage = events.filter(event => event.type === 'assistant-message').at(-1)
    expect(lastMessage?.type === 'assistant-message' && lastMessage.message.content).toEqual([{ type: 'text', text: 'Substantive answer [1].', phase: 'final-answer' }])
  })

  it('preserves app provenance when restoring a sanitized answer after finalize', async () => {
    const { history, events, end } = await run(new Scripted([
      text(`${UNCHANGED_ANSWER_MARKER} Answer.`), text('Not supported: missing X.'),
    ]), { mode: 'deep', maxTurns: 1 })
    expect(end).toMatchObject({ outcome: { text: 'Answer.', completed: false } })
    expect(lastAssistantText(history)).toBe('Answer.')
    const lastMessage = events.filter(event => event.type === 'assistant-message').at(-1)
    expect(lastMessage).toMatchObject({ message: { source: { kind: 'app', producer: 'deep-mode-kept-answer' } } })
    // The persisted result must also remain a valid replayable snapshot.
    expect(() => History.fromSnapshot(history.snapshot())).not.toThrow()
  })

  it('observes late broker rejection when timeout wins during event backpressure', async () => {
    await expect(promisify(execFile)(process.execPath, [
      '--unhandled-rejections=strict', fileURLToPath(new URL('../fixtures/user-input-backpressure.mjs', import.meta.url)),
    ], { timeout: 10_000 })).resolves.toMatchObject({ stdout: 'broker backpressure regression passed\n' })
  })

  it('charges work in a batch that also waits for a person', async () => {
    let clock = 0
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const adapter = new Scripted([
        [...call('q', 'ask').slice(0, -1), ...call('w', 'work').map(chunk =>
          chunk.type === 'block-end' ? { ...chunk, index: 1 } : chunk)], text('Answer from the available evidence.'),
      ])
      const registry = new ModelRegistry()
      registry.registerAdapter(['test'], adapter)
      const history = new History()
      history.append({ kind: 'user', message: createTextMessage('go') })
      const tools = new ToolRegistry()
      tools.register(defineTool({ name: 'ask', description: 'Wait for a person.', parameters: { type: 'object' },
        awaitsPerson: true, execute: () => { clock += 15; return { answered: true } } }))
      tools.register(defineTool({ name: 'work', description: 'Work.', parameters: { type: 'object' },
        execute: () => { clock += 65; return { done: true } } }))
      const events: AgentRunEvent[] = []
      for await (const event of runAgent({ mode: 'basic', registry, history, tools, config: { provider: 'test', model: 'm' },
        maxTurns: 5, bounds: { maxTurnDurationMs: 30 } })) events.push(event)
      expect(events.at(-1)).toMatchObject({ outcome: { reason: { kind: 'budget-exhausted', budget: 'time' } } })
      expect(adapter.requests[1]?.toolChoice).toBe('none')
    } finally { time.mockRestore() }
  })

  it('charges work that overlaps a parallel wait for a person', async () => {
    let clock = 0
    let answer!: () => void
    const time = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      const adapter = new Scripted([
        [...call('q', 'ask').slice(0, -1), ...call('w', 'work').map(chunk =>
          chunk.type === 'block-end' ? { ...chunk, index: 1 } : chunk)], text('Answer from the available evidence.'),
      ])
      const registry = new ModelRegistry()
      registry.registerAdapter(['test'], adapter)
      const history = new History()
      history.append({ kind: 'user', message: createTextMessage('go') })
      const tools = new ToolRegistry()
      tools.register(defineTool({ name: 'ask', description: 'Wait for a person.', parameters: { type: 'object' },
        awaitsPerson: true, isConcurrencySafe: () => true, execute: async () => {
          await new Promise<void>(resolve => { answer = resolve })
          return { answered: true }
        } }))
      tools.register(defineTool({ name: 'work', description: 'Work.', parameters: { type: 'object' },
        isConcurrencySafe: () => true, execute: () => { clock += 65; answer(); return { done: true } } }))
      const events: AgentRunEvent[] = []
      for await (const event of runAgent({ mode: 'basic', registry, history, tools, config: { provider: 'test', model: 'm' },
        maxTurns: 5, bounds: { maxTurnDurationMs: 30 } })) events.push(event)
      expect(events.at(-1)).toMatchObject({ outcome: { reason: { kind: 'budget-exhausted', budget: 'time' } } })
      expect(adapter.requests[1]?.toolChoice).toBe('none')
    } finally { time.mockRestore() }
  })

  it('the question wait holds even for a broker that ignores the signal', async () => {
    const { fixedUserInputBroker } = await import('@alvin0/ai-agent-sdk-core/agent')
    const late = fixedUserInputBroker(() => new Promise(resolve => setTimeout(() => resolve({ answers: { q1: { answers: ['2024'] } } }), 80)))
    const never = fixedUserInputBroker(() => new Promise(() => {}))
    for (const broker of [late, never]) {
      const { history, end } = await run(new Scripted([
        call('q', 'request_user_input', { questions: [{ id: 'q1', header: 'Year', question: 'Which year?', options: [
          { label: '2024', description: 'Last' }, { label: '2025', description: 'This' }] }] }),
        call('s', 'submit_result', { summary: 'Assumed.', evidence: ['no answer'] }), text('Answer on an assumption.'),
      ]), { mode: 'deep-human-in-loop', userInput: broker, userInputTimeoutMs: 10, maxTurns: 6 })
      expect(end).toMatchObject({ outcome: { completed: true, text: 'Answer on an assumption.' } })
      expect(JSON.stringify(history.messages())).toContain('did not answer within')
    }
  })

  it('a model round that ran past the time budget starts no tool', async () => {
    let executed = 0
    const { end } = await run(new Slow([call('e1', 'echo'), text('Answer without new work.')], 40),
      { mode: 'basic', maxTurns: 6, bounds: { maxTurnDurationMs: 20 } }, () => { executed++ })
    expect(executed).toBe(0)
    expect(end).toMatchObject({ outcome: { text: 'Answer without new work.', reason: { kind: 'budget-exhausted', budget: 'time' } } })
  })

  it('a null answer leaves the question open instead of throwing', async () => {
    const { createUserInputBroker } = await import('@alvin0/ai-agent-sdk-core/agent')
    const broker = createUserInputBroker()
    const request = { requestId: ToolCallId('r'), callId: ToolCallId('r'), turn: 1, step: 1, isBlocking: true as const,
      questions: [{ id: 'q1', header: 'H', question: 'Q?', options: [{ label: 'a', description: 'A' }, { label: 'b', description: 'B' }] }] }
    void broker.request(request as never)
    expect(broker.resolve(ToolCallId('r'), { answers: { q1: null } } as never)).toBe(false)
    expect(broker.pending()).toHaveLength(1)
  })
})
