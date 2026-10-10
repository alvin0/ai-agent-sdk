import { describe, expect, it, vi } from 'vitest'
import { defineCredentialSource, type EndProviderAttemptInput, type ModelInvocationContext }
  from '@alvin0/ai-agent-sdk-core/provider'
import { booleanQuestion, choiceQuestion, createDecisionRuntime, scoreQuestion }
  from '@alvin0/ai-agent-sdk-decision-adapter'
import { OPENAI_DECISION_REFUSED, openAiDecisionAdapter, openAiDecisionPlugin }
  from '@alvin0/ai-agent-sdk-provider-openai/decisions'

const input = { state: { message: 'Refund urgently please' }, questions: {
  route: choiceQuestion('Choose department', { billing: 'Refunds', support: null }),
  urgency: scoreQuestion('Urgency?', ['low', { priority: 'high' }]),
  urgent: booleanQuestion('Is urgent?', { true: 'time sensitive', false: 'routine' }),
} }
const request = () => ({ ...input, provider: 'openai', model: 'gpt-6-luna' })
function payload(): Record<string, unknown> {
  return { model: 'gpt-6-luna', answers: [
    { type: 'choice', name: 'route', choice: 'billing', confidence: 0.8,
      probabilities: [{ value: 'billing', probability: 0.9 }, { value: 'support', probability: 0.1 }] },
    { type: 'score', name: 'urgency', score: 0.9, confidence: 0.8,
      probabilities: [{ value: 0, label: '0', probability: 0.1 }, { value: 1, label: '1', probability: 0.9 }] },
    { type: 'predicate', name: 'urgent', probability: 0.95 },
  ], usage: { input_tokens: 123, output_tokens: 0, total_tokens: 123,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 0 }, compute_units: 1 } }
}
function transport(value: unknown = payload()) {
  return vi.fn<typeof fetch>(async () => Response.json(value, { headers: { 'x-request-id': 'req-decisions' } }))
}
function accounting() {
  const ended: EndProviderAttemptInput[] = []
  const start = vi.fn(async () => ({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    end(value: EndProviderAttemptInput) { ended.push(value) } }))
  return { ended, start, context: { startProviderAttempt: start } as unknown as ModelInvocationContext }
}
describe('native OpenAI Decisions', () => {
  it('sends the native contract and preserves probabilities, zero output and attempt accounting', async () => {
    const fetch = transport(), audit = accounting()
    const result = await openAiDecisionAdapter({ apiKey: 'test-key', fetch, safetyIdentifier: 'tenant' })
      .evaluate(request(), audit.context)
    expect(fetch.mock.calls[0]![0]).toBe('https://api.openai.com/v1/decisions')
    const init = fetch.mock.calls[0]![1]!
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key')
    expect(new Headers(init.headers).get('traceparent')).toContain('0123456789abcdef')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'gpt-6-luna', input: JSON.stringify(input.state),
      safety_identifier: 'tenant', questions: [
        { type: 'choice', name: 'route', instructions: 'Choose department',
          choices: [{ value: 'billing', description: 'Refunds' }, { value: 'support' }] },
        { type: 'score', name: 'urgency', instructions: 'Urgency?',
          levels: [{ label: '0', description: 'low' }, { label: '1', description: '{"priority":"high"}' }] },
        { type: 'predicate', name: 'urgent', instructions:
          'Is urgent?\n\nBoolean criteria (true and false):\n{"true":"time sensitive","false":"routine"}' },
      ] })
    expect(result).toMatchObject({ providerRequestId: 'req-decisions', usage: {
      inputTokens: 100, outputTokens: 0, totalTokens: 123, cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 0,
    }, answers: { route: { choice: 'billing', probabilities: { billing: 0.9, support: 0.1 }, probabilitySource: 'provider' },
      urgency: { score: 0.9, probabilities: { '0': 0.1, '1': 0.9 } },
      urgent: { value: true, probabilityTrue: 0.95, probabilitySource: 'provider' } } })
    expect(audit.ended).toEqual([expect.objectContaining({ status: 'success', dispatchState: 'sent',
      reported: result.usage, usageFinal: true })])
  })
  it.each([0, 0.49, 0.5, 1])('maps predicate probability %s with an explicit 0.5 threshold', async probability => {
    const fetch = transport({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'ok', probability }] })
    const result = await openAiDecisionAdapter({ apiKey: 'test', fetch }).evaluate({ ...request(), state: 'hello',
      questions: { ok: booleanQuestion('OK?') } })
    expect(result.answers.ok).toEqual({ type: 'boolean', value: probability >= 0.5, probabilityTrue: probability,
      probabilitySource: 'provider' })
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).input).toBe('hello')
    expect(result.usage).toBeUndefined()
  })
  it('propagates refusal without inventing an answer or retrying, retaining billed usage', async () => {
    const raw = payload(), audit = accounting()
    raw.answers = [{ type: 'refusal', name: 'route' }, ...(raw.answers as unknown[]).slice(1)]
    const fetch = transport(raw)
    const runtime = createDecisionRuntime({ providers: [openAiDecisionPlugin({ apiKey: 'test', fetch,
      retryPolicy: { mode: 'normal', maxRetries: 2 } })] })
    try {
      await expect(runtime.decisionModel({ provider: 'openai', model: 'gpt-6-luna' }).evaluate(input, audit.context))
        .rejects.toMatchObject({ code: OPENAI_DECISION_REFUSED })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(audit.ended[0]).toMatchObject({ status: 'error', reported: { inputTokens: 100, outputTokens: 0 },
        usageFinal: true })
    } finally { await runtime.close() }
  })
  it.each(['missing', 'extra', 'name', 'order', 'type', 'duplicate', 'choice-value', 'score-label',
    'score-index', 'score-mean', 'predicate', 'confidence', 'distribution', 'usage'])
    ('rejects malformed %s without repairing provider output', async kind => {
      const raw = payload(), answers = raw.answers as Record<string, unknown>[]
      const choices = answers[0]!.probabilities as Record<string, unknown>[]
      const scores = answers[1]!.probabilities as Record<string, unknown>[]
      if (kind === 'missing') answers.pop()
      if (kind === 'extra') answers.push(answers[0]!)
      if (kind === 'name') answers[0]!.name = 'unknown'
      if (kind === 'order') answers.reverse()
      if (kind === 'type') answers[2]!.type = 'boolean'
      if (kind === 'duplicate') choices[1]!.value = 'billing'
      if (kind === 'choice-value') choices[0]!.value = true
      if (kind === 'score-label') scores[0]!.label = 'unexpected'
      if (kind === 'score-index') scores[0]!.value = '0'
      if (kind === 'score-mean') answers[1]!.score = 0.3
      if (kind === 'predicate') answers[2]!.probability = 1.5
      if (kind === 'confidence') answers[0]!.confidence = -1
      if (kind === 'distribution') choices[0]!.probability = 0.2
      if (kind === 'usage') raw.usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 2 } }
      const audit = accounting()
      await expect(openAiDecisionAdapter({ apiKey: 'test', fetch: transport(raw) }).evaluate(request(), audit.context))
        .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
      if (kind !== 'usage') expect(audit.ended[0]).toMatchObject({ status: 'error', usageFinal: true,
        reported: { inputTokens: 100, outputTokens: 0 } })
    })
  it('freezes evidence and headers before credential resolution and resolves each retry independently', async () => {
    const mutable = { state: { text: 'original' }, questions: { ok: booleanQuestion('OK?') } }
    const headers = { 'x-tenant': 'original' }, bodies: string[] = [], received: string[] = []
    const resolve = vi.fn(async () => 'rotated')
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(init!.body as string); received.push(new Headers(init!.headers).get('x-tenant')!)
      mutable.state.text = 'changed'; headers['x-tenant'] = 'changed'
      if (bodies.length === 1) return new Response('PRIVATE', { status: 503 })
      return Response.json({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'ok', probability: 0.9 }] })
    })
    const runtime = createDecisionRuntime({ providers: [openAiDecisionPlugin({
      apiKey: defineCredentialSource({ id: 'key', resolve }), fetch,
      retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    })] })
    try {
      await runtime.decisionModel({ provider: 'openai', model: 'gpt-6-luna' }).evaluate(mutable,
        { providerOptions: { headers } })
      expect(bodies[0]).toBe(bodies[1]); expect(received).toEqual(['original', 'original'])
      expect(resolve).toHaveBeenCalledTimes(2)
    } finally { await runtime.close() }
  })
  it.each([[401, 'AUTH'], [402, 'INVALID_REQUEST'], [429, 'RATE_LIMIT'], [503, 'SERVER']] as const)
    ('classifies HTTP %i without including response bodies or credentials', async (status, code) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('PRIVATE', { status,
        headers: { 'retry-after': '2', 'x-request-id': 'req-http' } }))
      await expect(openAiDecisionAdapter({ apiKey: 'SECRET', fetch }).evaluate(request())).rejects.toMatchObject({
        code, failure: { status, providerRetryAfterMs: 2_000, requestId: 'req-http' },
      })
    })
  it('bounds stalled credentials, stalled fetch and streamed bodies, and honours pre-abort', async () => {
    const fetch = transport(), source = defineCredentialSource({ id: 'stalled', resolve: () => new Promise(() => {}) })
    await expect(openAiDecisionAdapter({ apiKey: source, fetch, requestTimeoutMs: 10 }).evaluate(request()))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(fetch).not.toHaveBeenCalled()
    const stalled = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    await expect(openAiDecisionAdapter({ apiKey: 'test', fetch: stalled, requestTimeoutMs: 10 }).evaluate(request()))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
    const controller = new AbortController(); controller.abort()
    await expect(openAiDecisionAdapter({ apiKey: 'test', fetch }).evaluate({ ...request(), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(openAiDecisionAdapter({ apiKey: 'test', fetch, maxResponseBytes: 8 }).evaluate(request()))
      .rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    const body = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ start() {} })))
    await expect(openAiDecisionAdapter({ apiKey: 'test', fetch: body, requestTimeoutMs: 10 }).evaluate(request()))
      .rejects.toMatchObject({ code: 'TIMEOUT' })
  })
  it('rejects body/header overrides and oversized input before credentials or dispatch', async () => {
    const resolve = vi.fn(async () => 'test'), fetch = transport()
    const adapter = openAiDecisionAdapter({ apiKey: defineCredentialSource({ id: 'key', resolve }), fetch })
    for (const providerOptions of [{ body: { input: 'changed' } }, { headers: { authorization: 'changed' } },
      { headers: { 'x-tenant': 'PRIVATE\nVALUE' } }]) {
      await expect(adapter.evaluate(request(), { providerOptions })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
    await expect(openAiDecisionAdapter({ apiKey: 'test', fetch, maxRequestBytes: 8 }).evaluate(request()))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(resolve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('supports an explicit proxy root and route without discovering generation models', async () => {
    const fetch = transport(), runtime = createDecisionRuntime({ providers: [openAiDecisionPlugin({
      apiKey: 'test', fetch, baseUrl: 'https://proxy.example/v1/', routes: ['proxy'],
    })] })
    try {
      await runtime.decisionModel({ provider: 'proxy', model: 'gpt-6-luna' }).evaluate(input)
      expect(fetch.mock.calls[0]![0]).toBe('https://proxy.example/v1/decisions')
      expect(await openAiDecisionAdapter({ apiKey: 'test' }).listModels('openai')).toEqual([
        expect.objectContaining({ provider: 'openai', id: 'gpt-6-luna' }),
      ])
    } finally { await runtime.close() }
  })
  it('rejects unsafe roots, blank keys and invalid transport budgets', () => {
    expect(() => openAiDecisionAdapter({ apiKey: ' ' })).toThrow('blank')
    expect(() => openAiDecisionAdapter({ apiKey: 'test', baseUrl: 'http://example.com' })).toThrow('HTTPS')
    expect(() => openAiDecisionAdapter({ apiKey: 'test', baseUrl: 'https://user:secret@example.com' })).toThrow('HTTPS')
    expect(() => openAiDecisionAdapter({ apiKey: 'test', requestTimeoutMs: 0 })).toThrow('requestTimeoutMs')
    expect(() => openAiDecisionAdapter({ apiKey: 'test', safetyIdentifier: 'x'.repeat(129) })).toThrow('safetyIdentifier')
  })
})
