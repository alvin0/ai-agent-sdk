/**
 * End-to-end tests against the real Codex endpoint.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Requires
 * `npm run provider:codex:login-device` first.
 *
 * These exercise the whole stack in one go — registry, base HTTP pipeline, SSE
 * decoding, the shared Responses wire, and the assembler — which is exactly what
 * unit tests with a mock server cannot tell you: that the wire contract is
 * actually right.
 */

import { describe, expect, it } from 'vitest'
import { BlockAssembler } from '@ai-agent-sdk/core'
import type { StreamChunk } from '@ai-agent-sdk/core'
import { createTextMessage } from '@ai-agent-sdk/core'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { codexNodeAdapter as codexAdapter, fileCodexAuthStore } from '@ai-agent-sdk/auth-node/codex'

/** A model this account can reach. Discovered via the adapter's own catalog. */
const MODEL = 'gpt-5.6-luna'
const PROVIDER = 'codex'

/** Skip the whole suite rather than fail it when nobody has logged in. */
const signedIn = await (async () => {
  const file = await fileCodexAuthStore().read()
  return file?.tokens != null
})()

async function collect(stream: AsyncIterable<StreamChunk>): Promise<{
  chunks: StreamChunk[]
  assembler: BlockAssembler
}> {
  const chunks: StreamChunk[] = []
  const assembler = new BlockAssembler()
  for await (const chunk of stream) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  return { chunks, assembler }
}

function registry(): ModelRegistry {
  const instance = new ModelRegistry()
  instance.registerAdapter([PROVIDER], codexAdapter())
  return instance
}

describe.skipIf(!signedIn)('codex provider (live)', () => {
  it('discovers the account model catalog', async () => {
    const models = await registry().listModels(PROVIDER)
    expect(models.length).toBeGreaterThan(0)
    // Discovery must report modalities, otherwise the base pipeline would treat
    // every model as text-only and silently strip image input.
    expect(models.some(model => model.inputModalities?.includes('image') === true)).toBe(true)
  }, 60_000)

  it('streams text and assembles a message', async () => {
    const { chunks, assembler } = await collect(registry().stream({
      provider: PROVIDER,
      model: MODEL,
      reasoningEffort: ReasoningEffortId('medium'),
      system: 'Answer with a single lowercase word and no punctuation.',
      messages: [createTextMessage('What colour is a clear midday sky? One word.')],
    }))

    const finish = chunks.at(-1)
    expect(finish?.type).toBe('finish')
    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('stop')

    // The protocol promises deltas arrive before the authoritative block-end.
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    expect(chunks.some(chunk => chunk.type === 'block-end')).toBe(true)

    const message = assembler.message({ kind: 'model', provider: PROVIDER, model: MODEL })
    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(text.toLowerCase()).toContain('blue')

    const usage = assembler.usage
    expect(usage).toBeDefined()
    expect(usage?.inputTokens).toBeGreaterThan(0)
    expect(usage?.outputTokens).toBeGreaterThan(0)
  }, 120_000)

  it('emits a tool call with parseable arguments', async () => {
    const { chunks, assembler } = await collect(registry().stream({
      provider: PROVIDER,
      model: MODEL,
      reasoningEffort: ReasoningEffortId('medium'),
      system: 'Use the get_weather tool to answer. Do not answer from memory.',
      messages: [createTextMessage('What is the weather in Hanoi right now?')],
      tools: [{
        name: 'get_weather',
        description: 'Look up the current weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      }],
      toolChoice: 'required',
    }))

    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('tool-calls')

    const calls = assembler.blocks()
      .filter((block): block is Extract<typeof block, { type: 'tool-call' }> =>
        block.type === 'tool-call')
    expect(calls.length).toBeGreaterThan(0)
    const call = calls[0]
    expect(call?.name).toBe('get_weather')
    expect(call?.id.length).toBeGreaterThan(0)
    // Arguments stay a raw string on the wire; they must still be valid JSON here.
    const args = JSON.parse(call?.arguments ?? '{}') as { city?: string }
    expect(typeof args.city).toBe('string')
  }, 120_000)

  it('reports an unknown model as a non-retryable request error', async () => {
    const { chunks } = await collect(registry().stream({
      provider: PROVIDER,
      model: 'definitely-not-a-real-model',
      messages: [createTextMessage('hi')],
    }))
    const finish = chunks.at(-1)
    if (finish?.type !== 'finish') throw new Error('expected a terminal finish chunk')
    expect(finish.reason.kind).toBe('error')
    if (finish.reason.kind !== 'error') return
    expect(finish.reason.failure.code).toBe('INVALID_REQUEST')
    expect(finish.reason.failure.status).toBe(400)
    // The `{"detail": ...}` body shape must survive into a readable message.
    expect(finish.reason.failure.message).toMatch(/not supported/i)
  }, 60_000)
})
