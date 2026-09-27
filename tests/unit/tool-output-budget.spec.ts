import { describe, expect, it } from 'vitest'
import { History } from '@alvin0/ai-agent-sdk-core/agent'
import { runTurn, runAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { createMemorySpillStore, defineTool, readSpillTool, ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentEvent, SpillStore, ToolExecutionResult } from '@alvin0/ai-agent-sdk-core/agent'
import { resolveBounds } from '../../packages/core/src/agent/loop/turn/config.ts'
import { resolveRuntimeLimits } from '../../packages/core/src/agent/define/session/config.ts'
import { ModelAdapter, ModelRegistry, ToolCallId, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { evaluationCases } from '../../test-human/evaluation/cases.ts'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
}

function toolRound(calls: readonly { id: string; name: string; arguments?: string }[]): StreamChunk[] {
  return [
    ...calls.map((call, index): StreamChunk => ({
      type: 'block-end', index,
      block: {
        type: 'tool-call', id: ToolCallId(call.id), name: call.name,
        arguments: call.arguments ?? '{}',
      },
    })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textRound(text: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 40,000 characters ≈ 10,000 estimated tokens. */
const BIG = 'x'.repeat(40_000)

function setup(rounds: readonly (readonly StreamChunk[])[], output = BIG) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('go') })
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: 'dump', description: 'Return a lot of text.', parameters: { type: 'object' },
    execute: () => output,
  }))
  return { adapter, registry, history, tools }
}

function resultOf(history: History): ToolExecutionResult | undefined {
  const entry = history.entries().find(item => item.event.kind === 'tool-result')
  return entry?.event.kind === 'tool-result' ? entry.event.result : undefined
}

function textOf(result: ToolExecutionResult | undefined): string {
  return (result?.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('tool output budget', () => {
  it('OUT-01: retrieving an evicted mutation output does not replay the body or lose its receipt', async () => {
    const backing = createMemorySpillStore({ maxEntries: 1 })
    const store: SpillStore = { ...backing, async save(text, context) {
      const record = await backing.save(text, context)
      await backing.save('unrelated output', { toolName: 'other', callId: 'other' })
      return record
    } }
    const state = setup([toolRound([{ id: 'create', name: 'create_record' }]),
      toolRound([{ id: 'read', name: 'read_tool_output', arguments: '{"locator":"spill:create_record:1"}' }]), textRound('done')])
    let effects = 0
    state.tools.register(defineTool({ name: 'create_record', description: 'Create a record once.', parameters: { type: 'object' },
      execute: () => { effects++; return { status: 'completed', receipt: 'receipt-1', detail: BIG } } }))
    state.tools.register(readSpillTool(store))
    for await (const _ of runTurn({ registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, spillStore: store, bounds: { maxToolResultTokens: 100 } })) { /* drain */ }
    const results = state.history.entries().flatMap(e => e.event.kind === 'tool-result' ? [e.event.result] : [])
    expect(effects).toBe(1)
    expect(results[0]?.isError).toBe(false)
    const completed = results[0]
    if (completed?.isError === false) expect(completed.value).toMatchObject({ status: 'completed', receipt: 'receipt-1' })
    expect(textOf(results[1])).toContain('host confirms it is safe')
    expect(textOf(results[1])).not.toContain('Re-run the original call')
  })

  it('OUT-03: failed save preserves completed result and provides safe recovery guidance', async () => {
    const backing = createMemorySpillStore()
    const store: SpillStore = { ...backing, save() { throw new Error('fixture unavailable') } }
    const state = setup([toolRound([{ id: 'dump', name: 'dump' }]), textRound('done')])
    for await (const _ of runTurn({ registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, spillStore: store, bounds: { maxToolResultTokens: 100 } })) { /* drain */ }
    expect(resultOf(state.history)?.isError).toBe(false)
    const completed = resultOf(state.history)
    if (completed?.isError === false) expect(completed.value).toBe(BIG)
    expect(textOf(resultOf(state.history))).toContain('host confirms it is safe')
  })

  it('OUT-05: spill receives only post-policy output and cannot recover redacted raw value', async () => {
    const store = createMemorySpillStore()
    const state = setup([toolRound([{ id: 'dump', name: 'dump' }]), textRound('done')], 'PRIVATE/SENTINEL' + BIG)
    const events: AgentEvent[] = []
    for await (const event of runTurn({ registry: state.registry, config: { provider: 'test', model: 'm' },
      history: state.history, tools: state.tools, spillStore: store, bounds: { maxToolResultTokens: 100 },
      interceptors: [{ name: 'redact', async after() { return { kind: 'replace', content: [{ type: 'text', text: BIG }] } } }] })) events.push(event)
    const result = resultOf(state.history)
    expect(result?.isError).toBe(false)
    if (result?.isError === false) expect(result.value).toBeUndefined()
    const locator = (result?.meta as { outputSpilled: { locator: string } }).outputSpilled.locator
    expect(await store.read(locator, { offset: 0, limit: 100_000 })).toMatchObject({ text: BIG })
    expect(JSON.stringify(events)).not.toContain('PRIVATE/SENTINEL')
  })

  it('diagnoses DATA-04: text spill does not bypass the raw-result retention byte cap', async () => {
    const fixture = evaluationCases().find(c => c.id === 'DATA-04')!
    const page = { records: fixture.collections.items!.slice(0, 40), nextOffset: 40, total: 180 }
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeGreaterThan(8192)
    for (const cap of [8192, 65536]) {
      const state = setup([toolRound([{ id: 'items', name: 'items' }]), textRound('done')])
      state.tools.register(defineTool({ name: 'items', description: 'Read a fixture page.', parameters: { type: 'object' }, execute: () => page }))
      for await (const _ of runTurn({ registry: state.registry, config: { provider: 'test', model: 'm' },
        history: state.history, tools: state.tools, spillStore: createMemorySpillStore(),
        bounds: { maxToolResultTokens: 2048, maxToolResultBytes: cap } })) { /* drain */ }
      expect(resultOf(state.history)?.isError).toBe(cap === 8192)
      if (cap === 8192) expect(textOf(resultOf(state.history))).toContain('retention limit')
      else expect(resultOf(state.history)?.meta).toHaveProperty('outputSpilled')
    }
  })

  it('truncates the middle when nothing is mounted to spill into', async () => {
    const state = setup([
      toolRound([{ id: 'd1', name: 'dump' }]),
      textRound('done'),
    ])
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolResultTokens: 100 },
    })) { /* drain */ }

    const result = resultOf(state.history)
    const text = textOf(result)
    // Two ends kept, middle gone, and the model is told what it is looking at.
    expect(text.length).toBeLessThan(1_000)
    expect(text).toContain('estimated tokens omitted from the middle')
    expect(text).not.toMatch(/Re-run more narrowly/i)
    expect(text).toContain('host confirms it is safe')
    expect(result?.meta).toMatchObject({ outputTruncated: { estimatedTokens: 10_000, budget: 100 } })
  })

  it('leaves a result inside its budget exactly as the tool returned it', async () => {
    const state = setup([toolRound([{ id: 'd1', name: 'dump' }]), textRound('done')], 'short output')
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolResultTokens: 100 },
    })) { /* drain */ }

    expect(textOf(resultOf(state.history))).toBe('short output')
    expect(resultOf(state.history)?.meta).toBeUndefined()
  })

  it('takes the stricter of the turn budget and the declaration on the tool', async () => {
    const state = setup([toolRound([{ id: 'q1', name: 'quiet' }]), textRound('done')])
    state.tools.register(defineTool({
      name: 'quiet', description: 'A tool that knows it should stay small.',
      parameters: { type: 'object' }, maxOutputTokens: 10,
      execute: () => BIG,
    }))
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolResultTokens: 1_000 },
    })) { /* drain */ }

    // The tool's own 10 wins over the turn's 1,000.
    expect(resultOf(state.history)?.meta).toMatchObject({ outputTruncated: { budget: 10 } })
  })

  it('never lets a tool raise its share above the turn budget', async () => {
    const state = setup([toolRound([{ id: 'g1', name: 'greedy' }]), textRound('done')])
    state.tools.register(defineTool({
      name: 'greedy', description: 'A tool asking for more than the host allows.',
      parameters: { type: 'object' }, maxOutputTokens: 1_000_000,
      execute: () => BIG,
    }))
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolResultTokens: 50 },
    })) { /* drain */ }

    expect(resultOf(state.history)?.meta).toMatchObject({ outputTruncated: { budget: 50 } })
  })

  it('spills instead of cutting once a store is mounted', async () => {
    const store = createMemorySpillStore()
    const state = setup([toolRound([{ id: 'd1', name: 'dump' }]), textRound('done')])
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, spillStore: store, bounds: { maxToolResultTokens: 100 },
    })) { /* drain */ }

    const result = resultOf(state.history)
    const spill = (result?.meta as { outputSpilled?: { locator: string; bytes: number } } | undefined)
      ?.outputSpilled
    expect(spill?.bytes).toBe(40_000)
    expect(textOf(result)).toContain(spill?.locator ?? 'missing')
    expect(textOf(result)).toContain('read_tool_output')
    // Nothing was lost: the whole output is still readable.
    const slice = await store.read(spill?.locator ?? '', { offset: 0, limit: 40_000 })
    expect(slice?.text).toBe(BIG)
  })

  it('honours an explicit truncate policy even with a store mounted', async () => {
    const state = setup([toolRound([{ id: 'd1', name: 'dump' }]), textRound('done')])
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, spillStore: createMemorySpillStore(),
      bounds: { maxToolResultTokens: 100, toolResultOverflow: 'truncate' },
    })) { /* drain */ }

    expect(resultOf(state.history)?.meta).toHaveProperty('outputTruncated')
  })

  it('falls back to truncating when spill is asked for and no store is mounted', async () => {
    const state = setup([toolRound([{ id: 'd1', name: 'dump' }]), textRound('done')])
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolResultTokens: 100, toolResultOverflow: 'spill' },
    })) { /* drain */ }

    expect(resultOf(state.history)?.meta).toHaveProperty('outputTruncated')
  })

  it('falls back to truncating when the store itself fails', async () => {
    // Losing the result entirely would be a worse answer to a full disk than
    // showing the model most of it.
    const broken: SpillStore = {
      save: () => { throw new Error('disk full') },
      read: () => undefined,
      search: () => undefined,
    }
    const state = setup([toolRound([{ id: 'd1', name: 'dump' }]), textRound('done')])
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, spillStore: broken, bounds: { maxToolResultTokens: 100 },
    })) { /* drain */ }

    expect(resultOf(state.history)?.meta).toHaveProperty('outputTruncated')
    expect(textOf(resultOf(state.history))).toContain('omitted from the middle')
  })

  it('gives the model a way to read back what was spilled', async () => {
    const store = createMemorySpillStore()
    const state = setup([
      toolRound([{ id: 'd1', name: 'dump' }]),
      textRound('done'),
    ])
    let terminal: Extract<AgentEvent, { type: 'turn-end' }> | undefined
    for await (const event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, spillStore: store, bounds: { maxToolResultTokens: 100 },
    })) if (event.type === 'turn-end') terminal = event
    expect(terminal).toBeDefined()

    const spilled = (resultOf(state.history)?.meta as { outputSpilled?: { locator: string } })
      .outputSpilled?.locator ?? ''
    const tool = readSpillTool(store)
    const page = await tool.execute(tool.parse?.({ locator: spilled, limit: 10 }) as never, {} as never)
    expect(page).toMatchObject({ text: 'xxxxxxxxxx', offset: 0, nextOffset: 10, totalChars: 40_000 })
  })

  it('searches a spilled result and reports an unknown locator without throwing', async () => {
    const store = createMemorySpillStore()
    const record = await store.save('alpha\nbeta\ngamma', { toolName: 'dump', callId: 'c1' })
    const tool = readSpillTool(store)
    const found = await tool.execute(
      tool.parse?.({ locator: record.locator, pattern: '^b' }) as never, {} as never,
    )
    expect(found).toMatchObject({ matches: ['2: beta'] })

    const missing = await tool.execute(tool.parse?.({ locator: 'spill:nope:1' }) as never, {} as never)
    expect(JSON.stringify(missing)).not.toContain('Re-run the original call')
    expect(JSON.stringify(missing)).toContain('does not mean the original operation failed')
    expect(JSON.stringify(missing)).toContain('host confirms it is safe')
  })

  it('keeps the retrieval tool outside the tool-call budget', () => {
    // A model that cannot reach its own spilled output is worse off than one
    // whose output was simply cut.
    expect(readSpillTool(createMemorySpillStore()).budgetExempt).toBe(true)
  })

  it('registers the retrieval tool only when a store is mounted', async () => {
    const withStore = setup([textRound('done')])
    for await (const _event of runAgent({
      mode: 'basic', registry: withStore.registry, history: withStore.history,
      tools: withStore.tools, config: { provider: 'test', model: 'm' }, maxTurns: 1,
      spillStore: createMemorySpillStore(),
    })) { /* drain */ }
    expect(withStore.adapter.requests[0]?.tools?.map(tool => tool.name))
      .toContain('read_tool_output')

    const without = setup([textRound('done')])
    for await (const _event of runAgent({
      mode: 'basic', registry: without.registry, history: without.history,
      tools: without.tools, config: { provider: 'test', model: 'm' }, maxTurns: 1,
    })) { /* drain */ }
    expect(without.adapter.requests[0]?.tools?.map(tool => tool.name))
      .not.toContain('read_tool_output')
  })

  it('bounds what the in-process store retains', async () => {
    const store = createMemorySpillStore({ maxEntries: 2 })
    const first = await store.save('one', { toolName: 'dump', callId: 'a' })
    await store.save('two', { toolName: 'dump', callId: 'b' })
    await store.save('three', { toolName: 'dump', callId: 'c' })
    // Oldest evicted rather than growing without bound.
    expect(await store.read(first.locator, { offset: 0, limit: 10 })).toBeUndefined()
  })

  it('shortens the text in place and leaves an image block alone', async () => {
    const state = setup([toolRound([{ id: 'i1', name: 'shot' }]), textRound('done')])
    state.tools.register(defineTool({
      name: 'shot', description: 'Return a caption, a screenshot, and a log.',
      parameters: { type: 'object' },
      execute: () => null,
      render: () => [
        { type: 'text', text: BIG },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } },
      ],
    }))
    for await (const _event of runTurn({
      registry: state.registry, config: { provider: 'test', model: 'm' }, history: state.history,
      tools: state.tools, bounds: { maxToolResultTokens: 100 },
    })) { /* drain */ }

    const content = resultOf(state.history)?.content ?? []
    // Cutting an image produces a corrupt image rather than a smaller one, and
    // the text keeps its position ahead of it.
    expect(content.map(block => block.type)).toEqual(['text', 'image'])
    expect(content[1]).toMatchObject({ source: { data: 'AAAA' } })
  })

  it('accepts the three overflow policies and rejects anything else', () => {
    for (const toolResultOverflow of ['auto', 'truncate', 'spill'] as const) {
      expect(resolveBounds({ toolResultOverflow }).toolResultOverflow).toBe(toolResultOverflow)
      expect(resolveRuntimeLimits({ toolResultOverflow }).toolResultOverflow).toBe(toolResultOverflow)
    }
    expect(() => resolveBounds({ toolResultOverflow: 'drop' as never })).toThrow(RangeError)
    expect(() => resolveRuntimeLimits({ toolResultOverflow: 'drop' as never })).toThrow(RangeError)
  })
})
