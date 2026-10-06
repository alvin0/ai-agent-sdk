/** Paid TypeSafe checks; injected faults are simulations after/before real HTTP. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createDecisionRuntime, choiceQuestion } from '@alvin0/ai-agent-sdk-decision-adapter'
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
