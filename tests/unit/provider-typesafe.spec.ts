import { describe, expect, it, vi } from 'vitest'
import { defineCredentialSource, type EndProviderAttemptInput, type ModelInvocationContext } from '@alvin0/ai-agent-sdk-core/provider'
import { booleanQuestion, choiceQuestion, createDecisionRuntime, scoreQuestion } from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafeAdapter, typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'

const input = { state: { message: 'Refund urgently please' }, questions: {
  route: choiceQuestion('Choose department', { billing: 'Refunds', support: 'Bugs' }),
  urgency: scoreQuestion('Urgency?', ['low', 'high']), urgent: booleanQuestion('Is urgent?', { true: 'time sensitive', false: 'routine' }),
} }
function payload() { return { model: 'jev-1.13.0', answers: { route: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.8 }, urgency: { type: 'score', score: 0.9, legend: { '0': 'low', '1': 'high' }, probabilities: { '0': 0.1, '1': 0.9 }, confidence: 0.8 }, urgent: { type: 'noul', noul: 0.95 } }, usage: { input_tokens: 123, output_tokens: 17 } } }
const request = () => ({ ...input, provider: 'typesafe', model: 'jev-latest' })
function transport(value: unknown = payload()) { return vi.fn<typeof fetch>(async () => Response.json(value, { headers: { 'x-request-id': 'req-test' } })) }
describe('TypeSafe decision provider', () => {
  it('maps all primitives, preserves evidence and reports physical attempts', async () => {
    const fetch = transport()
    const ended: EndProviderAttemptInput[] = []
    const start = vi.fn(async () => ({ attemptId: 'attempt', attemptNumber: 1, traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', end(value: EndProviderAttemptInput) { ended.push(value); return {} } }))
    const context = { startProviderAttempt: start } as unknown as ModelInvocationContext
    const result = await typesafeAdapter({ apiKey: 'test-key', fetch }).evaluate(request(), context)
    expect(fetch.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/systemone')
    const init = fetch.mock.calls[0]![1]!
    expect(init.redirect).toBe('error')
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer test-key')
    expect(headers.get('traceparent')).toContain('0123456789abcdef')
    const body = JSON.parse(init.body as string) as { questions: Record<string, { type: string; criteria: unknown }> }
    expect(body.questions.route!.criteria).toEqual(input.questions.route.options)
    expect(body.questions.urgency!.criteria).toEqual(['low', 'high'])
    expect(body.questions.urgent!.type).toBe('noul')
    expect(result).toMatchObject({ model: 'jev-1.13.0', usage: { inputTokens: 123, outputTokens: 17 }, providerRequestId: 'req-test', answers: { urgent: { value: true, probabilityTrue: 0.95, probabilitySource: 'provider' } } })
    expect(result.answers.urgent!.confidence).toBeUndefined()
    expect(start).toHaveBeenCalledTimes(1)
    expect(ended).toEqual([expect.objectContaining({ status: 'success', dispatchState: 'sent', reported: { inputTokens: 123, outputTokens: 17 } })])
  })
  it('works through the decision plugin with custom route and an unlisted model', async () => {
    const runtime = createDecisionRuntime({ providers: [typesafePlugin({ apiKey: 'test', routes: ['proxy'], fetch: transport() })] })
    await expect(runtime.decisionModel({ provider: 'proxy', model: 'jev-new' }).evaluate(input)).resolves.toHaveProperty('model', 'jev-1.13.0')
    await runtime.close()
  })
  it('resolves credentials lazily once per attempt without reading env in the universal provider', async () => {
    const resolve = vi.fn(async () => 'dynamic-key')
    const adapter = typesafeAdapter({ apiKey: defineCredentialSource({ id: 'test', resolve }), fetch: transport() })
    expect(resolve).not.toHaveBeenCalled()
    await adapter.evaluate(request())
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it.each([[401, 'AUTH'], [422, 'INVALID_REQUEST'], [429, 'RATE_LIMIT'], [529, 'SERVER']] as const)('maps HTTP %i safely', async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('raw-sensitive-body', { status, headers: { 'retry-after': '2', 'x-request-id': 'r1' } }))
    await expect(typesafeAdapter({ apiKey: 'test', fetch }).evaluate(request())).rejects.toMatchObject({ code, failure: { status, providerRetryAfterMs: 2_000 } })
  })
  it('runtime retries overload but adapter itself performs exactly one request', async () => {
    const fetch = transport()
    fetch.mockResolvedValueOnce(new Response('', { status: 529 }))
    const runtime = createDecisionRuntime({ providers: [typesafePlugin({ apiKey: 'test', fetch, retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1 } } })] })
    await runtime.decisionModel({ provider: 'typesafe', model: 'jev-latest' }).evaluate(input)
    expect(fetch).toHaveBeenCalledTimes(2)
    await runtime.close()
  })
  it.each(['missing', 'extra', 'type', 'probabilities', 'confidence', 'usage', 'legend'])('rejects malformed %s', async kind => {
    const raw: Record<string, unknown> = payload()
    const answers = raw.answers as Record<string, Record<string, unknown>>
    if (kind === 'missing') delete answers.urgent
    if (kind === 'extra') answers.surplus = { type: 'noul', noul: 0.2 }
    if (kind === 'type') answers.urgent!.type = 'choice'
    if (kind === 'probabilities') answers.route!.probabilities = { billing: 1.5, support: -0.5 }
    if (kind === 'confidence') answers.route!.confidence = NaN
    if (kind === 'usage') raw.usage = { input_tokens: -1 }
    if (kind === 'legend') answers.urgency!.legend = { '0': 'low' }
    await expect(typesafeAdapter({ apiKey: 'test', fetch: transport(raw) }).evaluate(request())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('rejects excessive rubric/options and request bytes before network IO', async () => {
    const fetch = transport()
    const adapter = typesafeAdapter({ apiKey: 'test', fetch })
    await expect(adapter.evaluate({ ...request(), questions: { score: scoreQuestion('Rate', Array.from({ length: 11 }, () => 'level')) } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(typesafeAdapter({ apiKey: 'test', fetch, maxRequestBytes: 8 }).evaluate(request())).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects invalid JSON and UTF-8 as protocol errors, never transport retries', async () => {
    for (const body of ['{broken', new Uint8Array([0xc3, 0x28])]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body))
      await expect(typesafeAdapter({ apiKey: 'test', fetch }).evaluate(request())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })
  it('does not dispatch when the observation audit rejects the attempt', async () => {
    const fetch = transport()
    const runtime = createDecisionRuntime({ providers: [typesafePlugin({ apiKey: 'test', fetch })] })
    const context: ModelInvocationContext = { startProviderAttempt: async () => { throw new Error('audit rejected') } }
    await expect(runtime.decisionModel({ provider: 'typesafe', model: 'jev-latest' }).evaluate(input, context)).rejects.toThrow('audit rejected')
    expect(fetch).not.toHaveBeenCalled()
    await runtime.close()
  })
  it('maps fetch failures to a safe transient transport error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('sensitive upstream detail') })
    await expect(typesafeAdapter({ apiKey: 'test', fetch }).evaluate(request())).rejects.toMatchObject({ code: 'TRANSPORT', message: 'TypeSafe transport failed' })
  })
  it('bounds a stalled response body and a stalled credential source', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start() {} })))
    await expect(typesafeAdapter({ apiKey: 'test', fetch, requestTimeoutMs: 10 }).evaluate(request())).rejects.toMatchObject({ code: 'TIMEOUT' })
    const dispatch = transport()
    const credential = defineCredentialSource({ id: 'stalled', resolve: () => new Promise<string>(() => {}) })
    await expect(typesafeAdapter({ apiKey: credential, fetch: dispatch, requestTimeoutMs: 10 }).evaluate(request())).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('limits streamed response bytes even without content-length', async () => {
    await expect(typesafeAdapter({ apiKey: 'test', fetch: transport(), maxResponseBytes: 8 }).evaluate(request())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('times out a fetch that ignores cancellation and never dispatches after a pre-abort', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    const adapter = typesafeAdapter({ apiKey: 'test', fetch, requestTimeoutMs: 10 })
    await expect(adapter.evaluate(request())).rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController(); controller.abort()
    await expect(adapter.evaluate({ ...request(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('lists models using the authenticated catalog endpoint', async () => {
    const fetch = transport({ models: [{ name: 'jev-latest', description: 'Jev', release_date: '2026-09-15' }] })
    expect(await typesafeAdapter({ apiKey: 'test', fetch }).listModels('typesafe')).toEqual([expect.objectContaining({ id: 'jev-latest', provider: 'typesafe' })])
    expect(fetch.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/models')
  })
  it('rejects unsafe roots, blank credentials and transport-header overrides', () => {
    expect(() => typesafeAdapter({ apiKey: ' ' })).toThrow('blank')
    expect(() => typesafeAdapter({ apiKey: 'test', baseUrl: 'http://example.com' })).toThrow('HTTPS')
    expect(() => typesafeAdapter({ apiKey: 'test', baseUrl: 'https://user:secret@example.com' })).toThrow('HTTPS')
    expect(() => typesafeAdapter({ apiKey: 'test', headers: { Authorization: 'override' } })).toThrow('override')
  })
})
