import { describe, it, expect, vi } from 'vitest'
import { createMessage, createTextMessage, ModelAdapter, ModelRegistry, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, Message, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { History, runTurn } from '@alvin0/ai-agent-sdk-core/agent'
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'
import { createMemorySpillStore, defineActionFusion, diagnosticLineNumbers, reduceEvidence } from '@alvin0/ai-agent-sdk-core/tools'
import type { BeforeStepContext } from '@alvin0/ai-agent-sdk-core/agent'
import type { ActionFusionStep, EvidenceReductionInput, SpillStore } from '@alvin0/ai-agent-sdk-core/tools'
import { runOptionalHook } from '../../packages/core/src/agent/loop/turn/hooks.ts'
import { ModelRegistry as SourceRegistry } from '../../packages/core/src/runtime/registry.ts'
import { History as SourceHistory } from '../../packages/core/src/agent/history/history.ts'
import type { RunTurnOptions } from '../../packages/core/src/agent/loop/turn/types.ts'

const signal = new AbortController().signal
const BIG = 'routine inventory\n'.repeat(1000)
const LOG = 'routine build output\n'.repeat(300) + 'FAIL auth.spec.ts:1\nSECRET DIAGNOSTIC\nexit 1\n'
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function history(text = BIG) {
  const value = new History(), callId = ToolCallId('read')
  value.append({ kind: 'user', message: createTextMessage('Keep the user constraint.') })
  value.append({ kind: 'assistant', message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'm' }, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] }) })
  value.append({ kind: 'tool-call', callId, name: 'read', rawArguments: '{}' })
  const content = [{ type: 'text' as const, text }]
  value.append({ kind: 'tool-result', callId, result: { isError: false, value: text, content }, message: createMessage({ role: 'user', source: { kind: 'tool', name: 'read', callId }, content: [{ type: 'tool-result', toolCallId: callId, content }] }) })
  return value
}
function context(value: History, messages = value.messages()): BeforeStepContext { return { turn: 0, step: 0, messages, snapshot: value.snapshot(), signal, emit: async () => {} } }
async function projection(optimizer: ReturnType<typeof createContextOptimizer>, value: History, messages?: readonly Message[]) {
  const decision = await optimizer.hooks.beforeStep!(context(value, messages))
  if (decision.kind === 'reject') throw new Error(decision.reason)
  return decision.messages ?? value.messages()
}
const milestone = { id: 'read', throughSeq: 4, summary: 'SECRET DIAGNOSTIC identified in auth.spec.ts', remainingTurns: 3, compactionCost: 0 }

describe('optimization edge audit regressions', () => {
  it('does not resurrect a cached milestone summary after an application redacts the same message IDs', async () => {
    const value = history(LOG), optimizer = createContextOptimizer({ store: createMemorySpillStore(), archive: async () => {} })
    optimizer.completeMilestone(milestone)
    expect(JSON.stringify(await projection(optimizer, value))).toContain('SECRET DIAGNOSTIC')
    const redacted = value.messages().map(message => ({ ...message, content: message.content.map(block => block.type !== 'tool-result' ? block
      : { ...block, content: [{ type: 'text' as const, text: 'Access revoked. Evidence unavailable.' }] }) }))
    const messages = await projection(optimizer, value, redacted)
    expect(JSON.stringify(messages)).not.toContain('SECRET DIAGNOSTIC')
    expect(JSON.stringify(messages)).toContain('Access revoked')
  })
  it('preserves application projection and prepend after disposal', async () => {
    const value = history(), optimizer = createContextOptimizer({ store: createMemorySpillStore() })
    const projected = [createTextMessage('APPLICATION PROJECTION')], prepend = [createTextMessage('STEER')]
    const hooks = optimizer.wrapHooks({ beforeStep: () => ({ kind: 'proceed', messages: projected, prepend }) })
    optimizer.dispose()
    expect(await hooks.beforeStep!(context(value))).toMatchObject({ messages: projected, prepend })
  })
  it('does not repopulate state or reduce logs after disposal while save is pending', async () => {
    const value = history(LOG), entered = gate(), release = gate(), backing = createMemorySpillStore()
    const store: SpillStore = { ...backing, async save(text, ctx) { entered.resolve(); await release.promise; return backing.save(text, ctx) } }
    const reduce = vi.fn(async (input: EvidenceReductionInput) => ({ status: input.status, lines: diagnosticLineNumbers(input.text).map(line => ({ line, text: input.text.split('\n')[line - 1]! })) }))
    const optimizer = createContextOptimizer({ store, reducer: { reduce }, log: () => ({ status: 'fail' }) })
    const pending = projection(optimizer, value)
    await entered.promise; optimizer.dispose(); release.resolve()
    const messages = await pending
    expect(reduce).not.toHaveBeenCalled()
    expect(messages).toEqual(value.messages())
    expect(optimizer.metrics().verifiedReductions).toBe(0)
  })
  it('rejects reuse across different histories and concurrent prepares', async () => {
    const first = history(), second = history(), entered = gate(), release = gate(), backing = createMemorySpillStore()
    const store: SpillStore = { ...backing, async save(text, ctx) { entered.resolve(); await release.promise; return backing.save(text, ctx) } }
    const optimizer = createContextOptimizer({ store })
    const pending = projection(optimizer, first); await entered.promise
    const concurrent = await optimizer.hooks.beforeStep!(context(first))
    expect(concurrent.kind).toBe('reject')
    release.resolve(); await pending
    const different = await optimizer.hooks.beforeStep!(context(second))
    expect(different.kind).toBe('reject')
  })
  it('rejects sparse pipelines and non-string child names at construction', () => {
    const steps = new Array<ActionFusionStep<unknown>>(2)
    steps[0] = { tool: 'edit', arguments: () => ({}) }
    expect(() => defineActionFusion({ name: 'fuse', description: 'Fuse', parameters: {}, steps })).toThrow()
    expect(() => defineActionFusion({ name: 'fuse', description: 'Fuse', parameters: {}, steps: [{ tool: 42 as unknown as string, arguments: () => ({}) }] })).toThrow()
  })
  it('captures authoritative input and required lines before awaiting an untrusted reducer', async () => {
    const required = [1], input: EvidenceReductionInput = { text: LOG, status: 'fail', signal }
    const result = await reduceEvidence(input, { async reduce(request) {
      required.length = 0
      Reflect.set(input, 'status', 'pass')
      const lines = request.text.split('\n')
      return { status: 'pass', lines: diagnosticLineNumbers(request.text).map(line => ({ line, text: lines[line - 1]! })) }
    } }, required)
    expect(result.accepted).toBe(false)
    expect(result.text).toBe(LOG)
  })
  it('refuses invalid runtime outcome labels without calling the reducer', async () => {
    const reduce = vi.fn(async () => ({ status: 'typo' as EvidenceReductionInput['status'], lines: diagnosticLineNumbers(LOG).map(line => ({ line, text: LOG.split('\n')[line - 1]! })) }))
    const result = await reduceEvidence({ text: LOG, status: 'typo' as EvidenceReductionInput['status'], signal }, { reduce })
    expect(result.accepted).toBe(false)
    expect(reduce).not.toHaveBeenCalled()
  })
  it.each(['archive', 'reducer', 'read'] as const)('stops pending %s work on disposal without publishing projection state', async phase => {
    const value = history(LOG), entered = gate(), release = gate(), backing = createMemorySpillStore()
    let callbackSignal: AbortSignal | undefined
    const wait = async () => { entered.resolve(); await release.promise }
    const optimizer = createContextOptimizer({ fullRequests: 1, observationThresholdBytes: 1000,
      store: { ...backing, async read(locator, range) { if (phase === 'read') await wait(); return backing.read(locator, range) } },
      archive: async (_snapshot, _milestone, hookSignal) => { if (phase === 'archive') { callbackSignal = hookSignal; await wait() } },
      ...phase === 'reducer' ? { log: () => ({ status: 'fail' as const }), reducer: { async reduce(input: EvidenceReductionInput) {
        callbackSignal = input.signal; await wait()
        return { status: input.status, lines: diagnosticLineNumbers(input.text).map(line => ({ line, text: input.text.split('\n')[line - 1]! })) }
      } } } : {},
    })
    if (phase === 'archive') optimizer.completeMilestone(milestone)
    if (phase !== 'archive') {
      await projection(optimizer, value)
      await optimizer.hooks.checkpoint!({ kind: 'before-model-request', snapshot: value.snapshot(), signal,
        request: { provider: 'fixture', model: 'm', messages: value.messages() } })
    }
    const pending = projection(optimizer, value); await entered.promise
    optimizer.dispose(); release.resolve()
    expect(await pending).toEqual(value.messages())
    if (phase !== 'read') expect(callbackSignal?.aborted).toBe(true)
    expect(optimizer.metrics().compactedMilestones).toBe(0)
    expect(optimizer.metrics().verifiedReductions).toBe(0)
  })
  it('captures host log verdict before asynchronous storage can mutate it', async () => {
    const value = history(LOG), entered = gate(), release = gate(), backing = createMemorySpillStore()
    const verdict = { status: 'fail' as const, requiredLines: [1] }
    const optimizer = createContextOptimizer({ store: { ...backing, async save(text, ctx) { entered.resolve(); await release.promise; return backing.save(text, ctx) } },
      observationThresholdBytes: 100000, log: () => verdict, reducer: { async reduce(input) {
        return { status: 'pass', lines: diagnosticLineNumbers(input.text).map(line => ({ line, text: input.text.split('\n')[line - 1]! })) }
      } } })
    const pending = projection(optimizer, value); await entered.promise
    Reflect.set(verdict, 'status', 'pass'); verdict.requiredLines.length = 0; release.resolve()
    expect(JSON.stringify(await pending)).toContain(LOG.replaceAll('\n', '\\n'))
    expect(optimizer.metrics().verifiedReductions).toBe(0)
  })
  it.each([0, -1, 1.5, NaN, Infinity, 99999])('rejects invalid required evidence line %s before model execution', async line => {
    const reduce = vi.fn()
    expect((await reduceEvidence({ text: LOG, status: 'fail', signal }, { reduce }, [line])).text).toBe(LOG)
    expect(reduce).not.toHaveBeenCalled()
  })
  it('retains legacy Unicode paging semantics over fractional, unbounded and malformed ranges', async () => {
    const text = 'A😀B\ud800C\udc00\nZ', store = createMemorySpillStore()
    const record = await store.save(text, { toolName: 'read', callId: 'x' })
    for (const offset of [-1, 0, 0.5, 1.5, 3, 100, NaN, Infinity]) {
      for (const limit of [-1, 0, 0.5, 1.5, 3, NaN, Infinity]) {
        const points = [...text], normalized = Math.min(Math.max(0, offset), points.length)
        expect((await store.read(record.locator, { offset, limit }))?.text).toBe(points.slice(normalized, normalized + Math.max(1, limit)).join(''))
      }
    }
  })
  it.each([10 * 1024, 10 * 1024 + 1])('packs only observations strictly above the byte threshold: %s', async bytes => {
    const text = 'x'.repeat(bytes), value = history(text), save = vi.fn(createMemorySpillStore().save)
    const optimizer = createContextOptimizer({ store: { ...createMemorySpillStore(), save } })
    await projection(optimizer, value)
    expect(save).toHaveBeenCalledTimes(bytes > 10 * 1024 ? 1 : 0)
  })
  it('invalidates milestone ownership when regular pressure compaction replaces the range', async () => {
    const value = history(), optimizer = createContextOptimizer({ store: createMemorySpillStore(), archive: async () => {} })
    optimizer.completeMilestone(milestone)
    expect(JSON.stringify(await projection(optimizer, value))).toContain('[Completed read:')
    value.append({ kind: 'user', message: createTextMessage('PRESSURE COMPACTED STATE') }, { op: 'replace', from: 2, to: 4 })
    const payload = JSON.stringify(await projection(optimizer, value))
    expect(payload).not.toContain('[Completed read:')
    expect(payload).toContain('PRESSURE COMPACTED STATE')
  })
  it('skips future and overlapping milestone boundaries without duplicate summaries', async () => {
    const value = history(), archive = vi.fn(async () => {}), optimizer = createContextOptimizer({ store: createMemorySpillStore(), archive })
    optimizer.completeMilestone({ ...milestone, id: 'future', throughSeq: 999 })
    optimizer.completeMilestone(milestone)
    optimizer.completeMilestone({ ...milestone, id: 'overlap' })
    const payload = JSON.stringify(await projection(optimizer, value))
    expect(archive).toHaveBeenCalledTimes(1)
    expect(payload).toContain('[Completed read:')
    expect(payload).not.toContain('[Completed overlap:')
    expect(optimizer.metrics().skippedMilestones).toBe(2)
  })
  it('forwards a hook deadline to cooperative callbacks and leaves the parent signal alive', async () => {
    const parent = new AbortController(), registry = new SourceRegistry()
    try {
      await expect(runOptionalHook(async (ctx: { signal: AbortSignal }) => {
        await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
      }, [{ signal: parent.signal }], { registry, config: { provider: 'fixture', model: 'm' }, history: new SourceHistory(), hookTimeoutMs: 15, hookTeardownTimeoutMs: 50 } satisfies RunTurnOptions, parent.signal, 'cooperative')).rejects.toMatchObject({ code: 'HOOK_TIMEOUT' })
      expect(parent.signal.aborted).toBe(false)
    } finally { parent.abort() }
  })
})

class FinalModel extends ModelAdapter {
  requests: GenerateOptions[] = []
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
it('preserves late steering appended during a projected beforeStep hook', async () => {
  const value = history(), model = new FinalModel(), registry = new ModelRegistry()
  registry.registerAdapter(['fixture'], model)
  const optimizer = createContextOptimizer({ store: createMemorySpillStore() })
  for await (const _ of runTurn({ registry, config: { provider: 'fixture', model: 'm' }, history: value,
    hooks: optimizer.wrapHooks({ async beforeStep() { value.append({ kind: 'user', message: createTextMessage('LATE STEERING') }); return { kind: 'proceed' } } }) })) { /* consume */ }
  expect(model.requests[0]?.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'LATE STEERING' }])
})
it('falls back to current history after a replacement made a projection stale', async () => {
  const value = new History(), model = new FinalModel(), registry = new ModelRegistry()
  value.append({ kind: 'user', message: createTextMessage('first') })
  value.append({ kind: 'user', message: createTextMessage('OLD STATE') })
  registry.registerAdapter(['fixture'], model)
  for await (const _ of runTurn({ registry, config: { provider: 'fixture', model: 'm' }, history: value,
    hooks: { beforeStep(ctx) {
      value.append({ kind: 'user', message: createTextMessage('NEW STATE') }, { op: 'replace', from: 2, to: 2 })
      return { kind: 'proceed', messages: ctx.messages }
    } } })) { /* consume */ }
  expect(JSON.stringify(model.requests[0]?.messages)).not.toContain('OLD STATE')
  expect(JSON.stringify(model.requests[0]?.messages)).toContain('NEW STATE')
})
it('preserves application redactions while reconciling a simultaneous history replacement', async () => {
  const value = new History(), model = new FinalModel(), registry = new ModelRegistry()
  value.append({ kind: 'user', message: createTextMessage('PRIVATE/INPUT%audit') })
  value.append({ kind: 'user', message: createTextMessage('OLD STATE') })
  registry.registerAdapter(['fixture'], model)
  for await (const _ of runTurn({ registry, config: { provider: 'fixture', model: 'm' }, history: value,
    hooks: { beforeStep(ctx) {
      value.append({ kind: 'user', message: createTextMessage('NEW STATE') }, { op: 'replace', from: 2, to: 2 })
      return { kind: 'proceed', messages: ctx.messages.map((message, index) => index === 0
        ? { ...message, content: [{ type: 'text' as const, text: 'REDACTED' }] } : message) }
    } } })) { /* consume */ }
  const payload = JSON.stringify(model.requests[0]?.messages)
  expect(payload).not.toContain('PRIVATE/INPUT%audit')
  expect(payload).not.toContain('OLD STATE')
  expect(payload).toContain('REDACTED')
  expect(payload).toContain('NEW STATE')
})
