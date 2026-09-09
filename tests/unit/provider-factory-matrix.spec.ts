import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource, defineCredentialStore } from '@alvin0/ai-agent-sdk-core/provider'
import { openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import { anthropicPlugin } from '@alvin0/ai-agent-sdk-provider-anthropic'
import {
  codexPlugin,
  memoryCodexCredentialStore,
  type CodexAuthFile,
} from '@alvin0/ai-agent-sdk-provider-codex'

const encoder = new TextEncoder()

function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `e30.${encoded}.signature`
}

function sse(frames: readonly string[]): Response {
  return new Response(encoder.encode(`${frames.join('\n\n')}\n\n`), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function revisionedStore(read = vi.fn(() => Promise.resolve(undefined))) {
  return {
    store: defineCredentialStore<CodexAuthFile>({
      id: 'codex-matrix-store',
      label: 'Codex matrix store',
      read,
      commit: () => Promise.resolve({ revision: '1' }),
    }),
    read,
  }
}

describe('official preferred provider factory identity', () => {
  it('creates inert default identities without credential or network work', async () => {
    const openAiResolve = vi.fn(() => 'openai-secret')
    const anthropicResolve = vi.fn(() => 'anthropic-secret')
    const fetch = vi.fn<typeof globalThis.fetch>()
    const codex = revisionedStore()
    const providers = [
      openAiPlugin({ apiKey: defineCredentialSource({ id: 'openai-key', resolve: openAiResolve }), fetch }),
      anthropicPlugin({ apiKey: defineCredentialSource({ id: 'anthropic-key', resolve: anthropicResolve }), fetch }),
      codexPlugin({ authStore: codex.store, models: [], fetch }),
    ]
    expect(providers).toMatchObject([
      { kind: 'model-provider-plugin', id: 'openai', family: 'openai', routes: ['openai'] },
      { kind: 'model-provider-plugin', id: 'anthropic', family: 'anthropic', routes: ['anthropic'] },
      { kind: 'model-provider-plugin', id: 'codex', family: 'codex', routes: ['codex'] },
    ])
    expect(openAiResolve).not.toHaveBeenCalled()
    expect(anthropicResolve).not.toHaveBeenCalled()
    expect(codex.read).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    const runtime = await createAgentRuntime({ providers })
    expect(runtime.providers().map(({ route, pluginId, family }) => ({ route, pluginId, family })))
      .toEqual([
        { route: 'openai', pluginId: 'openai', family: 'openai' },
        { route: 'anthropic', pluginId: 'anthropic', family: 'anthropic' },
        { route: 'codex', pluginId: 'codex', family: 'codex' },
      ])
    expect(openAiResolve).not.toHaveBeenCalled()
    expect(anthropicResolve).not.toHaveBeenCalled()
    expect(codex.read).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await runtime.close()
  })

  it.each([
    ['OpenAI', (credential: never, fetch: typeof globalThis.fetch) =>
      openAiPlugin({ apiKey: credential, fetch })],
    ['Anthropic', (credential: never, fetch: typeof globalThis.fetch) =>
      anthropicPlugin({ apiKey: credential, fetch })],
  ])('rejects an accessor-backed %s credential marker before getter, resolution, or network I/O',
    async (_name, providerFor) => {
      const markerGetter = vi.fn(() => 'credential-source')
      const resolve = vi.fn(() => 'private-value-must-not-be-read')
      const fetch = vi.fn<typeof globalThis.fetch>()
      const credential = { apiVersion: 1, id: 'unsafe-source', resolve }
      Object.defineProperty(credential, 'kind', { enumerable: true, get: markerGetter })

      await expect(createAgentRuntime({
        providers: [providerFor(credential as never, fetch)],
      })).rejects.toMatchObject({
        failureCode: 'CAPABILITY_STARTUP_FAILED', stage: 'provider-setup', reason: 'failed',
      })
      expect(markerGetter).not.toHaveBeenCalled()
      expect(resolve).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    })

  it('infers a route from a custom id and preserves explicit aliases with fixed families', async () => {
    const codex = revisionedStore()
    const providers = [
      openAiPlugin({ id: 'openai-a', apiKey: 'key-a' }),
      anthropicPlugin({ id: 'anthropic-a', routes: ['claude', 'claude-proxy'], apiKey: 'key-b' }),
      codexPlugin({ id: 'codex-a', routes: ['chatgpt', 'codex-proxy'], authStore: codex.store, models: [] }),
    ]
    expect(providers).toMatchObject([
      { id: 'openai-a', family: 'openai', routes: ['openai-a'] },
      { id: 'anthropic-a', family: 'anthropic', routes: ['claude', 'claude-proxy'] },
      { id: 'codex-a', family: 'codex', routes: ['chatgpt', 'codex-proxy'] },
    ])
    const runtime = await createAgentRuntime({ providers })
    expect(runtime.providers().map(row => row.route)).toEqual([
      'openai-a', 'claude', 'claude-proxy', 'chatgpt', 'codex-proxy',
    ])
    await runtime.close()
  })

  it.each([
    ['OpenAI empty aliases', () => openAiPlugin({ apiKey: 'key', routes: [] })],
    ['OpenAI duplicate aliases', () => openAiPlugin({ apiKey: 'key', routes: ['same', 'same'] })],
    ['Anthropic empty aliases', () => anthropicPlugin({ apiKey: 'key', routes: [] })],
    ['Anthropic duplicate aliases', () => anthropicPlugin({ apiKey: 'key', routes: ['same', 'same'] })],
    ['Codex empty aliases', () => codexPlugin({ authStore: revisionedStore().store, routes: [], models: [] })],
    ['Codex duplicate aliases', () => codexPlugin({ authStore: revisionedStore().store, routes: ['same', 'same'], models: [] })],
  ])('rejects %s synchronously during inert identity validation', (_name, create) => {
    expect(create).toThrow(/route claims/i)
  })

  it('keeps two installations from the same family account-scoped', async () => {
    const calls: Array<{ account: string; authorization: string | null }> = []
    const accountFetch = (account: string): typeof globalThis.fetch => vi.fn(async (_input, init) => {
      calls.push({ account, authorization: new Headers(init?.headers).get('authorization') })
      return sse([
        'data: {"type":"response.created","response":{"id":"r1"}}',
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ])
    })
    const runtime = await createAgentRuntime({ providers: [
      openAiPlugin({ id: 'openai-account-a', apiKey: 'key-a', defaultModel: 'model-a',
        fetch: accountFetch('account-a') }),
      openAiPlugin({ id: 'openai-account-b', apiKey: 'key-b', defaultModel: 'model-b',
        fetch: accountFetch('account-b') }),
    ] })
    try {
      await runtime.agent({ id: 'agent-a', instructions: 'Reply.',
        model: { provider: 'openai-account-a' }, compaction: false }).generate('one')
      await runtime.agent({ id: 'agent-b', instructions: 'Reply.',
        model: { provider: 'openai-account-b' }, compaction: false }).generate('two')
    } finally {
      await runtime.close()
    }
    expect(runtime.providers().map(({ route, pluginId, family, defaultModel }) => ({
      route, pluginId, family, defaultModel,
    }))).toEqual([
      { route: 'openai-account-a', pluginId: 'openai-account-a', family: 'openai',
        defaultModel: { provider: 'openai-account-a', id: 'model-a' } },
      { route: 'openai-account-b', pluginId: 'openai-account-b', family: 'openai',
        defaultModel: { provider: 'openai-account-b', id: 'model-b' } },
    ])
    expect(calls).toEqual([
      { account: 'account-a', authorization: 'Bearer key-a' },
      { account: 'account-b', authorization: 'Bearer key-b' },
    ])
  })

  it('distinguishes empty from failed Codex discovery without blocking an explicit model', async () => {
    const credentials = () => memoryCodexCredentialStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    })
    const emptyFetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).includes('/models?')) return Response.json({ models: [] })
      return sse([
        'data: {"type":"response.created","response":{"id":"empty-run"}}',
        'data: {"type":"response.completed","response":{"id":"empty-run","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ])
    })
    const emptyRuntime = await createAgentRuntime({ providers: [codexPlugin({
      id: 'codex-empty', authStore: credentials(), fetch: emptyFetch,
    })] })
    try {
      await expect(emptyRuntime.modelCatalog('codex-empty')).resolves.toMatchObject({
        state: 'empty', models: [],
      })
    } finally {
      await emptyRuntime.close()
    }

    const failedFetch = vi.fn<typeof globalThis.fetch>(async input => {
      if (String(input).includes('/models?')) throw new Error('private discovery transport failure')
      return sse([
        'data: {"type":"response.created","response":{"id":"explicit-run"}}',
        'data: {"type":"response.completed","response":{"id":"explicit-run","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ])
    })
    const failedRuntime = await createAgentRuntime({ providers: [codexPlugin({
      id: 'codex-failed', authStore: credentials(), fetch: failedFetch,
    })] })
    try {
      await expect(failedRuntime.modelCatalog('codex-failed')).resolves.toMatchObject({
        state: 'unavailable', models: [],
        error: { code: 'MODEL_CATALOG_UNAVAILABLE', stage: 'model-catalog' },
      })
      await expect(failedRuntime.agent({
        id: 'explicit-after-failure',
        model: { provider: 'codex-failed', id: 'manual-model' },
        instructions: 'Reply.', compaction: false,
      }).generate('go')).resolves.toMatchObject({ report: { status: 'success' } })
    } finally {
      await failedRuntime.close()
    }
    expect(failedFetch.mock.calls.filter(([input]) => String(input).includes('/models?'))).toHaveLength(1)
    expect(failedFetch.mock.calls.filter(([input]) => String(input).endsWith('/responses'))).toHaveLength(1)
  })

  it('rolls back an earlier official registration when later adapter construction fails', async () => {
    const firstFetch = vi.fn<typeof globalThis.fetch>()
    const construction = createAgentRuntime({ providers: [
      openAiPlugin({ id: 'first', apiKey: 'key', fetch: firstFetch }),
      anthropicPlugin({ id: 'broken', apiKey: 'key', baseUrl: 'not-an-absolute-url' }),
    ] })
    await expect(construction).rejects.toMatchObject({
      failureCode: 'CAPABILITY_STARTUP_FAILED',
      stage: 'provider-setup',
      cleanup: [expect.objectContaining({ kind: 'provider-registration', status: 'closed' })],
    })
    expect(firstFetch).not.toHaveBeenCalled()
  })

  it('forwards provider-specific gateway, wire, catalog and diagnostic options', async () => {
    const requests: Array<{
      url: string
      headers: Headers
      body: Record<string, unknown> | undefined
    }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string'
          ? JSON.parse(init.body) as Record<string, unknown>
          : undefined,
      })
      if (url.includes('/models?')) {
        return Response.json({ models: [{
          slug: 'codex-model', display_name: 'Codex Model',
          input_modalities: ['text'], context_window: 64_000,
        }] })
      }
      if (url.startsWith('https://anthropic-gateway.example.test')) {
        return sse([
          'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
          'data: {"type":"content_block_stop","index":0}',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
          'data: {"type":"message_stop"}',
        ])
      }
      return sse([
        'data: {"type":"response.created","response":{"id":"r1"}}',
        'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
      ])
    })
    const wireRecords: unknown[] = []
    const codexStore = memoryCodexCredentialStore({
      tokens: {
        id_token: jwt({}),
        access_token: jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh',
      },
    })
    const runtime = await createAgentRuntime({ providers: [
      openAiPlugin({
        id: 'openai-options', defaultModel: 'openai-model', apiKey: 'openai-key',
        baseUrl: 'https://openai-gateway.example.test/v1', organization: 'org-a',
        project: 'project-a', store: true, models: [{ id: 'openai-model' }],
        defaultMaxTokens: 256, defaultContextWindow: 32_000,
        streamIdleTimeoutMs: 1_000, requestTimeoutMs: 2_000,
        maxRequestBytes: 8_192, maxResponseBytes: 8_192, maxResponseChunks: 16,
        maxSseEvents: 16, maxSseEventChars: 4_096, maxErrorBodyBytes: 1_024,
        requestLoggerTimeoutMs: 100, retryPolicy: { mode: 'normal', maxRetries: 1 },
        requestLogger: record => { wireRecords.push(record) }, fetch,
      }),
      anthropicPlugin({
        id: 'anthropic-options', defaultModel: 'claude-model', apiKey: 'anthropic-key',
        baseUrl: 'https://anthropic-gateway.example.test', version: '2026-01-01',
        beta: ['beta-a', 'beta-b'], thinkingBudgets: { off: 0, high: 1_024 },
        models: [{ id: 'claude-model' }], defaultMaxTokens: 2_048,
        maxSseEvents: 16, maxSseEventChars: 4_096,
        requestLogger: record => { wireRecords.push(record) }, fetch,
      }),
      codexPlugin({
        id: 'codex-options', defaultModel: 'codex-model', authStore: codexStore,
        baseUrl: 'https://codex-gateway.example.test/backend-api/codex',
        originator: 'host-codex', clientVersion: 'host-version',
        maxCatalogBytes: 8_192, maxCatalogModels: 8, maxCatalogChunks: 8,
        catalogTimeoutMs: 1_000, catalogTtlMs: 10_000, catalogStaleTtlMs: 0,
        catalogFailureBackoffMs: 10, promptCacheKey: 'codex-cache-a',
        maxSseEvents: 16, maxSseEventChars: 4_096,
        requestLogger: record => { wireRecords.push(record) }, fetch,
      }),
    ] })
    try {
      await expect(runtime.agent({ id: 'openai-agent', instructions: 'Reply.',
        model: { provider: 'openai-options' }, compaction: false }).generate('hello'))
        .resolves.toMatchObject({ report: { status: 'success' } })
      await expect(runtime.agent({ id: 'anthropic-agent', instructions: 'Reply.',
        model: { provider: 'anthropic-options' }, effort: 'high', compaction: false }).generate('hello'))
        .resolves.toMatchObject({ report: { status: 'success' } })
      await expect(runtime.agent({ id: 'codex-agent', instructions: 'Reply.',
        model: { provider: 'codex-options' }, compaction: false }).generate('hello'))
        .resolves.toMatchObject({ report: { status: 'success' } })
    } finally {
      await runtime.close()
    }

    const openAi = requests.find(request => request.url.includes('openai-gateway'))
    expect(openAi).toMatchObject({
      url: 'https://openai-gateway.example.test/v1/responses',
      body: expect.objectContaining({ model: 'openai-model', store: true }),
    })
    expect(openAi?.headers.get('authorization')).toBe('Bearer openai-key')
    expect(openAi?.headers.get('openai-organization')).toBe('org-a')
    expect(openAi?.headers.get('openai-project')).toBe('project-a')

    const anthropic = requests.find(request => request.url.includes('anthropic-gateway'))
    expect(anthropic).toMatchObject({
      url: 'https://anthropic-gateway.example.test/v1/messages',
      body: expect.objectContaining({
        model: 'claude-model', thinking: { type: 'enabled', budget_tokens: 1_024 },
      }),
    })
    expect(anthropic?.headers.get('x-api-key')).toBe('anthropic-key')
    expect(anthropic?.headers.get('anthropic-version')).toBe('2026-01-01')
    expect(anthropic?.headers.get('anthropic-beta')).toBe('beta-a,beta-b')

    expect(requests.some(request => request.url ===
      'https://codex-gateway.example.test/backend-api/codex/models?client_version=host-version')).toBe(true)
    const codex = requests.find(request => request.url.endsWith('/responses')
      && request.url.includes('codex-gateway'))
    expect(codex?.headers.get('originator')).toBe('host-codex')
    expect(codex?.headers.get('session-id')).toBe('codex-cache-a')
    expect(codex?.body).toMatchObject({ model: 'codex-model', prompt_cache_key: 'codex-cache-a' })
    expect(wireRecords).toHaveLength(3)
  })
})
