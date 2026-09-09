import { describe, expect, it } from 'vitest'
import { envCredential } from '@alvin0/ai-agent-sdk-auth-node'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import {
  GEMINI_BASE_URL,
  geminiAdapter,
  geminiPlugin,
} from '@alvin0/ai-agent-sdk-provider-gemini'
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'
import { officialProviderConformanceFixture } from './fixtures/official-provider-conformance.ts'

const GEMINI_TEXT = [
  'event: step.start\ndata: {"event_type":"step.start","index":0,"step":{"type":"model_output"}}',
  'event: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"ok"}}',
  'event: step.stop\ndata: {"event_type":"step.stop","index":0}',
]

const geminiConformance = officialProviderConformanceFixture({
  family: 'gemini',
  model: 'gemini-conformance',
  completeFrames: [...GEMINI_TEXT,
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"total_input_tokens":3,"total_output_tokens":2,"total_tokens":5}}}'],
  missingUsageFrames: [...GEMINI_TEXT,
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed"}}'],
  malformedUsageFrames: [...GEMINI_TEXT,
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"total_input_tokens":3,"total_output_tokens":2,"total_tokens":1}}}'],
  createAdapter: input => geminiAdapter({ apiKey: 'private-gemini-key', ...input }),
})

describe('Universal Gemini provider plugin', () => {
  it('passes the reusable provider conformance contract', async () => {
    await expect(runProviderConformanceSuite(geminiConformance, { caseTimeoutMs: 1_000 }))
      .resolves.toMatchObject({ status: 'passed', passed: 19, failed: 0 })
  })

  it('requires injection and constructs without resolving credentials or dispatching', () => {
    let resolutions = 0
    const adapter = geminiAdapter({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect(adapter.providerInfo('gemini')).toEqual({ id: 'gemini', name: 'Gemini' })
    expect(GEMINI_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(resolutions).toBe(0)
  })

  it('sends only the Interactions route with a redacted API-key auth layer', async () => {
    let requestedUrl = ''
    let requestedHeaders: Headers | undefined
    let loggedHeaders: Readonly<Record<string, string>> | undefined
    const adapter = geminiAdapter({
      apiKey: 'private-gemini-key',
      requestLogger(record) { loggedHeaders = record.headers },
      fetch: async (input, init) => {
        requestedUrl = String(input)
        requestedHeaders = new Headers(init?.headers)
        const frames = [
          ...GEMINI_TEXT,
          'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed"}}',
        ].join('\n\n')
        return new Response(`${frames}\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    for await (const _chunk of adapter.stream({
      provider: 'gemini', model: 'gemini-test',
      messages: [],
    })) { /* drain */ }
    expect(requestedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/interactions')
    expect(requestedHeaders?.get('x-goog-api-key')).toBe('private-gemini-key')
    expect(loggedHeaders?.['x-goog-api-key']).toBe('[REDACTED]')
  })

  it('creates independent composable instances with route-scoped defaults', async () => {
    const first = geminiPlugin({ id: 'gemini-a', apiKey: 'a', defaultModel: 'model-a' })
    const second = geminiPlugin({ id: 'gemini-b', apiKey: 'b', defaultModel: 'model-b' })
    const runtime = await createAgentRuntime({ providers: [first, second] })
    try {
      expect(runtime.providers()).toEqual([
        expect.objectContaining({ route: 'gemini-a', pluginId: 'gemini-a', family: 'gemini' }),
        expect.objectContaining({ route: 'gemini-b', pluginId: 'gemini-b', family: 'gemini' }),
      ])
    } finally {
      await runtime.close()
    }
  })

  it('accepts an injected callable credential source without resolving it at setup', async () => {
    const runtime = await createAgentRuntime({
      providers: [geminiPlugin({
        apiKey: envCredential('GEMINI_PROVIDER_TEST_KEY'),
        defaultModel: 'gemini-test',
      })],
    })
    try {
      expect(runtime.providers()).toEqual([
        expect.objectContaining({ route: 'gemini', family: 'gemini' }),
      ])
    } finally {
      await runtime.close()
    }
  })
})
