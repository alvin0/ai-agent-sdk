import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { ModelError } from '@alvin0/ai-agent-sdk-core'
import { booleanQuestion, choiceQuestion, createDecisionRuntime, createDecisionTask, evaluateDecisionBatch, gateBoolean, gateChoice, DecisionAdapter, defineDecisionProviderPlugin, scoreQuestion, snapshotDecisionInput, validateDecisionResult, type DecisionRequest, type DecisionResult, type DecisionModelHandle, type ChoiceAnswer } from '@alvin0/ai-agent-sdk-decision-adapter'

const questions = { route: choiceQuestion('Choose a route', { billing: null, support: 'Technical support' }) }
const input = { state: 'Refund please', questions }

describe('reusable tasks and independent-state batches', () => {
  it('binds a frozen rubric, preserves types and applies call-over-task defaults', async () => {
    const adapter = new FakeAdapter()
    const evaluate = vi.spyOn(adapter, 'evaluate')
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['p'], adapter)
    const mutable = { route: choiceQuestion('Original', { billing: null, support: null }) }
    const context = { recordProviderRetry: vi.fn() }
    const task = createDecisionTask(runtime.decisionModel({ provider: 'p', model: 'm' }), { questions: mutable, timeoutMs: 500, context })
    mutable.route = choiceQuestion('Changed', { billing: null, support: null })
    expect(task.questions.route.instructions).toBe('Original')
    const answer = await task.evaluate('one', { timeoutMs: 700 })
    expectTypeOf(answer.answers.route.choice).toEqualTypeOf<'billing' | 'support'>()
    expect(adapter.call.mock.calls[0]![0].timeoutMs).toBe(700)
    expect(evaluate).toHaveBeenLastCalledWith(expect.anything(), context)
    const batch = await task.evaluateBatch(['two', 'three'], { concurrency: 1 })
    expect(batch.map(item => item.status)).toEqual(['fulfilled', 'fulfilled'])
    if (batch[0]?.status === 'fulfilled') expectTypeOf(batch[0].value.answers.route.choice).toEqualTypeOf<'billing' | 'support'>()
    expect(adapter.call.mock.calls[1]![0].timeoutMs).toBe(500)
    expect(evaluate).toHaveBeenLastCalledWith(expect.anything(), context)
    await runtime.close()
  })
  it('bounds concurrency, preserves ordering, and retains per-item failures', async () => {
    const runtime = createDecisionRuntime()
    const adapter = new FakeAdapter()
    let active = 0; let peak = 0
    adapter.call.mockImplementation(async request => {
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, request.state === 'first' ? 20 : 1))
      active--
      if (request.state === 'bad') throw new ModelError('bad input', 'INVALID_REQUEST')
      return { ...result(), model: String(request.state) }
    })
    runtime.registerAdapter(['p'], adapter)
    const batch = await evaluateDecisionBatch(runtime.decisionModel({ provider: 'p', model: 'm' }), ['first', 'bad', 'last'].map(state => ({ ...input, state })), { concurrency: 2 })
    expect(peak).toBe(2)
    expect(batch[0]).toMatchObject({ status: 'fulfilled', value: { model: 'first' } })
    expect(batch[1]).toMatchObject({ status: 'rejected', reason: { code: 'INVALID_REQUEST' } })
    expect(batch[2]).toMatchObject({ status: 'fulfilled', value: { model: 'last' } })
    expect(Object.isFrozen(batch)).toBe(true)
    await runtime.close()
  })
  it('snapshots queued states before the first dispatch', async () => {
    const adapter = new FakeAdapter()
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['p'], adapter)
    const queued = { state: { text: 'original' }, questions }
    const pending = evaluateDecisionBatch(runtime.decisionModel({ provider: 'p', model: 'm' }), [input, queued], { concurrency: 1 })
    queued.state.text = 'modified'
    await pending
    expect(adapter.call.mock.calls[1]![0].state).toEqual({ text: 'original' })
    await runtime.close()
  })
  it.each(['cancel', 'deadline'])('stops queued work and bounds noncooperative calls on %s', async mode => {
    const call = vi.fn(() => new Promise(() => {}))
    const model = { evaluate: call } as DecisionModelHandle
    const controller = new AbortController()
    const pending = evaluateDecisionBatch(model, [input, input, input], { concurrency: 1, timeoutMs: mode === 'deadline' ? 10 : 1000, signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ code: mode === 'deadline' ? 'TIMEOUT' : 'ABORTED' })
    await Promise.resolve()
    if (mode === 'cancel') controller.abort()
    await assertion
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]).toBeDefined()
  })
  it('item cancellation is a partial failure and does not cancel siblings', async () => {
    const adapter = new FakeAdapter()
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['p'], adapter)
    const controller = new AbortController(); controller.abort()
    const batch = await evaluateDecisionBatch(runtime.decisionModel({ provider: 'p', model: 'm' }), [{ ...input, signal: controller.signal }, input], { concurrency: 1 })
    expect(batch[0]).toMatchObject({ status: 'rejected', reason: { code: 'ABORTED' } })
    expect(batch[1]?.status).toBe('fulfilled')
    expect(adapter.call).toHaveBeenCalledTimes(1)
    await runtime.close()
  })
  it('rejects invalid setup before dispatch and accepts empty batches', async () => {
    const call = vi.fn()
    const model = { evaluate: call } as DecisionModelHandle
    await expect(evaluateDecisionBatch(model, [input], { concurrency: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(evaluateDecisionBatch(model, [input], { timeoutMs: Infinity })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(evaluateDecisionBatch(model, Array(1025).fill(input))).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(evaluateDecisionBatch(model, Array(2) as typeof input[])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(evaluateDecisionBatch(model, [input, { ...input, timeoutMs: 0 }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(evaluateDecisionBatch(model, [input, { state: 'bad', questions: {} as typeof questions }])).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(() => createDecisionTask(model, { questions, timeoutMs: 0 })).toThrow()
    expect(call).not.toHaveBeenCalled()
    await expect(evaluateDecisionBatch(model, [])).resolves.toEqual([])
  })
})

describe('application evidence gates', () => {
  const choice: ChoiceAnswer<'billing' | 'support'> = { type: 'choice', choice: 'billing', confidence: 0.8, probabilitySource: 'provider', probabilities: { billing: 0.9, support: 0.1 } }
  it('requires every configured choice threshold and preserves accepted literals', () => {
    const accepted = gateChoice(choice, { minConfidence: 0.8, minProbability: 0.9, minMargin: 0.75 })
    expect(accepted).toEqual({ status: 'accepted', value: 'billing' })
    if (accepted.status === 'accepted') expectTypeOf(accepted.value).toEqualTypeOf<'billing' | 'support'>()
    expect(gateChoice(choice, { minConfidence: 0.81 })).toMatchObject({ status: 'abstained', reason: 'below-threshold' })
    expect(gateChoice(choice, { minProbability: 0.91 })).toHaveProperty('status', 'abstained')
    expect(gateChoice(choice, { minMargin: 0.81 })).toHaveProperty('status', 'abstained')
    expect(gateChoice({ ...choice, probabilities: { billing: 0.5, support: 0.5 } }, { minMargin: 0.01 })).toHaveProperty('status', 'abstained')
  })
  it('abstains when required evidence is absent or has disallowed provenance', () => {
    expect(gateChoice({ type: 'choice', choice: 'billing' }, { minConfidence: 0.7 })).toHaveProperty('reason', 'missing-evidence')
    expect(gateChoice({ ...choice, probabilitySource: 'model-generated' }, { minConfidence: 0.7 })).toHaveProperty('reason', 'untrusted-evidence')
    expect(gateChoice({ ...choice, probabilitySource: 'token-logprobs' }, { minProbability: 0.7, allowedSources: ['token-logprobs'] })).toHaveProperty('status', 'accepted')
    expect(gateChoice({ ...choice, probabilities: undefined } as unknown as typeof choice, { minProbability: 0.7 })).toHaveProperty('reason', 'missing-evidence')
  })
  it.each([[0.1, false], [0.9, true], [0.2, false], [0.8, true]] as const)('uses the raw probability %s to accept %s independently of value', (p, value) => {
    expect(gateBoolean({ type: 'boolean', value: !value, probabilityTrue: p, probabilitySource: 'provider' }, { falseMax: 0.2, trueMin: 0.8 })).toEqual({ status: 'accepted', value })
  })
  it('keeps an uncertainty interval and requires evidence', () => {
    expect(gateBoolean({ type: 'boolean', value: true, probabilityTrue: 0.5, probabilitySource: 'provider' }, { falseMax: 0.2, trueMin: 0.8 })).toHaveProperty('reason', 'below-threshold')
    expect(gateBoolean({ type: 'boolean', value: true, probabilitySource: 'provider' }, { falseMax: 0.2, trueMin: 0.8 })).toHaveProperty('reason', 'missing-evidence')
    expect(gateBoolean({ type: 'boolean', value: true, probabilityTrue: 0.99, probabilitySource: 'model-generated' }, { falseMax: 0.2, trueMin: 0.8 })).toHaveProperty('reason', 'untrusted-evidence')
  })
  it('rejects implicit or malformed thresholds', () => {
    for (const policy of [{}, { minConfidence: NaN }, { minProbability: -1 }, { minMargin: 2 }]) expect(() => gateChoice(choice, policy)).toThrow()
    for (const policy of [{ falseMax: 0.5, trueMin: 0.5 }, { falseMax: 0.8, trueMin: 0.2 }, { falseMax: NaN, trueMin: 1 }]) expect(() => gateBoolean({ type: 'boolean', value: true }, policy)).toThrow()
  })
})
function result(): DecisionResult { return { model: 'actual-v1', answers: { route: { type: 'choice', choice: 'billing' } } } }
class FakeAdapter extends DecisionAdapter {
  readonly call = vi.fn(async (_request: DecisionRequest): Promise<DecisionResult> => result())
  override evaluate(request: DecisionRequest) { return this.call(request) }
}
describe('decision contract and runtime', () => {
  it('infers literal choices and handles multiple provider routes without a catalog allowlist', async () => {
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['a', 'b'], new FakeAdapter())
    const answer = await runtime.decisionModel({ provider: 'b', model: 'new-unlisted-model' }).evaluate(input)
    expectTypeOf(answer.answers.route.choice).toEqualTypeOf<'billing' | 'support'>()
    expect(answer.model).toBe('actual-v1')
    expect(answer.answers.route.probabilities).toBeUndefined()
    expect(Object.isFrozen(answer.answers)).toBe(true)
    await runtime.close()
  })
  it('registers routes atomically and disposal cannot remove a later registration', async () => {
    const runtime = createDecisionRuntime()
    const registration = runtime.registerAdapter(['a'], new FakeAdapter())
    expect(() => runtime.registerAdapter(['b', 'a'], new FakeAdapter())).toThrow('already registered')
    await expect(runtime.decisionModel({ provider: 'b', model: 'm' }).evaluate(input)).rejects.toMatchObject({ code: 'DECISION_ADAPTER_MISSING' })
    registration.dispose()
    runtime.registerAdapter(['a'], new FakeAdapter())
    registration.dispose()
    await expect(runtime.decisionModel({ provider: 'a', model: 'm' }).evaluate(input)).resolves.toHaveProperty('model')
    await runtime.close()
  })
  it('snapshots caller JSON before async preparation', async () => {
    const adapter = new FakeAdapter()
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['p'], adapter)
    const mutable = { state: { text: 'original' }, questions: { ...questions } }
    const pending = runtime.decisionModel({ provider: 'p', model: 'm' }).evaluate(mutable)
    mutable.state.text = 'changed'
    await pending
    expect(adapter.call.mock.calls[0]![0].state).toEqual({ text: 'original' })
    await runtime.close()
  })
  it('prepares once and retries transient failures with the same snapshot', async () => {
    const adapter = new FakeAdapter()
    adapter.call.mockRejectedValueOnce(new ModelError('busy', 'SERVER'))
    const prepare = vi.spyOn(adapter, 'prepareDecisionCall')
    const retry = vi.fn()
    const runtime = createDecisionRuntime({ retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, context: { recordProviderRetry: retry } })
    runtime.registerAdapter(['p'], adapter)
    await runtime.decisionModel({ provider: 'p', model: 'm' }).evaluate(input)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(adapter.call).toHaveBeenCalledTimes(2)
    expect(adapter.call.mock.calls[0]![0]).toBe(adapter.call.mock.calls[1]![0])
    expect(retry).toHaveBeenCalledWith({ nextAttemptNumber: 2, delayMs: 1, failureCode: 'SERVER' })
    await runtime.close()
  })
  it.each(['AUTH', 'INVALID_REQUEST', 'MALFORMED_RESPONSE'])('does not retry %s by default', async code => {
    const adapter = new FakeAdapter()
    adapter.call.mockRejectedValue(new ModelError('failure', code))
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['p'], adapter)
    await expect(runtime.decisionModel({ provider: 'p', model: 'm' }).evaluate(input)).rejects.toMatchObject({ code })
    expect(adapter.call).toHaveBeenCalledTimes(1)
    await runtime.close()
  })
  it('pre-aborted requests never dispatch', async () => {
    const adapter = new FakeAdapter()
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['p'], adapter)
    const controller = new AbortController(); controller.abort()
    await expect(runtime.decisionModel({ provider: 'p', model: 'm' }).evaluate({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(adapter.call).not.toHaveBeenCalled()
    await runtime.close()
  })
  it('deadline settles a noncooperative adapter and close rejects subsequent calls', async () => {
    const adapter = new FakeAdapter()
    adapter.call.mockImplementation(() => new Promise(() => {}))
    const runtime = createDecisionRuntime({ timeoutMs: 10 })
    runtime.registerAdapter(['p'], adapter)
    const handle = runtime.decisionModel({ provider: 'p', model: 'm' })
    await expect(handle.evaluate(input)).rejects.toMatchObject({ code: 'TIMEOUT' })
    const pending = handle.evaluate({ ...input, timeoutMs: 10_000 })
    const aborted = expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    await runtime.close(); await aborted
    await expect(handle.evaluate(input)).rejects.toMatchObject({ code: 'DECISION_RUNTIME_CLOSED' })
  })
  it('validates plugin claims and reverses cleanup on setup failure', () => {
    const cleanup = vi.fn()
    const plugin = defineDecisionProviderPlugin({ id: 'one', routes: ['a'], setup(registrar) { registrar.registerAdapter(['a'], new FakeAdapter()); return cleanup } })
    const bad = defineDecisionProviderPlugin({ id: 'two', routes: ['b'], setup(registrar) { registrar.registerAdapter(['escape'], new FakeAdapter()) } })
    expect(() => createDecisionRuntime({ providers: [plugin, bad] })).toThrow('escapes')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
  it('rejects lossy JSON, cycles, getters and empty question sets', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const state of [NaN, undefined, new Date(), cycle, { get text() { throw new Error('must not execute') } }]) {
      expect(() => snapshotDecisionInput({ state: state as unknown as string, questions })).toThrow()
    }
    expect(() => snapshotDecisionInput({ state: '', questions: {} })).toThrow('count')
  })
  it.each([
    { route: { type: 'choice', choice: 'invented' } },
    { route: { type: 'score', score: 0 } },
    {},
    { route: { type: 'choice', choice: 'billing', confidence: 0.8 } },
    { route: { type: 'choice', choice: 'billing', probabilitySource: 'provider', probabilities: { billing: 0.2, support: 0.2 } } },
    { route: { type: 'choice', choice: 'billing', probabilitySource: 'provider', probabilities: { billing: 0.2, support: 0.8 } } },
  ])('rejects malformed result %#', answers => {
    expect(() => validateDecisionResult({ model: 'm', answers }, questions)).toThrow()
  })
  it('preserves fractional rubric scores and boolean probability', () => {
    const q = { quality: scoreQuestion('Quality?', ['bad', 'good']), relevant: booleanQuestion('Relevant?') }
    const value = validateDecisionResult({ model: 'm', answers: { quality: { type: 'score', score: 0.7, probabilities: { '0': 0.3, '1': 0.7 }, probabilitySource: 'provider' }, relevant: { type: 'boolean', value: true, probabilityTrue: 0.8, probabilitySource: 'provider' } } }, q)
    expect(value.answers.quality.score).toBe(0.7)
    expect(value.answers.relevant.probabilityTrue).toBe(0.8)
  })
  it('rejects invalid metadata and unsupported capabilities before dispatch', async () => {
    const adapter = new FakeAdapter()
    const resolve = vi.spyOn(adapter, 'resolveModel')
    resolve.mockResolvedValue({ provider: 'p', id: 'm', name: 'm', capabilities: { maxChoiceOptions: NaN } })
    const runtime = createDecisionRuntime()
    runtime.registerAdapter(['p'], adapter)
    const handle = runtime.decisionModel({ provider: 'p', model: 'm' })
    await expect(handle.evaluate(input)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    resolve.mockResolvedValue({ provider: 'p', id: 'm', name: 'm', capabilities: { questionTypes: ['boolean'] } })
    await expect(handle.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(adapter.call).not.toHaveBeenCalled()
    await runtime.close()
  })
})
