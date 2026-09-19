/**
 * The codex2claudecode gateway's own acceptance checklist
 * (docs/plans/reasoning-effort-provider-redesign.md, "Kiểm tra riêng cho
 * codex2claudecode"): one gateway speaking all three wire families
 * (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`) for the same
 * underlying model.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Needs the
 * gateway already running locally (`CODEX2CLAUDECODE_URL`, default
 * `http://127.0.0.1:8787`); probed once at import time via `GET /health`,
 * and the whole file SKIPs rather than fails if it is not reachable — same
 * spirit as the other live specs in this directory, just probed instead of
 * env-var-gated since there is no API key to check for.
 */

import { describe, expect, it } from 'vitest'
import { ModelRegistry, ReasoningEffortId, createMessage, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const GATEWAY = process.env.CODEX2CLAUDECODE_URL ?? 'http://127.0.0.1:8787'
const MODEL = 'gpt-5.6-luna'
// Any value works: the running gateway reports `password_protected: false`.
const ANY_PASSWORD = 'unit-test-password'
// A 1x1 transparent PNG — the cheapest possible real image payload.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const gatewayReachable = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(2_000) })
  .then(response => response.ok, () => false)

function registryWith(kind: 'anthropic' | 'responses' | 'chat-completions', password: string): ModelRegistry {
  const registry = new ModelRegistry()
  if (kind === 'anthropic') {
    registry.registerAdapter(['gateway'], anthropicAdapter({
      apiKey: password, baseUrl: GATEWAY, allowInsecureHttp: true,
    }))
  } else if (kind === 'responses') {
    registry.registerAdapter(['gateway'], openAiAdapter({
      apiKey: password, baseUrl: `${GATEWAY}/v1`, allowInsecureHttp: true,
    }))
  } else {
    registry.registerAdapter(['gateway'], openAiAdapter({
      apiKey: password, baseUrl: `${GATEWAY}/v1`, api: 'chat-completions', allowInsecureHttp: true,
    }))
  }
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

describe.skipIf(!gatewayReachable)('codex2claudecode gateway (live)', () => {
  it.each([
    ['Anthropic Messages', 'anthropic'],
    ['OpenAI Responses', 'responses'],
    ['OpenAI Chat Completions', 'chat-completions'],
  ] as const)('answers through the %s wire for the same model', async (_name, kind) => {
    const chunks = await drain(registryWith(kind, ANY_PASSWORD).stream({
      provider: 'gateway', model: MODEL,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      signal: AbortSignal.timeout(45_000),
    }))
    expect(lastFinish(chunks).reason.kind).toBe('stop')
  }, 60_000)

  it('accepts any password on both the Anthropic x-api-key and OpenAI Bearer header shapes', async () => {
    const [viaHeader, viaBearer] = await Promise.all([
      drain(registryWith('anthropic', ANY_PASSWORD).stream({
        provider: 'gateway', model: MODEL,
        messages: [createTextMessage('Reply with exactly one word: hello')],
        signal: AbortSignal.timeout(45_000),
      })),
      drain(registryWith('chat-completions', ANY_PASSWORD).stream({
        provider: 'gateway', model: MODEL,
        messages: [createTextMessage('Reply with exactly one word: hello')],
        signal: AbortSignal.timeout(45_000),
      })),
    ])
    expect(lastFinish(viaHeader).reason.kind).toBe('stop')
    expect(lastFinish(viaBearer).reason.kind).toBe('stop')
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
    const chunks = await drain(registryWith('responses', ANY_PASSWORD).stream({
      provider: 'gateway', model: MODEL,
      messages: [message],
      signal: AbortSignal.timeout(45_000),
    }))
    expect(lastFinish(chunks).reason.kind).toBe('stop')
  }, 60_000)

  it.each([
    ['Anthropic Messages', 'anthropic'],
    ['OpenAI Responses', 'responses'],
    ['OpenAI Chat Completions', 'chat-completions'],
  ] as const)('forwards a valid reasoning effort through the %s wire and the gateway accepts it', async (_name, kind) => {
    const chunks = await drain(registryWith(kind, ANY_PASSWORD).stream({
      provider: 'gateway', model: MODEL,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      reasoningEffort: ReasoningEffortId('low'),
      signal: AbortSignal.timeout(45_000),
    }))
    expect(lastFinish(chunks).reason.kind).toBe('stop')
  }, 60_000)

  it('surfaces the gateway\'s own rejection message for an effort value it does not recognize', async () => {
    // Same dispatch-error shape confirmed for Gemini
    // (gemini-reasoning-effort-live.spec.ts): a rejection over
    // `registry.stream()` arrives as a `finish` chunk, not a rejected promise.
    const chunks = await drain(registryWith('anthropic', ANY_PASSWORD).stream({
      provider: 'gateway', model: MODEL,
      messages: [createTextMessage('Reply with exactly one word: hello')],
      reasoningEffort: ReasoningEffortId('not-a-real-effort-value'),
      signal: AbortSignal.timeout(45_000),
    }))
    const finish = lastFinish(chunks)
    expect(finish.reason.kind).toBe('error')
    // Decision 7 (redesign plan): the SDK does not clean up or replace the
    // provider's own rejection text — this is the gateway's real 400 body,
    // verbatim, forwarded from its own upstream.
    expect(finish.reason.failure?.message).toContain('not-a-real-effort-value')
  }, 60_000)
})
