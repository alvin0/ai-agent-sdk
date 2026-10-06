import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelAdapter, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ModelInvocationContext, StreamChunk } from '@alvin0/ai-agent-sdk-core/provider'
import { booleanQuestion, choiceQuestion, createDecisionRuntime, createDecisionTask, evaluateDecisionBatch, llmDecisionAdapter, llmDecisionPlugin, snapshotDecisionInput, validateDecisionResult, type DecisionInput, type DecisionModelHandle } from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafeAdapter, typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const input = { state: 'x', questions: { yes: booleanQuestion('Is x present?') } }
const result = { model: 'm', answers: { yes: { type: 'boolean' as const, value: true } } }
const wire = () => new Response(JSON.stringify({ model: 'm', answers: { yes: { type: 'noul', noul: 0.9 } } }))
class Llm extends ModelAdapter {
  calls: GenerateOptions[] = []
  override async *stream(options: GenerateOptions, _context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"answers":{"yes":{"value":true}}}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
afterEach(() => vi.useRealTimers())
describe('decision deadlines and preparation context', () => {
  it('forwards context into preparation and honors its default on a prepared call', async () => {
    const adapter = new Llm()
    const prepare = vi.spyOn(adapter, 'prepareCall')
    const stream = vi.spyOn(adapter, 'stream')
    const context: ModelInvocationContext = { agentId: 'tenant-a' }
    const bridge = llmDecisionAdapter({ adapter })
    const runtime = createDecisionRuntime({ providers: [llmDecisionPlugin({ id: 'p', routes: ['p'], adapter })] })
    try {
      await runtime.decisionModel({ provider: 'p', model: 'm' }).evaluate(input, context)
      expect(prepare.mock.calls[0]?.[3]).toBe(context)
      const prepared = await bridge.prepareDecisionCall('p', 'm', undefined, context)
      await prepared.evaluate({ ...input, provider: 'p', model: 'm' })
      expect(stream.mock.calls.at(-1)?.[1]).toBe(context)
    } finally { await runtime.close() }
  })
  it('keeps invocation headers through the actual OpenAI HTTP pipeline', async () => {
    let header: string | null = null
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      header = new Headers(options?.headers).get('x-audit-tenant')
      const frames = [
        { type: 'response.created', response: { id: 'r1' } },
        { type: 'response.output_item.added', item: { id: 'i1', type: 'message' } },
        { type: 'response.output_item.done', item: { id: 'i1', type: 'message', content: [{ type: 'output_text', text: '{"answers":{"yes":{"value":true}}}' }] } },
        { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 12, output_tokens: 8 } } },
      ]
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    await llmDecisionAdapter({ adapter: openAiAdapter({ apiKey: 'fake', fetch }) }).evaluate({ ...input, provider: 'p', model: 'm' }, { providerOptions: { headers: { 'x-audit-tenant': 'tenant-a' } } })
    expect(header).toBe('tenant-a')
  })
  it('lets a 60s runtime deadline run past 30s without imposing a bridge default', async () => {
    vi.useFakeTimers()
    const adapter = new Llm()
    vi.spyOn(adapter, 'stream').mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })
    const runtime = createDecisionRuntime({ timeoutMs: 60_000, retryPolicy: { mode: 'normal', maxRetries: 0 }, providers: [llmDecisionPlugin({ id: 'p', routes: ['p'], adapter })] })
    let settled = false
    try {
      const pending = runtime.decisionModel({ provider: 'p', model: 'm' }).evaluate(input)
      const checked = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
      void pending.then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(30_001)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      await checked
    } finally { await runtime.close() }
  })
  it.each(['fetch', 'credential'] as const)('enforces direct TypeSafe per-call deadlines during %s', async stage => {
    vi.useFakeTimers()
    const { defineCredentialSource } = await import('@alvin0/ai-agent-sdk-core/provider')
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    const apiKey = stage === 'fetch' ? 'fake' : defineCredentialSource({ id: 'hung', resolve: () => new Promise<string>(() => {}) })
    const adapter = typesafeAdapter({ apiKey, fetch, requestTimeoutMs: 100 })
    const checked = expect(adapter.evaluate({ ...input, provider: 'p', model: 'm', timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await checked
    if (stage === 'credential') expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects invalid per-call timeout before direct TypeSafe network IO', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => wire())
    await expect(typesafeAdapter({ apiKey: 'fake', fetch }).evaluate({ ...input, provider: 'p', model: 'm', timeoutMs: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('preserves a caller TIMEOUT reason without converting it to ABORTED', async () => {
    const controller = new AbortController()
    controller.abort(new ModelError('deadline', 'TIMEOUT'))
    const runtime = createDecisionRuntime({ providers: [llmDecisionPlugin({ id: 'p', routes: ['p'], adapter: new Llm() })] })
    try { await expect(runtime.decisionModel({ provider: 'p', model: 'm' }).evaluate({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'TIMEOUT' }) }
    finally { await runtime.close() }
  })
})
describe('retry precedence and immutable request reuse', () => {
  it('inherits runtime retry policy when TypeSafe does not explicitly override it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 503 }))
    const runtime = createDecisionRuntime({ retryPolicy: { mode: 'normal', maxRetries: 0 }, providers: [typesafePlugin({ apiKey: 'fake', fetch })] })
    try {
      await expect(runtime.decisionModel({ provider: 'typesafe', model: 'm' }).evaluate(input)).rejects.toMatchObject({ code: 'SERVER' })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { await runtime.close() }
  })
  it('keeps explicit TypeSafe retry policy precedence and sends identical bodies across retries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockImplementation(async () => wire())
    const runtime = createDecisionRuntime({ retryPolicy: { mode: 'normal', maxRetries: 0 }, providers: [typesafePlugin({ apiKey: 'fake', fetch, retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1 } } })] })
    try {
      await runtime.decisionModel({ provider: 'typesafe', model: 'm' }).evaluate(input)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body)
    } finally { await runtime.close() }
  })
  it('reuses message identity/schema through retry and rubric through independent task calls', async () => {
    const adapter = new Llm(), calls: GenerateOptions[] = []
    vi.spyOn(adapter, 'stream').mockImplementation(async function* (options) {
      calls.push(options)
      if (calls.length === 1) throw new ModelError('retry', 'SERVER')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"answers":{"yes":{"value":true}}}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const runtime = createDecisionRuntime({ providers: [llmDecisionPlugin({ id: 'p', routes: ['p'], adapter })], retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1 } } })
    try {
      const task = createDecisionTask(runtime.decisionModel({ provider: 'p', model: 'm' }), { questions: input.questions })
      await task.evaluate('x')
      await task.evaluate('different state')
      expect(calls[0]?.outputFormat).toBe(calls[1]?.outputFormat)
      expect(calls[0]?.messages).toBe(calls[1]?.messages)
      expect(calls[1]?.outputFormat).toBe(calls[2]?.outputFormat)
      expect(calls[1]?.messages).not.toBe(calls[2]?.messages)
      const content = calls[0]!.messages[0]!.content[0]!
      if (content.type !== 'text') throw new Error('Expected text')
      expect(content.text.startsWith('{"questions":')).toBe(true)
      expect(calls[0]?.system).not.toContain('probabilities must sum')
    } finally { await runtime.close() }
  })
  it('never trusts arbitrary frozen caller data or lets SDK snapshots bypass new capabilities', () => {
    const mutable = { yes: booleanQuestion('original') }
    const raw = Object.freeze({ state: 'x', questions: mutable })
    const captured = snapshotDecisionInput(raw)
    mutable.yes = booleanQuestion('changed')
    expect(captured.questions.yes.instructions).toBe('original')
    expect(snapshotDecisionInput(captured)).toBe(captured)
    expect(() => snapshotDecisionInput(captured, { questionTypes: ['choice'] })).toThrow('Unsupported')
    const choices = snapshotDecisionInput({ state: 'x', questions: { route: choiceQuestion('Pick', { a: null, b: null, c: null }) } })
    expect(() => snapshotDecisionInput(choices, { maxChoiceOptions: 2 })).toThrow('count')
  })
  it('revalidates foreign output and a validated result against a different rubric', () => {
    const questions = snapshotDecisionInput(input).questions
    const captured = validateDecisionResult(result, questions)
    expect(validateDecisionResult(captured, questions)).toBe(captured)
    const foreign = Object.freeze({ model: 'm', answers: { yes: { type: 'boolean', value: 'true' } } })
    expect(() => validateDecisionResult(foreign, input.questions)).toThrow('boolean')
    expect(() => validateDecisionResult(captured, { route: choiceQuestion('Pick', { a: null, b: null }) })).toThrow('ids')
  })
  it('does not skip output validation after caller-owned rubric mutation', () => {
    const questions = { yes: booleanQuestion('Present?') }
    const captured = validateDecisionResult(result, questions)
    Object.assign(questions, { yes: choiceQuestion('Choose', { a: null, b: null }) })
    expect(() => validateDecisionResult(captured, questions)).toThrow('type')
  })
  it('keeps combined byte/node/depth bounds when state and rubric are captured separately', () => {
    expect(() => snapshotDecisionInput({ state: 'x'.repeat(2_097_130), questions: input.questions })).toThrow('byte limit')
    expect(() => snapshotDecisionInput({ state: Array(99_998).fill(null), questions: input.questions })).toThrow('structural')
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 64; depth++) nested = [nested]
    expect(() => snapshotDecisionInput({ state: nested as string[], questions: input.questions })).toThrow('structural')
  })
})
describe('batch snapshot sharing and custom handle deadlines', () => {
  it('shares the detached task rubric while capturing each queued state', async () => {
    const captured: Parameters<typeof snapshotDecisionInput>[0][] = []
    const model = { async evaluate(request: DecisionInput) { captured.push(request); return result } } as DecisionModelHandle
    const task = createDecisionTask(model, { questions: input.questions })
    const queued = { text: 'original' }
    const pending = task.evaluateBatch([{ text: 'first' }, queued], { concurrency: 1 })
    queued.text = 'changed'
    await pending
    expect(captured[0]?.questions).toBe(task.questions)
    expect(captured[1]?.questions).toBe(task.questions)
    expect(captured[1]?.state).toEqual({ text: 'original' })
  })
  it('times out a noncooperative custom item and continues queued siblings', async () => {
    vi.useFakeTimers()
    const model = { evaluate: vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(result) }
    const pending = evaluateDecisionBatch(model, [{ ...input, timeoutMs: 10 }, input], { concurrency: 1, timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(11)
    const results = await pending
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'TIMEOUT' } })
    expect(results[1]).toMatchObject({ status: 'fulfilled' })
    expect(model.evaluate).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
