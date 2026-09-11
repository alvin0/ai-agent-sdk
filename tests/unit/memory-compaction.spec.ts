import { describe, expect, it } from 'vitest'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { History } from '@alvin0/ai-agent-sdk-core/agent'
import {
  AgentMemory,
  ContextCompactor,
  estimateMessageTokens,
  resolveCompactionConfig,
  selectCompactablePrefix,
} from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions } from '@alvin0/ai-agent-sdk-core'
import type { ResolvedModelInfo } from '@alvin0/ai-agent-sdk-core'
import {
  createMessage,
  createTextMessage,
  createToolResultMessage,
} from '@alvin0/ai-agent-sdk-core'
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
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      context: { contextWindow: 2_000 },
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

class NoContextScriptedAdapter extends ScriptedAdapter {
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

class OutputReservedAdapter extends ScriptedAdapter {
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      context: { contextWindow: 2_000 },
      defaultMaxTokens: 1_200,
      maxOutputTokens: 1_200,
    })
  }
}

class AbortAfterTextAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly controller: AbortController) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = '## Primary Request and Intent\n- Preserve the goal.\n## Next Step\n- Continue.'
    yield { type: 'text-delta', index: 0, text }
    this.controller.abort(new Error('stress abort during compaction'))
    // Deliberately violate the adapter cancellation contract. Core still must
    // not commit a checkpoint after its caller has aborted.
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({
      provider, id: model, name: model,
      context: { contextWindow: 2_000 },
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium },
    })
  }
}

function textRound(text: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage === undefined ? [] : [{ type: 'usage', usage } as const]),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function overflowRound(): StreamChunk[] {
  return [{
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'request exceeded the context window' },
    },
  }]
}

function setup(rounds: readonly (readonly StreamChunk[])[]) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return { adapter, registry }
}

function compactingAgent(auto = true) {
  return defineAgent({
    id: 'long-task', provider: 'test', model: 'scripted',
    instructions: 'Continue the task from established evidence.',
    maxTurns: 6,
    compaction: {
      auto,
      maxInputTokens: 100,
      retainTokens: 10,
      compactionRetries: 0,
      maxOverflowRetries: 1,
      maxSummaryTokens: 512,
    },
  })
}

describe('agent task memory', () => {
  it('captures the original objective, supports explicit facts, and survives snapshots', () => {
    const memory = new AgentMemory()
    memory.captureOriginalObjective(createTextMessage('Migrate the billing service without changing its API.'))
    const decision = memory.remember({ kind: 'decision', content: 'Use an outbox for delivery.' })
    memory.remember({ id: decision.id, kind: 'decision', content: 'Use a transactional outbox.' })

    const restored = AgentMemory.fromSnapshot(JSON.parse(JSON.stringify(memory.snapshot())) as never)

    expect(restored.items()).toHaveLength(2)
    expect(restored.items().find(item => item.id === decision.id)?.content).toBe('Use a transactional outbox.')
    expect(restored.render()).toContain('Migrate the billing service without changing its API.')
    expect(restored.render()).toContain('transactional outbox')
  })

  it('bounds injected memory while keeping the objective first', () => {
    const memory = new AgentMemory([
      { kind: 'fact', content: 'x'.repeat(2_000) },
      { kind: 'objective', content: 'Keep the public API stable.' },
    ])

    const rendered = memory.render(300)

    expect(rendered.length).toBeLessThanOrEqual(300)
    expect(rendered.indexOf('- objective')).toBeLessThan(rendered.indexOf('- fact'))
    expect(rendered).toContain('Keep the public API stable.')
  })

  it('bounds retained memory records as well as rendered injection', () => {
    const memory = new AgentMemory([], {
      maxItems: 2, maxItemChars: 10, maxStoredChars: 15,
    })
    memory.remember({ id: 'one', kind: 'fact', content: '1234567890' })
    expect(() => memory.remember({ id: 'two', kind: 'fact', content: '123456' })).toThrow(/character limit/)
    expect(() => memory.remember({ id: 'huge', kind: 'fact', content: 'x'.repeat(11) })).toThrow(/character limit/)
    memory.remember({ id: 'two', kind: 'fact', content: '12345' })
    expect(() => memory.remember({ id: 'three', kind: 'fact', content: 'x' })).toThrow(/item limit/)
  })

  it('truncates an automatically captured objective to its storage policy', () => {
    const memory = new AgentMemory([], {
      maxItems: 2, maxItemChars: 32, maxStoredChars: 64,
    })
    memory.captureOriginalObjective(createTextMessage('objective '.repeat(100)))
    expect(memory.items()[0]?.content.length).toBeLessThanOrEqual(32)
  })

  it('rejects duplicate ids and oversized restored memory snapshots', () => {
    const item = {
      id: 'same', kind: 'fact' as const, content: 'ok',
      createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
    }
    expect(() => AgentMemory.fromSnapshot({ version: 1, items: [item, item] })).toThrow(/duplicate/)
    expect(() => AgentMemory.fromSnapshot(
      { version: 1, items: [{ ...item, content: 'x'.repeat(20) }] },
      { maxItems: 2, maxItemChars: 10, maxStoredChars: 20 },
    )).toThrow(/character limit/)
  })

  it('canonicalizes restored memory and rejects unbounded timestamp metadata', () => {
    const item = {
      id: 'safe', kind: 'fact' as const, content: 'bounded',
      createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
      ignoredPayload: 'x'.repeat(100_000),
    }
    const restored = AgentMemory.fromSnapshot({ version: 1, items: [item] })
    expect(restored.snapshot().items[0]).toEqual({
      id: 'safe', kind: 'fact', content: 'bounded',
      createdAt: item.createdAt, updatedAt: item.updatedAt,
    })
    expect(() => AgentMemory.fromSnapshot({
      version: 1,
      items: [{ ...item, createdAt: 'x'.repeat(65) }],
    })).toThrow(/bounded ISO date strings/)
    expect(() => AgentMemory.fromSnapshot({
      version: 1,
      items: [{ ...item, createdAt: 'August 31, 2026' }],
    })).toThrow(/bounded ISO date strings/)
  })

  it('does not advance generated ids when a memory write is rejected', () => {
    const memory = new AgentMemory([], { maxItems: 2, maxItemChars: 8, maxStoredChars: 8 })
    expect(() => memory.remember({ id: 'memory-99', kind: 'fact', content: 'too-large' }))
      .toThrow(/character limit/)
    expect(memory.remember({ kind: 'fact', content: 'ok' }).id).toBe('memory-1')
  })

  it('rejects an over-budget or colliding seed when the agent is defined', () => {
    expect(() => defineAgent({
      id: 'bad-memory-size', instructions: 'Validate memory.',
      memory: {
        maxItems: 2, maxItemChars: 5, maxStoredChars: 10,
        seed: [{ kind: 'fact', content: 'too-long' }],
      },
    })).toThrow(/seed.*character limit/)
    expect(() => defineAgent({
      id: 'bad-memory-id', instructions: 'Validate memory.',
      memory: {
        seed: [
          { kind: 'fact', content: 'first' },
          { id: 'memory-1', kind: 'fact', content: 'collision' },
        ],
      },
    })).toThrow(/duplicate agent memory seed id/)
  })

  it('costs an image by its detail budget, not by its payload size', () => {
    // Providers bill an image by pixel area, never by bytes, so a big payload must
    // not inflate the estimate: 40 KB of base64 can be a 512x512 screenshot.
    const image = (data: string, detail?: 'low' | 'high' | 'original') => createMessage({
      role: 'user', source: { kind: 'user' },
      content: [{
        type: 'image',
        source: { kind: 'base64', mediaType: 'image/png', data },
        ...(detail === undefined ? {} : { detail }),
      }],
    })
    expect(estimateMessageTokens(image('A'.repeat(40_000))))
      .toBe(estimateMessageTokens(image('A'.repeat(400))))

    // The detail level is the one sizing fact a block carries, and it bounds cost.
    const low = estimateMessageTokens(image('A', 'low'))
    const high = estimateMessageTokens(image('A', 'high'))
    const original = estimateMessageTokens(image('A', 'original'))
    expect(low).toBeLessThan(high)
    expect(high).toBeLessThan(original)
    // Anthropic caps an image near 1,600 tokens and OpenAI's high budget is
    // 2,500 patches x 1.2; a high-detail image must land in that neighbourhood
    // rather than the tens of thousands a byte-derived estimate produced.
    expect(high).toBeGreaterThan(1_000)
    expect(high).toBeLessThan(4_000)
  })

  it('costs a document per page, exactly when the page count is declared', () => {
    const document = (pages?: number) => createMessage({
      role: 'user', source: { kind: 'user' },
      content: [{
        type: 'document',
        source: { kind: 'base64', mediaType: 'application/pdf', data: 'A'.repeat(40_000) },
        ...(pages === undefined ? {} : { pages }),
      }],
    })
    const onePage = estimateMessageTokens(document(1))
    const tenPages = estimateMessageTokens(document(10))
    expect(tenPages - 4).toBe((onePage - 4) * 10)
    // A 200-page PDF must dominate a 1-page one, which a byte-derived estimate
    // could not express at all: both can be the same number of bytes.
    expect(estimateMessageTokens(document(200))).toBeGreaterThan(tenPages)
    // Without a declared count the estimate is a documented assumption, and must
    // still be substantial rather than a token floor.
    expect(estimateMessageTokens(document())).toBeGreaterThan(onePage)
  })
})

describe('agent context compaction', () => {
  it('reserves declared model output headroom when computing the input threshold', async () => {
    const adapter = new OutputReservedAdapter([textRound(
      '## Primary Request and Intent\n- Keep the objective.\n## Next Step\n- Continue.',
    )])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(8_000)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'm' },
        content: [{ type: 'text', text: `Progress ${'B'.repeat(4_000)}` }],
      }),
    })
    const compactor = new ContextCompactor({
      registry, config: { provider: 'test', model: 'm' }, history: () => history,
      system: () => '', tools: () => [],
      policy: resolveCompactionConfig({ auto: false, thresholdRatio: 0.8, retainTokens: 10 }),
    })

    const result = await compactor.compactNow()
    expect(result?.thresholdTokens).toBe(800)
    expect(adapter.requests[0]?.maxTokens).toBe(1_200)
  })

  it('creates a structured checkpoint, preserves transcript, and streams lifecycle events', async () => {
    const original = `Build the migration safely. ${'original constraint '.repeat(35)}`
    const firstAnswer = `Inspected the existing implementation. ${'evidence '.repeat(45)}`
    const summary = [
      '## Primary Request and Intent', '- Build the migration safely.',
      '## Progress and Completed Work', '- Inspected implementation.',
      '## Next Step', '- Continue the migration.',
    ].join('\n')
    const state = setup([
      textRound(firstAnswer),
      textRound(summary),
      textRound('Continued from the checkpoint.'),
    ])
    const session = compactingAgent().createSession({ registry: state.registry })
    await session.run(original)
    session.memory.remember({ kind: 'constraint', content: 'Do not change the public API.' })

    const eventTypes: string[] = []
    const spanKinds: string[] = []
    for await (const event of session.stream('Continue with the next step.')) {
      eventTypes.push(event.type)
      if (event.type === 'span-start') spanKinds.push(event.kind)
    }

    expect(eventTypes).toContain('compaction-start')
    expect(eventTypes).toContain('compaction-end')
    expect(spanKinds).toContain('compact')
    expect(state.adapter.requests).toHaveLength(3)
    expect(state.adapter.requests[1]?.toolChoice).toBe('none')
    expect(state.adapter.requests[1]?.messages.at(-1)?.content)
      .toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining('Primary Request and Intent') }))
    expect(state.adapter.requests[2]?.messages.flatMap(message => message.content)
      .some(block => block.type === 'text' && block.text.includes('<compacted-summary>'))).toBe(true)
    const finalRequestText = state.adapter.requests[2]?.messages.flatMap(message => message.content)
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    expect(finalRequestText).toContain('<task-memory>')
    expect(finalRequestText).toContain('Build the migration safely.')
    expect(finalRequestText).toContain('Do not change the public API.')
    expect(state.adapter.requests[2]?.system).not.toContain('<task-memory>')
    expect(session.history.entries().some(entry => entry.event.kind === 'compaction-summary')).toBe(true)
    expect(session.history.entries().some(entry =>
      entry.event.kind === 'user'
      && entry.event.message.content.some(block => block.type === 'text' && block.text === original))).toBe(true)
  })

  it('compacts and retries once after a canonical provider overflow', async () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Original objective ${'A'.repeat(600)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'text', text: `Earlier progress ${'B'.repeat(600)}` }],
      }),
    })
    const summary = '## Primary Request and Intent\n- Original objective\n## Next Step\n- Resume.'
    const state = setup([
      overflowRound(),
      textRound(summary, { inputTokens: 4, outputTokens: 1, totalTokens: 5 }),
      textRound('Recovered after compaction.', { inputTokens: 8, outputTokens: 2, totalTokens: 10 }),
    ])
    const session = compactingAgent(false).createSession({ registry: state.registry, history })

    const response = await session.run('Finish the remaining work.')

    expect(response.text).toBe('Recovered after compaction.')
    expect(state.adapter.requests).toHaveLength(3)
    expect(response.report.modelCalls, JSON.stringify(response.report.modelCalls, null, 2)).toHaveLength(3)
    expect(response.report.usage).toMatchObject({ reported: { totalTokens: 15 }, authoritative: false,
      coverage: { logicalCalls: 3, complete: 2, missing: 1 } })
    expect(response.report.operationCounts).toMatchObject({
      'model-call': { total: 3 }, compaction: { total: 1, success: 1 },
    })
    expect(session.history.generation()).toBe(1)
    expect(session.history.entries().filter(entry => entry.event.kind === 'compaction-end'))
      .toContainEqual(expect.objectContaining({ event: expect.objectContaining({ status: 'completed' }) }))
  })

  it('never splits a host tool call from its result at the retained-tail boundary', () => {
    const callId = ToolCallId('read-1')
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage('old request') })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'm' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
      }),
    })
    history.append({
      kind: 'tool-result', callId,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }),
      result: { isError: false, value: 'result', content: [{ type: 'text', text: 'result' }] },
    })
    history.append({ kind: 'user', message: createTextMessage('recent follow-up') })

    const selected = selectCompactablePrefix(history.surface(), 8)

    expect(selected.map(node => node.seq)).toEqual([1, 2, 3])
  })

  it('repairs a legacy dangling tool call before sending the compaction replay', async () => {
    const callId = ToolCallId('legacy-interrupted-call')
    const history = new History()
    history.append({
      kind: 'user',
      message: createTextMessage(`Original objective ${'A'.repeat(900)}`),
    })
    history.append({
      kind: 'assistant', interrupted: true,
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"old.txt"}' }],
      }),
    })
    history.append({ kind: 'user', message: createTextMessage('Continue safely.') })
    const state = setup([
      textRound('## Primary Request and Intent\n- Original objective\n## Next Step\n- Continue safely.'),
    ])
    const session = compactingAgent(false).createSession({ registry: state.registry, history })

    await session.compact()

    const replay = state.adapter.requests[0]?.messages ?? []
    const blocks = replay.flatMap(message => message.content)
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool-call', id: callId,
    }))
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool-result', toolCallId: callId, isError: true,
    }))
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'completed',
    })
  })

  it('records a failed manual attempt without changing the model-visible surface', async () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(600)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'text', text: `Progress ${'B'.repeat(600)}` }],
      }),
    })
    const before = history.messages()
    const state = setup([textRound('oversized summary '.repeat(200))])
    const session = compactingAgent(false).createSession({ registry: state.registry, history })

    await expect(session.compact()).rejects.toThrow(/did not shrink/)

    expect(history.generation()).toBe(0)
    expect(history.messages()).toEqual(before)
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'failed',
    })
  })

  it('backs off automatic compaction after a failed maintenance request', async () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(700)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'text', text: `Progress ${'B'.repeat(700)}` }],
      }),
    })
    const state = setup([
      overflowRound(),
      textRound('## Primary Request and Intent\n- Objective\n## Next Step\n- Continue.'),
    ])
    const compactor = new ContextCompactor({
      registry: state.registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: true, maxInputTokens: 100, retainTokens: 10,
        compactionRetries: 0, maxSummaryTokens: 512,
      }),
    })
    const controller = new AbortController()
    const check = (step: number) => compactor.beforeStep({
      turn: 1, step, messages: history.messages(), snapshot: history.snapshot(),
      signal: controller.signal, emit: async () => undefined,
    })

    await check(1)
    await check(2)
    await check(3)

    expect(state.adapter.requests).toHaveLength(1)

    await check(4)

    expect(state.adapter.requests).toHaveLength(2)
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'completed',
    })
  })

  it('does not let a stuck maintenance observer invalidate a committed checkpoint', async () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(700)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'text', text: `Progress ${'B'.repeat(700)}` }],
      }),
    })
    const state = setup([textRound('## Primary Request and Intent\n- Objective\n## Next Step\n- Continue.')])
    const compactor = new ContextCompactor({
      registry: state.registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: true, maxInputTokens: 100, retainTokens: 10,
        maxSummaryTokens: 512, teardownTimeoutMs: 10,
      }),
    })
    const started = Date.now()
    await compactor.beforeStep({
      turn: 1, step: 1, messages: history.messages(), snapshot: history.snapshot(),
      signal: new AbortController().signal,
      emit: async () => await new Promise<void>(() => {}),
    })
    expect(Date.now() - started).toBeLessThan(250)
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'completed',
    })
    expect(history.entries().filter(entry => entry.event.kind === 'compaction-end')).toHaveLength(1)
  })

  it('backs off when retained context makes the pressure threshold unreachable', async () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Old objective ${'A'.repeat(700)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'text', text: `Large retained working set ${'B'.repeat(1_200)}` }],
      }),
    })
    const state = setup([
      textRound('## Primary Request and Intent\n- Objective\n## Next Step\n- Continue.'),
      textRound('## Primary Request and Intent\n- Objective\n## Next Step\n- Continue.'),
    ])
    const events: Array<{ type: string; backoffReason?: string }> = []
    const compactor = new ContextCompactor({
      registry: state.registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: true, maxInputTokens: 100, retainTokens: 10,
        compactionRetries: 1, maxSummaryTokens: 512,
      }),
    })
    const controller = new AbortController()
    const check = (step: number) => compactor.beforeStep({
      turn: 1, step, messages: history.messages(), snapshot: history.snapshot(),
      signal: controller.signal,
      emit: async event => { events.push(event) },
    })

    await check(1)
    await check(2)
    await check(3)
    await check(4)
    await check(5)

    expect(state.adapter.requests).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'compaction-end', backoffReason: 'unreachable-threshold',
    }))
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'completed',
      backoffReason: 'unreachable-threshold', cooldownSteps: 4,
    })
  })

  it('durably prunes an oversized recent tool result before summarizing older context', async () => {
    const callId = ToolCallId('large-read')
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Old objective ${'A'.repeat(700)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
      }),
    })
    const huge = `HEAD ${'x'.repeat(2_000)} TAIL`
    history.append({
      kind: 'tool-result', callId,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: huge }], isError: false }),
      result: { isError: false, value: huge, content: [{ type: 'text', text: huge }] },
    })
    history.append({ kind: 'user', message: createTextMessage('Recent follow-up') })
    const state = setup([textRound('## Primary Request and Intent\n- Old objective\n## Next Step\n- Continue.')])
    const agent = compactingAgent(false).with({
      compaction: {
        auto: false, maxInputTokens: 100, retainTokens: 100,
        compactionRetries: 0, maxOverflowRetries: 1,
        maxSummaryTokens: 512, maxToolResultChars: 200,
      },
    })
    const session = agent.createSession({ registry: state.registry, history })

    await session.compact()

    expect(history.entries().some(entry => entry.event.kind === 'compaction-prune')).toBe(true)
    const projectedToolText = history.messages().flatMap(message => message.content)
      .flatMap(block => block.type === 'tool-result' ? block.content : [])
      .find(block => block.type === 'text')
    expect(projectedToolText?.type === 'text' ? projectedToolText.text : '').toContain('tool result pruned')
    expect(history.entries().some(entry => entry.event.kind === 'tool-result'
      && !entry.event.result.isError && entry.event.result.value === huge)).toBe(true)
    expect(history.generation()).toBe(2)
  })

  it('does not commit a checkpoint when abort arrives before the summary commit', async () => {
    const controller = new AbortController()
    const adapter = new AbortAfterTextAdapter(controller)
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(1_000)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'text', text: `Progress ${'B'.repeat(1_000)}` }],
      }),
    })
    const compactor = new ContextCompactor({
      registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: false, maxInputTokens: 100, retainTokens: 10, maxSummaryTokens: 512,
      }),
    })

    await expect(compactor.compactNow(controller.signal)).rejects.toThrow('stress abort during compaction')

    expect(adapter.requests).toHaveLength(1)
    expect(history.generation()).toBe(0)
    expect(history.entries().some(entry => entry.event.kind === 'compaction-summary')).toBe(false)
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'failed', error: 'stress abort during compaction',
    })
  })

  it('does not retry overflow when pruning was the only replacement before summary failure', async () => {
    const callId = ToolCallId('prune-before-failed-overflow')
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(800)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
      }),
    })
    const huge = 'X'.repeat(5_000)
    history.append({
      kind: 'tool-result', callId,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: huge }], isError: false }),
      result: { isError: false, value: huge, content: [{ type: 'text', text: huge }] },
    })
    history.append({ kind: 'user', message: createTextMessage('Continue after the read.') })
    const state = setup([overflowRound()])
    const compactor = new ContextCompactor({
      registry: state.registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: true, maxInputTokens: 100, retainTokens: 10,
        maxToolResultChars: 100, maxSummaryTokens: 512, maxOverflowRetries: 1,
      }),
    })
    const controller = new AbortController()

    const recovery = await compactor.onRequestError({
      turn: 1, step: 1,
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'request overflowed' },
      snapshot: history.snapshot(), signal: controller.signal, emit: async () => undefined,
    })

    expect(recovery).toBeUndefined()
    expect(history.generation()).toBe(1)
    expect(history.entries().some(entry => entry.event.kind === 'compaction-prune')).toBe(true)
    expect(history.entries().some(entry => entry.event.kind === 'compaction-summary')).toBe(false)
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'failed',
    })
  })

  it('makes concurrent manual compaction single-flight before model resolution', async () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(1_000)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'text', text: `Progress ${'B'.repeat(1_000)}` }],
      }),
    })
    const state = setup([
      textRound('## Primary Request and Intent\n- Objective\n## Next Step\n- Continue.'),
    ])
    const compactor = new ContextCompactor({
      registry: state.registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: false, maxInputTokens: 100, retainTokens: 10, maxSummaryTokens: 512,
      }),
    })

    const results = await Promise.all([compactor.compactNow(), compactor.compactNow()])

    expect(results.filter(result => result !== null)).toHaveLength(1)
    expect(state.adapter.requests).toHaveLength(1)
    expect(history.generation()).toBe(1)
    const checkpoints = history.surface().filter(node => node.message.content.some(block =>
      block.type === 'text' && block.text.includes('<compacted-summary>')))
    expect(checkpoints).toHaveLength(1)
  })

  it('recomputes ratio-based retention after pruning without model context metadata', async () => {
    const history = new History()
    const assistant = (text: string) => createMessage({
      role: 'assistant' as const,
      source: { kind: 'model' as const, provider: 'test', model: 'scripted' },
      content: [{ type: 'text' as const, text }],
    })
    for (let index = 0; index < 8; index++) {
      history.append(index % 2 === 0
        ? { kind: 'user', message: createTextMessage(`Message ${index} ${'A'.repeat(1_200)}`) }
        : { kind: 'assistant', message: assistant(`Message ${index} ${'B'.repeat(1_200)}`) })
    }
    const callId = ToolCallId('ratio-after-prune')
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'scripted' },
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
      }),
    })
    const huge = 'X'.repeat(100_000)
    history.append({
      kind: 'tool-result', callId,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: huge }], isError: false }),
      result: { isError: false, value: huge, content: [{ type: 'text', text: huge }] },
    })
    history.append({ kind: 'user', message: createTextMessage(`Recent ${'R'.repeat(1_200)}`) })
    const adapter = new NoContextScriptedAdapter([
      textRound('## Primary Request and Intent\n- Objective\n## Next Step\n- Continue.'),
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const compactor = new ContextCompactor({
      registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: false, maxInputTokens: 1_000, retainRatio: 0.2,
        maxToolResultChars: 100, maxSummaryTokens: 512,
      }),
    })

    const result = await compactor.compactNow()

    expect(result).not.toBeNull()
    expect(result?.shadowedSeqs.length).toBeGreaterThan(1)
    expect(result?.estimatedTokensAfter).toBeLessThan(1_000)
    expect(history.entries().some(entry => entry.event.kind === 'compaction-prune')).toBe(true)
  })

  it('caps cumulative replay characters sent to the compaction model', async () => {
    const history = new History()
    for (let index = 0; index < 6; index++) {
      history.append({ kind: 'user', message: createTextMessage(`${index}:${'x'.repeat(500)}`) })
    }
    const adapter = new ScriptedAdapter([
      textRound('## Primary Request and Intent\n- Keep working.\n## Next Step\n- Continue.'),
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const compactor = new ContextCompactor({
      registry,
      config: { provider: 'test', model: 'scripted' },
      history: () => history,
      system: () => '',
      tools: () => [],
      policy: resolveCompactionConfig({
        auto: false, maxInputTokens: 100, retainTokens: 1,
        maxSummaryInputChars: 80, maxSummaryRequestChars: 120,
      }),
    })
    await compactor.compactNow()
    const replay = adapter.requests[0]?.messages.slice(0, -1) ?? []
    const payloadChars = replay.reduce((total, message) => total + message.content.reduce(
      (subtotal, block) => subtotal + (block.type === 'text' || block.type === 'reasoning' ? block.text.length : 0),
      0,
    ), 0)
    expect(payloadChars).toBeLessThanOrEqual(120)
  })

  it('bounds an uncooperative compaction model and records the failed lifecycle', async () => {
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(1_000)}`) })
    history.append({
      kind: 'assistant',
      message: createMessage({
        role: 'assistant', source: { kind: 'model', provider: 'test', model: 'm' },
        content: [{ type: 'text', text: `Progress ${'B'.repeat(1_000)}` }],
      }),
    })
    const registry = {
      resolveModelInfo: () => Promise.resolve({ context: { contextWindow: 2_000 } }),
      prepareCall: (config: { provider: string; model: string; maxTokens?: number }) => Promise.resolve({
        config,
        stream: () => ({
          async * [Symbol.asyncIterator]() { await new Promise<void>(() => {}) },
        }),
      }),
    } as unknown as ModelRegistry
    const compactor = new ContextCompactor({
      registry, config: { provider: 'test', model: 'm' }, history: () => history,
      system: () => '', tools: () => [],
      policy: resolveCompactionConfig({
        auto: false, maxInputTokens: 100, retainTokens: 1,
        summaryTimeoutMs: 10, teardownTimeoutMs: 10,
      }),
    })
    const started = Date.now()
    await expect(compactor.compactNow()).rejects.toMatchObject({ code: 'MODEL_TEARDOWN_TIMEOUT' })
    expect(Date.now() - started).toBeLessThan(250)
    expect(history.entries().at(-1)?.event).toMatchObject({
      kind: 'compaction-end', status: 'failed', error: expect.stringContaining('ignored cancellation'),
    })
  })
})
