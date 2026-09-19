import { describe, expect, it, vi } from 'vitest'
import { ModelRegistry, createAgentRuntime, ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import {
  ANTHROPIC_BASE_URL,
  anthropicAdapter,
  anthropicPlugin,
} from '@alvin0/ai-agent-sdk-provider-anthropic'
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'
import { officialProviderConformanceFixture } from './fixtures/official-provider-conformance.ts'

const ANTHROPIC_TEXT = [
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  'data: {"type":"content_block_stop","index":0}',
]

/** A complete, minimal success stream — the whole envelope, not just the text. */
const SUCCESS_FRAMES = [
  'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}',
  ...ANTHROPIC_TEXT,
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  'data: {"type":"message_stop"}',
]

const anthropicConformance = officialProviderConformanceFixture({
  family: 'anthropic',
  model: 'claude-conformance',
  completeFrames: [
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}',
    ...ANTHROPIC_TEXT,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'data: {"type":"message_stop"}',
  ],
  missingUsageFrames: [
    'data: {"type":"message_start","message":{"id":"m1"}}',
    ...ANTHROPIC_TEXT,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'data: {"type":"message_stop"}',
  ],
  malformedUsageFrames: [
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":"private-invalid-counter"}}}',
    ...ANTHROPIC_TEXT,
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    'data: {"type":"message_stop"}',
  ],
  createAdapter: input => anthropicAdapter({ apiKey: 'private-anthropic-key', ...input }),
})

describe('Universal Anthropic provider plugin', () => {
  it('passes the reusable provider conformance contract', async () => {
    await expect(runProviderConformanceSuite(anthropicConformance, { caseTimeoutMs: 1_000 }))
      .resolves.toMatchObject({ status: 'passed', passed: 19, failed: 0 })
  })

  it('requires injection and constructs without resolving credentials or dispatching', () => {
    let resolutions = 0
    const adapter = anthropicAdapter({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect(adapter.providerInfo('anthropic')).toEqual({ id: 'anthropic', name: 'Anthropic' })
    expect(ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(resolutions).toBe(0)
  })

  it('lets `displayName` name a compatible gateway in diagnostics instead of "Anthropic"', () => {
    const adapter = anthropicAdapter({ apiKey: 'key', displayName: 'Kimi' })
    expect(adapter.providerInfo('kimi')).toEqual({ id: 'kimi', name: 'Kimi' })
  })

  it('rejects a `reasoningFormat` from a different protocol instead of silently reinterpreting it', () => {
    expect(() => anthropicAdapter({
      apiKey: 'key',
      // 'deepseek' is Chat Completions' value; Anthropic only knows
      // 'output-config' | 'thinking-budget'.
      reasoningFormat: 'deepseek' as never,
    })).toThrow(/reasoningFormat/)
  })

  describe('promptCaching', () => {
    async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
      const chunks: unknown[] = []
      for await (const chunk of stream) chunks.push(chunk)
      return chunks
    }

    it('sends no `cache_control` by default', async () => {
      let requestedBody: Record<string, unknown> | undefined
      const adapter = anthropicAdapter({
        apiKey: 'key', baseUrl: 'https://no-cache.invalid',
        fetch: vi.fn(async (_i, init?: RequestInit) => {
          requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return new Response(SUCCESS_FRAMES.map(f => `${f}\n\n`).join(''), {
            status: 200, headers: { 'content-type': 'text/event-stream' },
          })
        }),
      })
      await drain(adapter.stream({ provider: 'anthropic', model: 'm', messages: [] }))
      expect(JSON.stringify(requestedBody)).not.toContain('cache_control')
    })

    it('falls back to no `cache_control` — permanently — the first time a gateway rejects it', async () => {
      let calls = 0
      const seenCaching: boolean[] = []
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1
        const body = JSON.parse(String(init?.body)) as { system?: unknown }
        const hasCacheControl = JSON.stringify(body).includes('cache_control')
        seenCaching.push(hasCacheControl)
        if (hasCacheControl) {
          return Response.json({
            error: { type: 'invalid_request_error', message: "Extra inputs are not permitted: cache_control" },
          }, { status: 400 })
        }
        return new Response(SUCCESS_FRAMES.map(f => `${f}\n\n`).join(''), {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      })
      const adapter = anthropicAdapter({
        apiKey: 'key', baseUrl: 'https://rejects-caching.invalid', promptCaching: true, fetch,
      })

      // First call: rejected with caching on, retried without it, transparently.
      // `system` guarantees a breakpoint regardless of message count — the
      // system prompt is always marked once `promptCaching` is on.
      const first = await drain(adapter.stream({
        provider: 'anthropic', model: 'm', system: 'be terse', messages: [],
      }))
      expect(first.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(calls).toBe(2)
      expect(seenCaching).toEqual([true, false])

      // Second call: the fallback is remembered — one request, no cache_control.
      calls = 0
      await drain(adapter.stream({ provider: 'anthropic', model: 'm', system: 'be terse', messages: [] }))
      expect(calls).toBe(1)
      expect(seenCaching.at(-1)).toBe(false)
    })

    it('does not swallow an unrelated rejection', async () => {
      const fetch = vi.fn(async () => Response.json(
        { error: { type: 'invalid_request_error', message: 'model not found' } },
        { status: 404 },
      ))
      const adapter = anthropicAdapter({
        apiKey: 'key', baseUrl: 'https://other-error.invalid', promptCaching: true, fetch,
      })
      await expect(drain(adapter.stream({ provider: 'anthropic', model: 'm', messages: [] })))
        .rejects.toMatchObject({ message: expect.stringContaining('model not found') })
      expect(fetch).toHaveBeenCalledTimes(1) // no retry for an unrelated error
    })
  })

  it('installs and disposes transactionally without ambient registration', () => {
    let resolutions = 0
    const registry = new ModelRegistry()
    const plugin = anthropicPlugin({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect('kind' in plugin).toBe(false)
    expect(registry.listProviders()).toEqual([])
    const dispose = registry.install(plugin)
    expect(registry.listProviders()).toEqual([{ id: 'anthropic', name: 'Anthropic' }])
    expect(resolutions).toBe(0)
    dispose()
    expect(registry.listProviders()).toEqual([])
  })

  it('creates a composable provider with an independent route and fallback model', async () => {
    const plugin = anthropicPlugin({
      id: 'anthropic-research',
      apiKey: 'research-key',
      defaultModel: 'claude-research',
    })
    expect(plugin).toMatchObject({
      kind: 'model-provider-plugin', apiVersion: 1, id: 'anthropic-research',
      family: 'anthropic', routes: ['anthropic-research'],
      defaultModel: { provider: 'anthropic-research', id: 'claude-research' },
    })
    const runtime = await createAgentRuntime({ providers: [plugin] })
    try {
      expect(runtime.providers()[0]).toMatchObject({
        route: 'anthropic-research', pluginId: 'anthropic-research', family: 'anthropic',
      })
    } finally {
      await runtime.close()
    }
  })

  // Pha 5 (ma trận tương thích): mock server mô phỏng một endpoint tương thích
  // Anthropic Messages thật (kiểu DeepSeek `/anthropic`) — Bearer thay vì
  // x-api-key, khối `thinking` trước khối `text` (đúng thứ tự quan sát được ở
  // codex2claudecode, mục 4 của plan), và effort qua `output_config.effort`.
  it('reaches a Bearer-auth Anthropic-compatible endpoint (DeepSeek `/anthropic`-style) end to end', async () => {
    let requestedAuth: string | null = null
    let requestedApiKeyHeader: string | null = null
    let requestedBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requestedAuth = headers.get('authorization')
      requestedApiKeyHeader = headers.get('x-api-key')
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning..."}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"the answer"}}',
        'data: {"type":"content_block_stop","index":1}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        'data: {"type":"message_stop"}',
      ].join('\n\n')
      return new Response(`${frames}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    })
    const adapter = anthropicAdapter({
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authHeader: 'bearer',
      fetch,
    })
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'deepseek-anthropic', model: 'deepseek-chat', messages: [],
      reasoningEffort: ReasoningEffortId('high'),
    })) chunks.push(chunk)
    expect(requestedAuth).toBe('Bearer deepseek-key')
    expect(requestedApiKeyHeader).toBeNull()
    expect(requestedBody?.output_config).toEqual({ effort: 'high' })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'reasoning-delta', text: 'reasoning...' }))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'the answer' }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
})
