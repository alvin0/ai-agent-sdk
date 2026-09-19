/**
 * Reasoning effort pass-through against the real Gemini Interactions endpoint.
 *
 * Excluded from `npm test` — collected only by `vitest.integration.config.ts`.
 * Run with `npm run test:integration`, or just this file. Needs `GEMINI_KEY`
 * (and optionally `GEMINI_MODEL`, defaulting to a small, cheap model); with
 * neither set, both describes SKIP rather than fail — see
 * `tests/integration/document-input.spec.ts` for the established pattern this
 * file follows (same env vars, same guard shape).
 *
 * This is part of the redesign plan's Phase 5 acceptance matrix
 * (docs/plans/reasoning-effort-provider-redesign.md): "agent không đặt effort
 * → gọi thành công, không có field effort" and "agent đặt effort sai → lỗi
 * hiện message gốc của API" both need a REAL response, because a mock only
 * proves the SDK sends what it was told to send — never that a real Gemini
 * account accepts or rejects it the way the SDK's error passthrough assumes.
 */

import { describe, expect, it } from 'vitest'
import { ModelRegistry, ReasoningEffortId, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { geminiAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'

const geminiKey = process.env.GEMINI_KEY
const geminiModel = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite'

function registryFor(): ModelRegistry {
  const registry = new ModelRegistry()
  registry.registerAdapter(['gemini'], geminiAdapter({
    apiKey: geminiKey as string,
    models: [{ id: geminiModel }],
  }))
  return registry
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe.skipIf(geminiKey === undefined)('gemini reasoning effort (live)', () => {
  it('generates with no effort set at all — no effort field reaches the wire, call still succeeds', async () => {
    const chunks = await drain(registryFor().stream({
      provider: 'gemini', model: geminiModel,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      signal: AbortSignal.timeout(30_000),
    }))
    const finish = chunks.at(-1) as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('stop')
  }, 60_000)

  it('generates with a plausible effort value — the SDK forwards it verbatim and the call succeeds', async () => {
    const chunks = await drain(registryFor().stream({
      provider: 'gemini', model: geminiModel,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      reasoningEffort: ReasoningEffortId('low'),
      signal: AbortSignal.timeout(30_000),
    }))
    const finish = chunks.at(-1) as { type: string; reason: { kind: string } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('stop')
  }, 60_000)

  it('surfaces the API\'s own rejection message for an effort value it does not recognize', async () => {
    // A dispatch rejection over `registry.stream()`'s async iterable arrives as
    // a `finish` chunk with `reason.kind: 'error'`, not a rejected promise —
    // confirmed live rather than assumed.
    const chunks = await drain(registryFor().stream({
      provider: 'gemini', model: geminiModel,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      reasoningEffort: ReasoningEffortId('not-a-real-effort-value'),
      signal: AbortSignal.timeout(30_000),
    }))
    const finish = chunks.at(-1) as { type: string; reason: { kind: string; failure?: { message: string } } }
    expect(finish.type).toBe('finish')
    expect(finish.reason.kind).toBe('error')
    // Decision 7 (redesign plan): the SDK does not clean up or replace the
    // provider's own rejection text — this is Gemini's real 400 body, verbatim.
    expect(finish.reason.failure?.message).toContain('not-a-real-effort-value')
    expect(finish.reason.failure?.message).toContain('thinking_level')
  }, 60_000)
})
