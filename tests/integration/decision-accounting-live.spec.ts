/** Paid TypeSafe checks; injected faults are simulations after/before real HTTP. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ModelError } from '@alvin0/ai-agent-sdk-core'
import { createDecisionRuntime, choiceQuestion, scoreQuestion } from '@alvin0/ai-agent-sdk-decision-adapter'
import { typesafeAdapter, typesafePlugin } from '@alvin0/ai-agent-sdk-provider-typesafe'
import type { EndProviderAttemptInput, ModelInvocationContext } from '@alvin0/ai-agent-sdk-core/provider'

const apiKey = process.env.TYPESAFE_API_KEY
const model = process.env.TYPESAFE_MODEL ?? 'jev-latest'
const input = { state: 'Please refund the duplicate charge on my invoice.', questions: {
  route: choiceQuestion('Which team handles this request?', { billing: 'Invoices and refunds', support: 'Technical bugs' }),
} }
const evidence: { name: string; model: string; usage: unknown; fault: string }[] = []
function accounting(ended: EndProviderAttemptInput[]): ModelInvocationContext {
  return { startProviderAttempt: async () => ({
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    end(value: EndProviderAttemptInput) { ended.push(value) },
  }) } as unknown as ModelInvocationContext
}
afterAll(() => {
  if (!evidence.length) return
  const directory = resolve('.temp/decision-accounting-live')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify({ cases: evidence }, null, 2) + '\n')
})

describe.skipIf(!apiKey)('decision accounting through real TypeSafe HTTP', () => {
  it('does not repeat a billed request when the terminal audit sink rejects it', async () => {
    const ended: EndProviderAttemptInput[] = []
    const failure = new ModelError('Synthetic terminal audit rejection', 'OBSERVABILITY_AUDIT_UNAVAILABLE')
    let calls = 0, actualModel = ''
    const runtime = createDecisionRuntime({ timeoutMs: 60_000, retryPolicy: { mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, providers: [typesafePlugin({ apiKey: apiKey!, requestTimeoutMs: 60_000, fetch: async (url, init) => {
      calls++
      const response = await globalThis.fetch(url, init)
      expect(response.ok).toBe(true)
      const raw = await response.clone().json() as { model: string }
      actualModel = raw.model
      return response
    } })] })
    const context = { startProviderAttempt: async () => ({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', end(value: EndProviderAttemptInput) { ended.push(value); throw failure } }) } as unknown as ModelInvocationContext
    try {
      await expect(runtime.decisionModel({ provider: 'typesafe', model }).evaluate(input, context)).rejects.toBe(failure)
      expect(calls).toBe(1)
      expect(ended).toHaveLength(1)
      expect(ended[0]).toMatchObject({ status: 'success', dispatchState: 'sent', usageFinal: true })
      expect(ended[0]!.reported?.inputTokens).toBeGreaterThan(0)
      evidence.push({ name: 'terminal-audit-rejection-after-real-billing', model: actualModel, usage: ended[0]!.reported, fault: 'injected audit sink rejection after real reply; one attempt and one closure' })
    } finally { await runtime.close() }
  })
  it('accepts real structured score legends and rejects an injected reversal with billed usage', async () => {
    const levels = [{ description: 'Routine; no deadline', priority: 0 }, { description: 'Urgent; help required today', priority: 1 }]
    const request = { state: 'Please urgently refund my duplicate invoice charge today.', provider: 'typesafe', model, questions: { urgency: scoreQuestion('How urgent?', levels) } }
    let captured!: { model: string; answers: { urgency: { legend: Record<string, unknown> } }; usage: { input_tokens: number; output_tokens: number } }
    const live = typesafeAdapter({ apiKey: apiKey!, requestTimeoutMs: 60_000, fetch: async (url, init) => {
      expect(new Headers(init?.headers).get('x-sdk-decision-audit')).toBe('structured-score')
      const response = await globalThis.fetch(url, init)
      expect(response.ok).toBe(true)
      captured = await response.json() as typeof captured
      return Response.json(captured, { headers: response.headers })
    } })
    const result = await live.evaluate(request, { providerOptions: { headers: { 'x-sdk-decision-audit': 'structured-score' } } })
    expect(result.answers.urgency!.type).toBe('score')
    expect(captured.answers.urgency.legend).toEqual({ '0': levels[0], '1': levels[1] })
    expect(result.usage?.inputTokens).toBeGreaterThan(0)
    captured.answers.urgency.legend = { '0': levels[1], '1': levels[0] }
    const ended: EndProviderAttemptInput[] = []
    const altered = typesafeAdapter({ apiKey: apiKey!, fetch: async () => Response.json(captured) })
    await expect(altered.evaluate(request, accounting(ended))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    expect(ended[0]).toMatchObject({ status: 'error', reported: result.usage, usageFinal: true })
    evidence.push({ name: 'structured-score-legend-and-invocation-header', model: result.model, usage: result.usage, fault: 'reused real reply with reversed legend; no second upstream charge' })
  })
  it('retains actual billed usage after an injected invalid choice', async () => {
    const ended: EndProviderAttemptInput[] = []
    const adapter = typesafeAdapter({ apiKey: apiKey!, requestTimeoutMs: 60_000,
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init)
        expect(response.ok).toBe(true)
        const raw = await response.json() as { model: string; answers: { route: { choice: string } }; usage: { input_tokens: number; output_tokens: number } }
        expect(raw.usage.input_tokens).toBeGreaterThan(0)
        evidence.push({ name: 'malformed-answer-billed-usage', model: raw.model, usage: raw.usage, fault: 'injected unknown choice after real response' })
        raw.answers.route.choice = 'unknown-injected-choice'
        return Response.json(raw, { headers: response.headers })
      },
    })
    await expect(adapter.evaluate({ ...input, provider: 'typesafe', model }, accounting(ended))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
    const actual = evidence.at(-1)!.usage as { input_tokens: number; output_tokens: number }
    expect(ended).toEqual([expect.objectContaining({ status: 'error', dispatchState: 'sent', usageFinal: true,
      reported: { inputTokens: actual.input_tokens, outputTokens: actual.output_tokens },
    })])
  })

  it('retries an injected overload using the same request and records actual success usage', async () => {
    const ended: EndProviderAttemptInput[] = []
    const bodies: string[] = []
    let retries = 0
    const runtime = createDecisionRuntime({ timeoutMs: 60_000, providers: [typesafePlugin({
      apiKey: apiKey!, requestTimeoutMs: 60_000,
      retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
      fetch: async (url, init) => {
        bodies.push(String(init?.body))
        if (bodies.length === 1) return new Response('', { status: 529 })
        return globalThis.fetch(url, init)
      },
    })] })
    try {
      const result = await runtime.decisionModel({ provider: 'typesafe', model }).evaluate(input, {
        ...accounting(ended), recordProviderRetry() { retries++ },
      })
      expect(result.answers.route.choice).toBe('billing')
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toBe(bodies[1])
      expect(retries).toBe(1)
      expect(ended).toEqual([
        expect.objectContaining({ status: 'error', httpStatus: 529 }),
        expect.objectContaining({ status: 'success', reported: result.usage, usageFinal: true }),
      ])
      evidence.push({ name: 'retry-to-real-success', model: result.model, usage: result.usage, fault: 'injected HTTP 529 before real retry' })
    } finally { await runtime.close() }
  })
})
