import { describe, it, expect, vi } from 'vitest'
import { createMessage, createTextMessage, ModelAdapter, ModelRegistry, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, Message, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { History, runTurn, ToolRegistry, defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { BeforeStepContext, TurnHooks } from '@alvin0/ai-agent-sdk-core/agent'
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'
import { createMemorySpillStore, createModelEvidenceReducer, diagnosticLineNumbers, reduceEvidence } from '@alvin0/ai-agent-sdk-core/tools'
import type { EvidenceReducer, SpillStore } from '@alvin0/ai-agent-sdk-core/tools'

const BIG = 'entry payload dữ liệu 🚀\n'.repeat(850)
const signal = new AbortController().signal
function addResult(history: History, text = BIG, id = 'dump', name = 'dump') {
  const callId = ToolCallId(id)
  history.append({ kind: 'assistant', message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'test', model: 'm' },
    content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }] }) })
  history.append({ kind: 'tool-call', callId, name, rawArguments: '{}' })
  const content = [{ type: 'text' as const, text }]
  history.append({ kind: 'tool-result', callId, result: { isError: false, value: text, content },
    message: createMessage({ role: 'user', source: { kind: 'tool', name, callId },
      content: [{ type: 'tool-result', toolCallId: callId, content }] }) })
}
function context(history: History): BeforeStepContext {
  return { turn: 0, step: 0, snapshot: history.snapshot(), messages: history.messages(), signal, emit: async () => {} }
}
async function project(optimizer: ReturnType<typeof createContextOptimizer>, history: History) {
  const decision = await optimizer.hooks.beforeStep!(context(history))
  if (decision.kind !== 'proceed') throw new Error('unexpected reject')
  return decision.messages ?? history.messages()
}
async function expose(optimizer: ReturnType<typeof createContextOptimizer>, history: History) {
  const messages = await project(optimizer, history)
  await optimizer.hooks.checkpoint!({ kind: 'before-model-request', request: { provider: 'test', model: 'm', messages }, snapshot: history.snapshot() })
  return messages
}
function toolText(messages: readonly Message[]) {
  return messages.flatMap(message => message.content.flatMap(block => block.type === 'tool-result'
    ? block.content.flatMap(child => child.type === 'text' ? child.text : []) : [])).join('\n')
}
function setup() {
  const history = new History()
  history.append({ kind: 'user', message: createTextMessage('Keep the user constraints verbatim.') })
  addResult(history)
  return history
}

describe('online context optimization', () => {
  it('sends full output twice, packs on third request, and retrieves exact Unicode slices', async () => {
    const history = setup(), original = history.snapshot()
    const store = createMemorySpillStore()
    const save = vi.spyOn(store, 'save')
    const optimizer = createContextOptimizer({ store })
    expect(toolText(await expose(optimizer, history))).toBe(BIG)
    expect(toolText(await expose(optimizer, history))).toBe(BIG)
    const packed = toolText(await expose(optimizer, history))
    expect(packed).toContain('Observation stored. ID: spill:dump:1')
    expect(new TextEncoder().encode(packed).length).toBeLessThanOrEqual(1024)
    expect(save).toHaveBeenCalledTimes(1)
    const slice = await store.read('spill:dump:1', { offset: 100, limit: 200 })
    expect(slice?.text).toBe([...BIG].slice(100, 300).join(''))
    expect(history.snapshot()).toEqual(original)
    expect(optimizer.metrics().estimatedTokensSaved).toBeGreaterThan(4000)
  })
  it('keeps spill paging exact for astral characters and lone surrogates', async () => {
    const store = createMemorySpillStore(), text = 'A🚀B\uD800C\uDC00Z'.repeat(100)
    const record = await store.save(text, { toolName: 'unicode', callId: 'unicode' })
    for (const offset of [0, 1, 2, 6, 77, 690, 99999]) {
      const slice = await store.read(record.locator, { offset, limit: 13 })
      expect(slice?.text).toBe([...text].slice(offset, offset + 13).join(''))
      expect(slice?.totalChars).toBe([...text].length)
    }
  })
  it('preserves application context and uses packed context for milestone ROI', async () => {
    const history = setup()
    const app = createMessage({ role: 'user', source: { kind: 'app', producer: 'context-section:acl' }, content: [{ type: 'text', text: 'ACL: only public records' }] })
    history.append({ kind: 'user', message: app })
    const archive = vi.fn(async () => {})
    const optimizer = createContextOptimizer({ store: createMemorySpillStore(), archive, fullRequests: 1 })
    await expose(optimizer, history)
    optimizer.completeMilestone({ id: 'too-expensive-after-pack', throughSeq: 5, summary: 'read inventory', remainingTurns: 1, compactionCost: 1000 })
    const packed = await expose(optimizer, history)
    expect(archive).not.toHaveBeenCalled()
    expect(optimizer.metrics().skippedMilestones).toBe(1)
    optimizer.completeMilestone({ id: 'free-state', throughSeq: 5, summary: 'read inventory', remainingTurns: 1, compactionCost: 0 })
    const messages = await expose(optimizer, history)
    expect(messages.find(message => message.id === app.id)).toEqual(app)
    expect(optimizer.metrics().compactedMilestones).toBe(1)
    expect(JSON.stringify(packed)).toContain('Observation stored')
  })

  it('does not count maintenance calls or failed host checkpoints as exposures', async () => {
    const history = setup(), optimizer = createContextOptimizer({ store: createMemorySpillStore() })
    for (let i = 0; i < 4; i++) expect(toolText(await project(optimizer, history))).toBe(BIG)
    const hooks = optimizer.wrapHooks({ checkpoint: () => { throw new Error('disk full') } })
    await expect(hooks.checkpoint!({ kind: 'before-model-request', request: { provider: 'test', model: 'm', messages: history.messages() }, snapshot: history.snapshot() })).rejects.toThrow('disk full')
    expect(toolText(await project(optimizer, history))).toBe(BIG)
  })

  it('fails open to raw output on failed storage, bounded capacity, and disposal', async () => {
    const history = setup(), backing = createMemorySpillStore()
    const store: SpillStore = { ...backing, save: () => { throw new Error('unavailable') } }
    const optimizer = createContextOptimizer({ store })
    for (let i = 0; i < 3; i++) expect(toolText(await expose(optimizer, history))).toBe(BIG)
    const bounded = createContextOptimizer({ store: backing, maxObservations: 1, fullRequests: 1 })
    addResult(history, BIG + 'second', 'second')
    await expose(bounded, history)
    const text = toolText(await expose(bounded, history))
    expect(text).toContain(BIG + 'second')
    bounded.dispose()
    expect(toolText(await project(bounded, history))).toBe(BIG + '\n' + BIG + 'second')
  })

  it('preserves diagnostics beyond the preview and leaves oversized evidence intact', async () => {
    const history = setup()
    addResult(history, BIG + '\nFAIL late.spec.ts:91\nExpected 1 received 2\nProcess exit 1', 'failure')
    const optimizer = createContextOptimizer({ store: createMemorySpillStore(), fullRequests: 1 })
    await expose(optimizer, history)
    const text = toolText(await expose(optimizer, history))
    expect(text).toContain('FAIL late.spec.ts:91')
    expect(text).toContain('Process exit 1')
    const noisy = setup()
    addResult(noisy, ('FAIL assertion\n').repeat(1000), 'noisy')
    const second = createContextOptimizer({ store: createMemorySpillStore(), fullRequests: 1 })
    await expose(second, noisy)
    expect(toolText(await expose(second, noisy))).toContain(('FAIL assertion\n').repeat(1000))
  })

  it('archives before milestone projection and keeps the original request and raw history', async () => {
    const history = setup(), original = history.snapshot(), archive = vi.fn(async () => {})
    const optimizer = createContextOptimizer({ store: createMemorySpillStore(), archive })
    optimizer.completeMilestone({ id: 'step-1', summary: 'Read the inventory; no files changed.', throughSeq: 4, remainingTurns: 3, compactionCost: 10 })
    const messages = await project(optimizer, history)
    expect(archive).toHaveBeenCalledWith(original, expect.objectContaining({ id: 'step-1' }), expect.any(AbortSignal))
    expect(messages[0]).toEqual(history.messages()[0])
    expect(JSON.stringify(messages)).toContain('[Completed step-1:')
    expect(toolText(messages)).toBe('')
    expect(history.snapshot()).toEqual(original)
    expect(optimizer.metrics().compactedMilestones).toBe(1)
    addResult(history, BIG, 'next')
    optimizer.completeMilestone({ id: 'step-2', summary: 'Read the next inventory.', throughSeq: 7, remainingTurns: 2, compactionCost: 10 })
    expect(JSON.stringify(await project(optimizer, history))).toContain('[Completed step-2:')
    expect(optimizer.metrics().compactedMilestones).toBe(2)
  })

  it.each(['expensive', 'archive-failure', 'no-archive', 'split-pair'] as const)('skips milestone safely: %s', async failure => {
    const history = setup()
    const optimizer = createContextOptimizer({ store: createMemorySpillStore(),
      ...failure === 'no-archive' ? {} : { archive: async () => { if (failure === 'archive-failure') throw new Error('disk full') } } })
    optimizer.completeMilestone({ id: 'step', summary: 'Completed', throughSeq: failure === 'split-pair' ? 2 : 4,
      remainingTurns: 1, compactionCost: failure === 'expensive' ? 1e9 : 0 })
    expect(toolText(await project(optimizer, history))).toBe(BIG)
    expect(optimizer.metrics().compactedMilestones).toBe(0)
  })

  it('rejects invalid configuration and duplicate milestones', () => {
    expect(() => createContextOptimizer({ store: createMemorySpillStore(), fullRequests: 0 })).toThrow()
    const optimizer = createContextOptimizer({ store: createMemorySpillStore() })
    const milestone = { id: 'step', summary: 'done', throughSeq: 1, remainingTurns: 1, compactionCost: 0 }
    optimizer.completeMilestone(milestone)
    expect(() => optimizer.completeMilestone(milestone)).toThrow()
    expect(() => optimizer.completeMilestone({ ...milestone, id: 'bad', remainingTurns: NaN })).toThrow()
  })
})

const LOG = 'normal progress\n'.repeat(600) + 'FAIL auth.spec.ts:37\nExpected true\nReceived false\n  at auth.ts:19:2\nTests 1 failed, 3 passed\nexit code 1\n'
const validReducer: EvidenceReducer = { async reduce(input) {
  const lines = input.text.split('\n')
  return { status: input.status, lines: diagnosticLineNumbers(input.text).map(line => ({ line, text: lines[line - 1]! })) }
} }
describe('evidence-preserving reducer', () => {
  it('bridges a host model callback with required source lines and rejects invalid JSON and byte overflow', async () => {
    const generate = vi.fn(async (request: { prompt: string }) => {
      const required = request.prompt.split('\n')[1]!.replace('Required line numbers: ', '').split(',').map(Number)
      const lines = LOG.split('\n')
      return JSON.stringify({ status: 'fail', lines: required.map(line => ({ line, text: lines[line - 1] })) })
    })
    const reducer = createModelEvidenceReducer({ generate })
    expect((await reduceEvidence({ text: LOG, status: 'fail', signal }, reducer)).accepted).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
    for (const bad of [createModelEvidenceReducer({ generate: async () => 'not JSON' }),
      createModelEvidenceReducer({ generate, maxInputBytes: 1 }),
      createModelEvidenceReducer({ generate, maxOutputBytes: 1 })]) {
      expect((await reduceEvidence({ text: LOG, status: 'fail', signal }, bad)).text).toBe(LOG)
    }
  })
  it('returns raw output when storage expires before packing', async () => {
    const history = setup(), store = createMemorySpillStore({ maxEntries: 1 })
    const optimizer = createContextOptimizer({ store, fullRequests: 1 })
    await expose(optimizer, history)
    await store.save('new output', { toolName: 'other', callId: 'other' })
    expect(toolText(await expose(optimizer, history))).toBe(BIG)
  })
  it('reconstructs verified source lines and preserves failures and pass counts', async () => {
    const result = await reduceEvidence({ text: LOG, status: 'fail', signal }, validReducer)
    expect(result.accepted).toBe(true)
    expect(result.text).toContain('FAIL auth.spec.ts:37')
    expect(result.text).toContain('Tests 1 failed, 3 passed')
    expect(result.text.length).toBeLessThan(LOG.length / 10)
  })
  it('reconstructs from original lines even when a reducer object changes after verification', async () => {
    const lines = LOG.split('\n')
    const result = await reduceEvidence({ text: LOG, status: 'fail', signal }, { async reduce(input) {
      return { status: input.status, lines: diagnosticLineNumbers(LOG).map(line => {
        let reads = 0
        return { line, get text() { return reads++ === 0 ? lines[line - 1]! : 'fabricated PASS' } }
      }) }
    } })
    expect(result.accepted).toBe(true)
    expect(result.text).not.toContain('fabricated')
    expect(result.text).toContain('FAIL auth.spec.ts:37')
  })
  it.each(['status', 'text', 'missing', 'line', 'duplicate', 'throw'] as const)('returns raw log when proposal has %s corruption', async corruption => {
    const reducer: EvidenceReducer = { async reduce(input) {
      if (corruption === 'throw') throw new Error('model unavailable')
      const candidate = await validReducer.reduce(input)
      return { status: corruption === 'status' ? 'pass' : candidate.status,
        lines: corruption === 'missing' ? [] : corruption === 'duplicate' ? [candidate.lines[0]!, candidate.lines[0]!] : candidate.lines.map((line, index) => index === 0
          ? { line: corruption === 'line' ? 99999 : line.line, text: corruption === 'text' ? 'invented.ts:1 PASS' : line.text } : line) }
    } }
    const result = await reduceEvidence({ text: LOG, status: 'fail', signal }, reducer)
    expect(result.accepted).toBe(false)
    expect(result.text).toBe(LOG)
  })
  it('requires host-declared multiline evidence and refuses unrecognized log formats', async () => {
    expect((await reduceEvidence({ text: LOG, status: 'fail', signal }, validReducer, [1])).accepted).toBe(false)
    expect((await reduceEvidence({ text: BIG, status: 'unknown', signal }, validReducer)).accepted).toBe(false)
  })
  it('integrates reducer once, retains exact log for retrieval, and keeps rejected output raw', async () => {
    for (const valid of [true, false]) {
      const history = setup(); addResult(history, LOG, 'log', 'test')
      const store = createMemorySpillStore(), reduce = vi.fn(validReducer.reduce)
      const optimizer = createContextOptimizer({ store, log: name => name === 'test' ? { status: 'fail' } : undefined,
        reducer: valid ? { reduce } : { reduce: async () => ({ status: 'pass', lines: [] }) } })
      const text = toolText(await expose(optimizer, history))
      if (valid) {
        expect(text).toContain('Extractive log; status: fail')
        await expose(optimizer, history)
        expect(reduce).toHaveBeenCalledTimes(1)
      } else {
        expect(text).toContain(LOG)
        expect(toolText(await expose(optimizer, history))).toContain(LOG)
      }
      expect((await store.read('spill:test:2', { offset: 0, limit: 100000 }))?.text).toBe(LOG)
    }
  })
})

class Rounds extends ModelAdapter {
  requests: GenerateOptions[] = []
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const step = this.requests.length
    if (step <= 3) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`call-${step}`), name: step === 1 ? 'dump' : 'noop', arguments: '{}' } }
    else yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: step <= 3 ? 'tool-calls' : 'stop' } }
  }
}
it('uses projections in actual runTurn requests and checkpoints while snapshots stay raw', async () => {
  const model = new Rounds(), registry = new ModelRegistry(), history = new History(), tools = new ToolRegistry()
  registry.registerAdapter(['test'], model)
  history.append({ kind: 'user', message: createTextMessage('Run tools.') })
  tools.register(defineTool({ name: 'dump', description: 'Dump', parameters: { type: 'object' }, execute: () => BIG }))
  tools.register(defineTool({ name: 'noop', description: 'Continue', parameters: { type: 'object' }, execute: () => 'ok' }))
  const optimizer = createContextOptimizer({ store: createMemorySpillStore() })
  tools.register(optimizer.retrievalTool)
  const requests: unknown[] = []
  const hooks: TurnHooks = optimizer.wrapHooks({ checkpoint: ctx => { if (ctx.kind === 'before-model-request') requests.push(ctx) } })
  for await (const _ of runTurn({ registry, config: { provider: 'test', model: 'm' }, history, tools, hooks })) { /* consume */ }
  expect(toolText(model.requests[1]!.messages!)).toContain(BIG)
  expect(toolText(model.requests[2]!.messages!)).toContain(BIG)
  expect(toolText(model.requests[3]!.messages!)).toContain('Observation stored')
  expect(toolText(model.requests[3]!.messages!)).not.toContain(BIG)
  expect(toolText(history.messages())).toContain(BIG)
  expect(requests).toHaveLength(4)
})
