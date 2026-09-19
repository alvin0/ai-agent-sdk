/**
 * Anthropic Messages wire against a real Anthropic-compatible endpoint.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Needs
 * `MESSAGES_URL`, `MESSAGES_API_KEY`, `MESSAGES_MODEL` (a zenmux.ai-style
 * gateway exposing `/v1/messages`); with any missing, this describe SKIPs
 * rather than fails — same pattern as `gemini-reasoning-effort-live.spec.ts`.
 *
 * This is the redesign plan's Phase 5 acceptance matrix (Anthropic Messages
 * row): a mock server only proves the SDK sends what it was told to send —
 * this is the one test proving a real Messages endpoint accepts the request
 * this SDK builds and that the SDK correctly parses a real response back
 * into a message.
 */

import { describe, expect, it } from 'vitest'
import { ModelRegistry, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'

const url = process.env.MESSAGES_URL
const apiKey = process.env.MESSAGES_API_KEY
const model = process.env.MESSAGES_MODEL
// The Anthropic Messages protocol appends `/v1/messages` itself.
const baseUrl = url?.replace(/\/v1\/messages\/?$/, '')

function registryFor(): ModelRegistry {
  const registry = new ModelRegistry()
  registry.registerAdapter(['zenmux'], anthropicAdapter({
    apiKey: apiKey as string,
    baseUrl: baseUrl as string,
    models: [{ id: model as string }],
  }))
  return registry
}

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe.skipIf(url === undefined || apiKey === undefined || model === undefined)(
  'Anthropic Messages wire (live, Anthropic-compatible gateway)',
  () => {
    it('dispatches a real request and parses the real streamed response back into text', async () => {
      const chunks = await drain(registryFor().stream({
        provider: 'zenmux', model: model as string,
        messages: [createTextMessage('Reply with exactly one word: hello')],
        signal: AbortSignal.timeout(30_000),
      }))
      const finish = chunks.at(-1) as { type: string; reason: { kind: string } }
      expect(finish.type).toBe('finish')
      expect(finish.reason.kind).toBe('stop')
      const text = chunks
        .filter((chunk): chunk is { type: 'text-delta'; text: string } =>
          (chunk as { type: string }).type === 'text-delta')
        .map(chunk => chunk.text)
        .join('')
      expect(text.toLowerCase()).toContain('hello')
    }, 60_000)
  },
)
