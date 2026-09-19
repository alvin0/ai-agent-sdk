import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, ReasoningEffortId } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import {
  OPENAI_BASE_URL,
  openAiAdapter,
  openAiPlugin,
} from '@alvin0/ai-agent-sdk-provider-openai'
import { runProviderConformanceSuite } from '@alvin0/ai-agent-sdk-testkit'
import { officialProviderConformanceFixture } from './fixtures/official-provider-conformance.ts'

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const RESPONSES_TEXT = [
  'data: {"type":"response.created","response":{"id":"r1"}}',
  'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
  'data: {"type":"response.output_text.delta","item_id":"i1","delta":"ok"}',
  'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message","content":[{"type":"output_text","text":"ok"}]}}',
]

const openAiConformance = officialProviderConformanceFixture({
  family: 'openai',
  model: 'gpt-conformance',
  completeFrames: [...RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}'],
  missingUsageFrames: [...RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1"}}'],
  malformedUsageFrames: [...RESPONSES_TEXT,
    'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":1}}}'],
  createAdapter: input => openAiAdapter({ apiKey: 'private-openai-key', ...input }),
})

describe('Universal OpenAI provider plugin', () => {
  it('passes the reusable provider conformance contract', async () => {
    await expect(runProviderConformanceSuite(openAiConformance, { caseTimeoutMs: 1_000 }))
      .resolves.toMatchObject({ status: 'passed', passed: 19, failed: 0 })
  })

  it('requires injection and constructs without resolving credentials or dispatching', () => {
    let resolutions = 0
    const adapter = openAiAdapter({ apiKey: () => { resolutions++; return 'injected-key' } })
    expect(adapter.providerInfo('openai')).toEqual({ id: 'openai', name: 'OpenAI' })
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(resolutions).toBe(0)
  })

  it('lets `displayName` name a compatible gateway in diagnostics instead of "OpenAI"', () => {
    const adapter = openAiAdapter({ apiKey: 'key', displayName: 'DeepSeek' })
    expect(adapter.providerInfo('deepseek')).toEqual({ id: 'deepseek', name: 'DeepSeek' })
  })

  it('installs preferred custom aliases transactionally', async () => {
    const plugin = openAiPlugin({
      apiKey: 'injected-key',
      routes: ['openai', 'compatible-gateway'],
    })
    expect(plugin).toMatchObject({
      kind: 'model-provider-plugin', id: 'openai', family: 'openai',
      routes: ['openai', 'compatible-gateway'],
    })
    const runtime = await createAgentRuntime({ providers: [plugin] })
    expect(runtime.providers().map(provider => provider.route)).toEqual([
      'openai', 'compatible-gateway',
    ])
    await runtime.close()
  })

  it('creates independent composable instances with route-scoped model defaults', async () => {
    const first = openAiPlugin({
      id: 'openai-team-a',
      apiKey: 'team-a-key',
      defaultModel: 'model-a',
    })
    const second = openAiPlugin({
      id: 'openai-team-b',
      apiKey: 'team-b-key',
      defaultModel: { provider: 'openai-team-b', id: 'model-b' },
    })
    expect(first).toMatchObject({
      kind: 'model-provider-plugin', apiVersion: 1, id: 'openai-team-a',
      family: 'openai', routes: ['openai-team-a'],
      defaultModel: { provider: 'openai-team-a', id: 'model-a' },
    })

    const runtime = await createAgentRuntime({ providers: [first, second] })
    try {
      expect(runtime.providers()).toEqual([
        expect.objectContaining({
          route: 'openai-team-a', pluginId: 'openai-team-a', family: 'openai',
          defaultModel: { provider: 'openai-team-a', id: 'model-a' },
        }),
        expect.objectContaining({
          route: 'openai-team-b', pluginId: 'openai-team-b', family: 'openai',
          defaultModel: { provider: 'openai-team-b', id: 'model-b' },
        }),
      ])
    } finally {
      await runtime.close()
    }
  })

  it('speaks Chat Completions instead of Responses when `api: "chat-completions"`', async () => {
    let requestedUrl = ''
    let requestedBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input)
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
      ].join('\n\n')
      return new Response(`${frames}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    })
    const adapter = openAiAdapter({
      apiKey: 'private-openai-key',
      baseUrl: 'https://compatible-gateway.invalid/v1',
      api: 'chat-completions',
      fetch,
    })
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream({
      provider: 'openai', model: 'compatible-model', messages: [], reasoningEffort: ReasoningEffortId('high'),
    })) chunks.push(chunk)
    expect(requestedUrl).toBe('https://compatible-gateway.invalid/v1/chat/completions')
    expect(requestedBody?.model).toBe('compatible-model')
    expect(requestedBody?.reasoning_effort).toBe('high')
    expect(requestedBody?.messages).toBeInstanceOf(Array)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('lets `compat` override the Chat Completions defaults', async () => {
    let requestedBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    })
    const adapter = openAiAdapter({
      apiKey: 'private-openai-key',
      baseUrl: 'https://deepseek-like.invalid/v1',
      api: 'chat-completions',
      compat: { reasoningFormat: 'deepseek', maxTokensField: 'max_completion_tokens' },
      fetch,
    })
    for await (const _chunk of adapter.stream({
      provider: 'openai', model: 'deepseek-model', messages: [], reasoningEffort: ReasoningEffortId('off'),
    })) { /* drain */ }
    expect(requestedBody?.thinking).toEqual({ type: 'disabled' })
    expect(requestedBody?.reasoning_effort).toBeUndefined()
  })

  it('snapshots the full `compat` combination, every field at once, onto one Chat Completions request', async () => {
    let requestedBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })
    })
    const adapter = openAiAdapter({
      apiKey: 'private-openai-key',
      baseUrl: 'https://compat-matrix.invalid/v1',
      api: 'chat-completions',
      compat: {
        reasoningFormat: 'deepseek',
        maxTokensField: 'max_completion_tokens',
        systemRole: 'developer',
        structuredOutputs: 'json-object',
        tools: true,
        parallelToolCalls: true,
        streamUsage: false,
        stop: true,
        seed: true,
        promptCacheKey: 'session-42',
      },
      fetch,
    })
    for await (const _chunk of adapter.stream({
      provider: 'openai', model: 'compat-matrix-model',
      messages: [], system: 'Be terse.',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
      stop: ['STOP'],
      outputFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object' } },
      tools: [{ name: 'lookup', description: 'Look something up.', parameters: { type: 'object' } }],
    })) { /* drain */ }
    // reasoningFormat: 'deepseek' — non-'off' effort sends both fields.
    expect(requestedBody?.thinking).toEqual({ type: 'enabled' })
    expect(requestedBody?.reasoning_effort).toBe('high')
    // maxTokensField: 'max_completion_tokens', not the default `max_tokens`.
    expect(requestedBody?.max_completion_tokens).toBe(512)
    expect(requestedBody?.max_tokens).toBeUndefined()
    // systemRole: 'developer', not the default `system`.
    expect((requestedBody?.messages as Array<{ role: string }>)?.[0]?.role).toBe('developer')
    // structuredOutputs: 'json-object' downgrades the caller's schema request
    // to bare JSON mode instead of the default full-schema `'json-schema'`.
    expect(requestedBody?.response_format).toEqual({ type: 'json_object' })
    // tools: true + parallelToolCalls: true.
    expect(requestedBody?.tools).toBeInstanceOf(Array)
    expect(requestedBody?.parallel_tool_calls).toBe(true)
    // streamUsage: false overrides the protocol default (`true`).
    expect(requestedBody?.stream_options).toBeUndefined()
    // stop: true, promptCacheKey passed through. `seed: true` has no effect yet
    // — `GenerateOptions` has no seed source, so `dialect.seed` never reaches
    // the wire regardless (see serialize.ts's comment on the flag).
    expect(requestedBody?.stop).toEqual(['STOP'])
    expect(requestedBody?.seed).toBeUndefined()
    expect(requestedBody?.prompt_cache_key).toBe('session-42')
  })

  it('rejects a `reasoningFormat` from a different protocol instead of silently reinterpreting it', () => {
    expect(() => openAiAdapter({
      apiKey: 'key', api: 'chat-completions',
      // 'thinking-budget' is Anthropic's value; Chat Completions only knows
      // 'openai' | 'deepseek' | false.
      compat: { reasoningFormat: 'thinking-budget' as never },
    })).toThrow(/reasoningFormat/)
  })

  describe('promptCaching', () => {
    it('sends no `prompt_cache_key` by default, on either wire', async () => {
      let responsesBody: Record<string, unknown> | undefined
      const responsesAdapter = openAiAdapter({
        apiKey: 'key',
        baseUrl: 'https://no-cache.invalid/v1',
        fetch: vi.fn(async (_i, init?: RequestInit) => {
          responsesBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\ndata: [DONE]\n\n', {
            status: 200, headers: { 'content-type': 'text/event-stream' },
          })
        }),
      })
      await drain(responsesAdapter.stream({ provider: 'openai', model: 'm', messages: [] }))
      expect(responsesBody?.prompt_cache_key).toBeUndefined()
    })

    it('auto-generates a stable key shared by both wires of one mixed route when `promptCaching` is on', async () => {
      const seen: { model: string; key: unknown }[] = []
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        if (url.includes('/responses')) {
          seen.push({ model: String(body.model), key: body.prompt_cache_key })
          return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\ndata: [DONE]\n\n', {
            status: 200, headers: { 'content-type': 'text/event-stream' },
          })
        }
        seen.push({ model: String(body.model), key: body.prompt_cache_key })
        return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      })
      const adapter = openAiAdapter({
        apiKey: 'key',
        baseUrl: 'https://mixed-cache.invalid/v1',
        promptCaching: true,
        fetch,
        models: [
          { id: 'responses-model' },
          { id: 'chat-model', api: 'chat-completions' },
        ],
      })
      await drain(adapter.stream({ provider: 'openai', model: 'responses-model', messages: [] }))
      await drain(adapter.stream({ provider: 'openai', model: 'chat-model', messages: [] }))
      expect(seen).toHaveLength(2)
      expect(typeof seen[0]?.key).toBe('string')
      expect(seen[0]?.key).toBe(seen[1]?.key) // one session, one key, across both wires
    })

    it('uses an explicit `promptCacheKey` verbatim instead of generating one', async () => {
      let requestedBody: Record<string, unknown> | undefined
      const adapter = openAiAdapter({
        apiKey: 'key',
        baseUrl: 'https://explicit-cache.invalid/v1',
        promptCacheKey: 'my-own-session-id',
        fetch: vi.fn(async (_i, init?: RequestInit) => {
          requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\ndata: [DONE]\n\n', {
            status: 200, headers: { 'content-type': 'text/event-stream' },
          })
        }),
      })
      await drain(adapter.stream({ provider: 'openai', model: 'm', messages: [] }))
      expect(requestedBody?.prompt_cache_key).toBe('my-own-session-id')
    })

    it('falls back to no `prompt_cache_key` — permanently — the first time a gateway rejects it', async () => {
      let calls = 0
      const seenKeys: unknown[] = []
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        seenKeys.push(body.prompt_cache_key)
        if (body.prompt_cache_key !== undefined) {
          return Response.json({
            error: { message: 'Unrecognized request argument supplied: prompt_cache_key', type: 'invalid_request_error' },
          }, { status: 400 })
        }
        return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      })
      const adapter = openAiAdapter({
        apiKey: 'key', baseUrl: 'https://rejects-cache-key.invalid/v1', promptCaching: true, fetch,
      })

      // First call: rejected with the key, retried without it, transparently.
      const first = await drain(adapter.stream({ provider: 'openai', model: 'm', messages: [] }))
      expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(calls).toBe(2)
      expect(seenKeys[0]).toEqual(expect.any(String))
      expect(seenKeys[1]).toBeUndefined()

      // Second call: the fallback is remembered — one request, no key, no retry.
      calls = 0
      const second = await drain(adapter.stream({ provider: 'openai', model: 'm', messages: [] }))
      expect(second.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(calls).toBe(1)
      expect(seenKeys.at(-1)).toBeUndefined()
    })

    it('falls back every concurrent rejected call and keeps already-prepared calls cache-free afterward', async () => {
      const seenKeys: unknown[] = []
      let keyedRequests = 0
      let releaseKeyedRequests!: () => void
      const bothKeyedRequestsArrived = new Promise<void>(resolve => { releaseKeyedRequests = resolve })
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        seenKeys.push(body.prompt_cache_key)
        if (body.prompt_cache_key !== undefined) {
          keyedRequests += 1
          if (keyedRequests === 2) releaseKeyedRequests()
          await bothKeyedRequestsArrived
          return Response.json({
            error: { message: 'Unrecognized request argument supplied: prompt_cache_key' },
          }, { status: 400 })
        }
        return new Response('data: {"type":"response.completed","response":{"id":"r1"}}\n\ndata: [DONE]\n\n', {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      })
      const adapter = openAiAdapter({
        apiKey: 'key', baseUrl: 'https://concurrent-cache.invalid/v1', promptCaching: true, fetch,
      })
      // Prepare one call before the fallback trips. It must still observe the
      // permanent disable when it eventually starts streaming.
      const prepared = await adapter.prepareCall('openai', 'm')
      const request = { provider: 'openai', model: 'm', messages: [] } as const
      const [left, right] = await Promise.all([
        drain(adapter.stream(request)),
        drain(adapter.stream(request)),
      ])
      expect(left.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(right.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(seenKeys.filter(key => key !== undefined)).toHaveLength(2)
      expect(seenKeys.filter(key => key === undefined)).toHaveLength(2)

      await drain(prepared.stream(request))
      expect(seenKeys.at(-1)).toBeUndefined()
      expect(fetch).toHaveBeenCalledTimes(5)
    })

    it('does not swallow an unrelated rejection', async () => {
      const fetch = vi.fn(async () => Response.json(
        { error: { message: 'model not found', type: 'invalid_request_error' } },
        { status: 404 },
      ))
      const adapter = openAiAdapter({
        apiKey: 'key', baseUrl: 'https://other-error.invalid/v1', promptCaching: true, fetch,
      })
      await expect(drain(adapter.stream({ provider: 'openai', model: 'm', messages: [] })))
        .rejects.toMatchObject({ message: expect.stringContaining('model not found') })
      expect(fetch).toHaveBeenCalledTimes(1) // no retry for an unrelated error
    })
  })

  // Pha 5 (ma trận tương thích): mock server theo đúng wire từng vendor thay vì
  // chỉ kiểm request — ở đây kiểm cả RESPONSE thật của DeepSeek/Ollama/vLLM
  // dịch đúng qua adapter, không chỉ ở tầng protocol (đã có sẵn ở
  // chat-completions-serialize.spec.ts).
  describe('mock server: DeepSeek, Ollama, vLLM (Chat Completions wire)', () => {
    it('translates DeepSeek\'s `reasoning_content` delta into a reasoning chunk', async () => {
      const fetch = vi.fn(async () => {
        const frames = [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"let me think"}}]}',
          'data: {"choices":[{"index":0,"delta":{"content":"the answer is 4"}}]}',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ].join('\n\n')
        return new Response(`${frames}\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      })
      const adapter = openAiAdapter({
        apiKey: 'deepseek-key',
        baseUrl: 'https://api.deepseek.com/v1',
        api: 'chat-completions',
        compat: { reasoningFormat: 'deepseek' },
        fetch,
      })
      const chunks: unknown[] = []
      for await (const chunk of adapter.stream({
        provider: 'deepseek', model: 'deepseek-reasoner', messages: [], reasoningEffort: ReasoningEffortId('high'),
      })) chunks.push(chunk)
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'reasoning-delta', text: 'let me think' }))
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'the answer is 4' }))
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    })

    it('reaches Ollama (no real auth, `max_tokens`, no reasoning field) with defaults alone', async () => {
      let requestedBody: Record<string, unknown> | undefined
      let requestedAuth: string | null = null
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestedAuth = new Headers(init?.headers).get('authorization')
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        const frames = [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"hi there"}}]}',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ].join('\n\n')
        return new Response(`${frames}\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      })
      // Ollama does not check the key's value, but this package always requires
      // one to be configured (Universal packages never read env for you); a
      // placeholder is exactly what a local Ollama setup uses in practice.
      const adapter = openAiAdapter({
        apiKey: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        allowInsecureHttp: true,
        api: 'chat-completions',
        fetch,
      })
      const chunks: unknown[] = []
      for await (const chunk of adapter.stream({
        provider: 'ollama', model: 'llama3.1', messages: [], maxTokens: 256,
      })) chunks.push(chunk)
      expect(requestedAuth).toBe('Bearer ollama')
      expect(requestedBody?.max_tokens).toBe(256)
      expect(requestedBody?.reasoning_effort).toBeUndefined()
      expect(requestedBody?.thinking).toBeUndefined()
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'hi there' }))
    })

    it('reaches a vLLM OpenAI-compatible server (`max_tokens`, tool call) the same way', async () => {
      let requestedBody: Record<string, unknown> | undefined
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        const frames = [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"vLLM says hi"}}]}',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],'
            + '"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
          'data: [DONE]',
        ].join('\n\n')
        return new Response(`${frames}\n\n`, {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        })
      })
      const adapter = openAiAdapter({
        apiKey: 'vllm-key',
        baseUrl: 'http://localhost:8000/v1',
        allowInsecureHttp: true,
        api: 'chat-completions',
        fetch,
      })
      const chunks: unknown[] = []
      for await (const chunk of adapter.stream({
        provider: 'vllm', model: 'meta-llama/Llama-3.1-8B-Instruct', messages: [], maxTokens: 512,
      })) chunks.push(chunk)
      expect(requestedBody?.max_tokens).toBe(512)
      expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'vLLM says hi' }))
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    })
  })

  // Pha 4a (còn thiếu): "một route phục vụ cả hai kiểu model" — models[].api
  // chọn Responses hoặc Chat Completions theo từng model, một route duy nhất.
  describe('one route, two OpenAI wires (models[].api)', () => {
    it('routes each model to its own wire and merges both catalogs', async () => {
      let responsesHits = 0
      let chatHits = 0
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/responses')) {
          responsesHits += 1
          const frames = [
            'data: {"type":"response.created","response":{"id":"r1"}}',
            'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
            'data: {"type":"response.output_text.delta","item_id":"i1","delta":"from responses"}',
            'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message",'
              + '"content":[{"type":"output_text","text":"from responses"}]}}',
            'data: {"type":"response.completed","response":{"id":"r1"}}',
          ].join('\n\n')
          return new Response(`${frames}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        chatHits += 1
        const frames = [
          'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"from chat"}}]}',
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ].join('\n\n')
        return new Response(`${frames}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })
      const adapter = openAiAdapter({
        apiKey: 'gateway-key',
        baseUrl: 'https://mixed-gateway.invalid/v1',
        models: [
          { id: 'reasoning-model' }, // no override — follows the route's own default ('responses')
          { id: 'classic-model', api: 'chat-completions' },
        ],
        fetch,
      })

      const responsesChunks: unknown[] = []
      for await (const chunk of adapter.stream({
        provider: 'gateway', model: 'reasoning-model', messages: [],
      })) responsesChunks.push(chunk)
      expect(responsesChunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'from responses' }))

      const chatChunks: unknown[] = []
      for await (const chunk of adapter.stream({
        provider: 'gateway', model: 'classic-model', messages: [],
      })) chatChunks.push(chunk)
      expect(chatChunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'from chat' }))

      expect(responsesHits).toBe(1)
      expect(chatHits).toBe(1)

      const catalog = await adapter.listModels('gateway')
      expect(catalog.map(model => model.id).sort()).toEqual(['classic-model', 'reasoning-model'])
    })

    it('stays a single adapter (no dual facade) when no model overrides the route default', async () => {
      const fetch = vi.fn(async (_input: string | URL | Request) => new Response(
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ))
      const adapter = openAiAdapter({
        apiKey: 'key',
        api: 'chat-completions',
        models: [{ id: 'a' }, { id: 'b', api: 'chat-completions' }],
        fetch,
      })
      for await (const _chunk of adapter.stream({ provider: 'gateway', model: 'a', messages: [] })) { /* drain */ }
      expect(fetch.mock.calls[0]?.[0]).toContain('/chat/completions')
    })

    it('routes each model to its own wire through the runtime-extension plugin path too', async () => {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        const frames = url.endsWith('/responses')
          ? [
            'data: {"type":"response.created","response":{"id":"r1"}}',
            'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
            'data: {"type":"response.output_text.delta","item_id":"i1","delta":"ok"}',
            'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message",'
              + '"content":[{"type":"output_text","text":"ok"}]}}',
            'data: {"type":"response.completed","response":{"id":"r1"}}',
          ].join('\n\n')
          : [
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
          ].join('\n\n')
        return new Response(`${frames}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      })
      const runtime = await createAgentRuntime({ providers: [openAiPlugin({
        id: 'gateway', apiKey: 'gateway-key', baseUrl: 'https://mixed-gateway.invalid/v1',
        models: [{ id: 'reasoning-model' }, { id: 'classic-model', api: 'chat-completions' }],
        fetch,
      })] })
      try {
        const responses = await runtime.agent({ id: 'agent-r', instructions: 'Reply.', compaction: false,
          model: { provider: 'gateway', id: 'reasoning-model' },
        }).generate('Hello')
        expect(responses.report.status).toBe('success')
        const chat = await runtime.agent({ id: 'agent-c', instructions: 'Reply.', compaction: false,
          model: { provider: 'gateway', id: 'classic-model' },
        }).generate('Hello')
        expect(chat.report.status).toBe('success')
        expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/responses'))).toBe(true)
        expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/chat/completions'))).toBe(true)
      } finally { await runtime.close() }
    })
  })
})
