/**
 * Reasoning effort pass-through against the real, official OpenAI endpoint —
 * both Responses (default) and Chat Completions (`api: 'chat-completions'`).
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Needs
 * `OPENAI_API_KEY` (and `OPENAI_MODEL`, defaulting to `gpt-5.6-luna` — the
 * account behind this key is scoped to that one model); with either
 * missing, both describes SKIP rather than fail — same pattern as
 * `gemini-reasoning-effort-live.spec.ts`.
 *
 * This is part of the redesign plan's Phase 5 acceptance matrix
 * (docs/plans/reasoning-effort-provider-redesign.md): zenmux.ai already
 * proved the wire shapes work end to end, but only the OFFICIAL vendor can
 * confirm this SDK's request reaches production OpenAI and that a real
 * account accepts or rejects reasoning effort the way the SDK's error
 * passthrough assumes.
 */

import { describe, expect, it } from 'vitest'
import { ModelRegistry, ReasoningEffortId, createMessage, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_MODEL ?? 'gpt-5.6-luna'
// A 1x1 transparent PNG — the cheapest possible real image payload.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function registryFor(api?: 'chat-completions'): ModelRegistry {
  const registry = new ModelRegistry()
  registry.registerAdapter(['openai'], openAiAdapter({
    apiKey: apiKey as string,
    ...(api === undefined ? {} : { api }),
    models: [{ id: model }],
  }))
  return registry
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function lastFinish(chunks: unknown[]): { type: string; reason: { kind: string; failure?: { message: string } } } {
  return chunks.at(-1) as { type: string; reason: { kind: string; failure?: { message: string } } }
}

describe.skipIf(apiKey === undefined)('OpenAI Responses wire (live, official)', () => {
  it('generates with no effort set at all — no effort field reaches the wire, call still succeeds', async () => {
    const chunks = await drain(registryFor().stream({
      provider: 'openai', model,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      signal: AbortSignal.timeout(30_000),
    }))
    expect(lastFinish(chunks).reason.kind).toBe('stop')
  }, 60_000)

  it('generates with a plausible effort value — the SDK forwards it verbatim and the call succeeds', async () => {
    const chunks = await drain(registryFor().stream({
      provider: 'openai', model,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      reasoningEffort: ReasoningEffortId('low'),
      signal: AbortSignal.timeout(30_000),
    }))
    expect(lastFinish(chunks).reason.kind).toBe('stop')
  }, 60_000)

  it('surfaces the API\'s own rejection message for an effort value it does not recognize', async () => {
    const chunks = await drain(registryFor().stream({
      provider: 'openai', model,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      reasoningEffort: ReasoningEffortId('not-a-real-effort-value'),
      signal: AbortSignal.timeout(30_000),
    }))
    const finish = lastFinish(chunks)
    expect(finish.reason.kind).toBe('error')
    // Decision 7 (redesign plan): the SDK does not clean up or replace the
    // provider's own rejection text — this is OpenAI's real 400 body, verbatim.
    expect(finish.reason.failure?.message).toContain('not-a-real-effort-value')
    expect(finish.reason.failure?.message).toContain('Supported values')
  }, 60_000)

  it('accepts an image with the default inputModalities, no override needed', async () => {
    const message = createMessage({
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: TINY_PNG_BASE64 } },
        { type: 'text', text: 'Reply with exactly one word: hello' },
      ],
    })
    const chunks = await drain(registryFor().stream({
      provider: 'openai', model,
      messages: [message],
      signal: AbortSignal.timeout(30_000),
    }))
    expect(lastFinish(chunks).reason.kind).toBe('stop')
  }, 60_000)
})

describe.skipIf(apiKey === undefined)('OpenAI Chat Completions wire (live, official)', () => {
  it('dispatches a real request and parses the real streamed response back into text', async () => {
    const chunks = await drain(registryFor('chat-completions').stream({
      provider: 'openai', model,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      reasoningEffort: ReasoningEffortId('low'),
      signal: AbortSignal.timeout(30_000),
    }))
    expect(lastFinish(chunks).reason.kind).toBe('stop')
  }, 60_000)
})
