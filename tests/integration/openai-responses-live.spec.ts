/**
 * OpenAI Responses wire against a real OpenAI-compatible endpoint.
 *
 * Excluded from `npm test`; run with `npm run test:integration`. Needs
 * `RESPONSE_URL`, `RESPONSE_API_KEY`, `RESPONSE_MODEL` (a zenmux.ai-style
 * gateway exposing `/responses`); with any missing, this describe SKIPs
 * rather than fails — same pattern as `gemini-reasoning-effort-live.spec.ts`.
 *
 * This is the redesign plan's Phase 5 acceptance matrix (Responses row): a
 * mock server only proves the SDK sends what it was told to send — this is
 * the one test proving a real Responses endpoint accepts the request this
 * SDK builds and that the SDK correctly parses a real response back into a
 * message.
 */

import { describe, expect, it } from 'vitest'
import { ModelRegistry, createTextMessage } from '@alvin0/ai-agent-sdk-core'
import { openAiAdapter } from '@alvin0/ai-agent-sdk-provider-openai'

const url = process.env.RESPONSE_URL
const apiKey = process.env.RESPONSE_API_KEY
const model = process.env.RESPONSE_MODEL
const baseUrl = url?.replace(/\/responses\/?$/, '')

function registryFor(): ModelRegistry {
  const registry = new ModelRegistry()
  registry.registerAdapter(['zenmux'], openAiAdapter({
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
  'OpenAI Responses wire (live, OpenAI-compatible gateway)',
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
