import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelAdapter, ModelError } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource, type EndProviderAttemptInput, type ModelInvocationContext, type ProviderAttemptHandle, type StreamChunk } from '@alvin0/ai-agent-sdk-core/provider'
import { booleanQuestion, createDecisionRuntime, evaluateDecisionBatch, llmDecisionAdapter, snapshotDecisionInput, type DecisionModelHandle } from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafeAdapter, typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'

const input = { state: 'synthetic request', questions: { yes: booleanQuestion('Present?') } }
const request = () => ({ ...input, provider: 'typesafe', model: 'm' })
const result = { model: 'm', answers: { yes: { type: 'boolean' as const, value: true } } }
const wire = () => Response.json({ model: 'm', answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 4 } })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function accounting(end: (value: EndProviderAttemptInput) => unknown): ModelInvocationContext {
  return { startProviderAttempt: async () => ({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', end }) } as unknown as ModelInvocationContext
}
afterEach(() => vi.useRealTimers())

describe('adversarial decision lifecycle', () => {
  it('never closes the same physical attempt twice when successful accounting throws', async () => {
    const failure = new ModelError('audit terminal rejected', 'OBSERVABILITY_AUDIT_UNAVAILABLE')
    const end = vi.fn(() => { throw failure })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => wire())
    await expect(typesafeAdapter({ apiKey: 'fake', fetch }).evaluate(request(), accounting(end))).rejects.toBe(failure)
    expect(end).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', dispatchState: 'sent', reported: { inputTokens: 12, outputTokens: 4 } }))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('settles timeout before a late admission handle and closes that handle without dispatch', async () => {
    vi.useFakeTimers()
    const admission = deferred<ProviderAttemptHandle>(), fetch = vi.fn<typeof globalThis.fetch>(async () => wire())
    const end = vi.fn(() => { throw new Error('late sink failure') })
    const pending = typesafeAdapter({ apiKey: 'fake', fetch, requestTimeoutMs: 10 }).evaluate(request(), { startProviderAttempt: () => admission.promise })
    const checked = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await checked
    admission.resolve({ traceparent: 'unused', end } as unknown as ProviderAttemptHandle)
    await flush()
    expect(end).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledWith({ status: 'aborted', dispatchState: 'not-sent' })
    expect(fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['resolve', 'reject'] as const)('observes a credential that %ss after timeout without dispatch', async mode => {
    vi.useFakeTimers()
    const credential = deferred<string>(), fetch = vi.fn<typeof globalThis.fetch>(async () => wire())
    const start = vi.fn(async () => { throw new Error('must not start') })
    const pending = typesafeAdapter({ apiKey: defineCredentialSource({ id: 'late', resolve: () => credential.promise }), fetch, requestTimeoutMs: 10 }).evaluate(request(), { startProviderAttempt: start })
    const checked = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await checked
    if (mode === 'resolve') credential.resolve('fake')
    else credential.reject(new Error('PRIVATE%LATE%CREDENTIAL'))
    await flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['resolve', 'reject'] as const)('owns a fetch that %ss after timeout and never ends the attempt again', async mode => {
    vi.useFakeTimers()
    const response = deferred<Response>(), end = vi.fn()
    const cancel = vi.fn(async () => { throw new Error('PRIVATE%LATE%CANCEL') })
    const pending = typesafeAdapter({ apiKey: 'fake', fetch: () => response.promise, requestTimeoutMs: 10 }).evaluate(request(), accounting(end))
    const checked = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await checked
    if (mode === 'resolve') response.resolve(new Response(new ReadableStream({ cancel })))
    else response.reject(new TypeError('PRIVATE%LATE%FETCH'))
    await flush()
    expect(cancel).toHaveBeenCalledTimes(mode === 'resolve' ? 1 : 0)
    expect(end).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', dispatchState: 'sent', error: expect.objectContaining({ code: 'TIMEOUT' }) }))
    expect(end.mock.calls[0]![0].reported).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not retry when close races with scheduling a retry', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 529 })), end = vi.fn()
    const runtime = createDecisionRuntime({ retryPolicy: { mode: 'normal', maxRetries: 10, backoff: { initialDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 } }, providers: [typesafePlugin({ apiKey: 'fake', fetch })] })
    const retry = vi.fn(() => { void runtime.close() })
    await expect(runtime.decisionModel({ provider: 'typesafe', model: 'm' }).evaluate(input, { ...accounting(end), recordProviderRetry: retry })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a directly invoked prepared LLM call and observes late iterator teardown', async () => {
    vi.useFakeTimers()
    const next = deferred<IteratorResult<StreamChunk>>(), teardown = vi.fn(async () => { throw new Error('late teardown') })
    class Stalled extends ModelAdapter {
      override stream(): AsyncIterable<StreamChunk> { return { [Symbol.asyncIterator]: () => ({ next: () => next.promise, return: teardown }) } }
    }
    const prepared = await llmDecisionAdapter({ adapter: new Stalled() }).prepareDecisionCall('p', 'm')
    const controller = new AbortController()
    let outcome: unknown
    const pending = prepared.evaluate({ ...input, provider: 'p', model: 'm', signal: controller.signal, timeoutMs: 10 }).then(value => { outcome = value }, error => { outcome = error })
    try {
      await vi.advanceTimersByTimeAsync(11)
      expect(outcome).toMatchObject({ code: 'TIMEOUT' })
    } finally {
      controller.abort()
      await pending
      next.reject(new Error('late iterator rejection'))
      await flush()
    }
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps ordered partial results when auth failure, pre-abort, stalled item and queued success overlap', async () => {
    vi.useFakeTimers()
    const controller = new AbortController(); controller.abort()
    const calls: unknown[] = []
    const model = { async evaluate(value) {
      calls.push(value.state)
      if (value.state === 'auth') throw new ModelError('denied', 'AUTH')
      if (value.state === 'hang') return new Promise(() => {})
      return result
    } } as DecisionModelHandle
    const pending = evaluateDecisionBatch(model, [{ ...input, state: 'hang', timeoutMs: 10 }, { ...input, state: 'auth' }, { ...input, state: 'pre-aborted', signal: controller.signal }, { ...input, state: 'queued' }], { concurrency: 2, timeoutMs: 100 })
    await vi.advanceTimersByTimeAsync(11)
    expect(await pending).toMatchObject([
      { status: 'rejected', reason: { code: 'TIMEOUT' } }, { status: 'rejected', reason: { code: 'AUTH' } }, { status: 'rejected', reason: { code: 'ABORTED' } }, { status: 'fulfilled', value: result },
    ])
    expect(calls).toEqual(['hang', 'auth', 'queued'])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('adversarial JSON snapshots', () => {
  it.each(['getter', 'iterator', 'extra', 'symbol', 'toJSON'] as const)('rejects array %s hooks/properties without running caller code', kind => {
    const state = ['original']
    const hook = vi.fn(() => 'changed')
    if (kind === 'getter') Object.defineProperty(state, '0', { get: hook, enumerable: true })
    if (kind === 'iterator') Object.defineProperty(state, Symbol.iterator, { value: vi.fn(function* () { hook(); yield 'changed' }) })
    if (kind === 'extra') Object.defineProperty(state, 'extra', { value: 'lost', enumerable: true })
    if (kind === 'symbol') Object.defineProperty(state, Symbol('extra'), { value: 'lost' })
    if (kind === 'toJSON') Object.defineProperty(state, 'toJSON', { value: hook })
    expect(() => snapshotDecisionInput({ ...input, state })).toThrow()
    expect(hook).not.toHaveBeenCalled()
  })
})
