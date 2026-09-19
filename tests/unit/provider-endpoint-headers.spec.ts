import { describe, expect, it, vi } from 'vitest'
import { createAgentRuntime, type ModelAdapter } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource, defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { openAiPlugin, openAiAdapter, openAiEmbeddingAdapter, type OpenAiProviderOptions, type OpenAiAdapterOptions } from '@alvin0/ai-agent-sdk-provider-openai'
import { anthropicPlugin, anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'
import { geminiPlugin, geminiAdapter, geminiEmbeddingAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'
import { endpointHeaders } from '@alvin0/ai-agent-sdk-provider-http'

function manual(adapterFor: (options: OpenAiAdapterOptions) => ModelAdapter) {
  return (options: OpenAiProviderOptions) => defineModelProviderPlugin({
    id: 'gateway', displayName: 'Gateway', routes: ['gateway'],
    setup(registrar) {
      const remove = registrar.registerAdapter(adapterFor({ ...options, apiKey: () => 'key' }))
      return () => { remove(); return undefined }
    },
  })
}

describe('compatible endpoint headers', () => {
  it.each([
    ['OpenAI', (options: OpenAiProviderOptions) => openAiPlugin(options), '/responses', 'authorization', 'Bearer key'],
    ['Anthropic', (options: OpenAiProviderOptions) => anthropicPlugin(options), '/v1/messages', 'x-api-key', 'key'],
    ['Gemini', (options: OpenAiProviderOptions) => geminiPlugin(options), '/interactions', 'x-goog-api-key', 'key'],
    ['OpenAI adapter', manual(openAiAdapter), '/responses', 'authorization', 'Bearer key'],
    ['Anthropic adapter', manual(anthropicAdapter), '/v1/messages', 'x-api-key', 'key'],
    ['Gemini adapter', manual(geminiAdapter), '/interactions', 'x-goog-api-key', 'key'],
  ] as const)('%s forwards dynamic headers, credentials and arbitrary model ids', async (
    _name, plugin, path, authName, authValue,
  ) => {
    let tenant = 'first'
    const headers = vi.fn(() => ({ 'X-Tenant': tenant }))
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message: 'controlled rejection' } }, { status: 400 }))
    const runtime = await createAgentRuntime({ providers: [plugin({
      id: 'gateway', baseUrl: 'http://localhost:1234/prefix',
      allowInsecureHttp: true, apiKey: defineCredentialSource({ id: 'key', resolve: () => 'key' }),
      headers, fetch, retryPolicy: { mode: 'normal', maxRetries: 0 },
    })] })
    expect(headers).not.toHaveBeenCalled()
    try {
      for (const value of ['first', 'second']) {
        tenant = value
        await runtime.agent({ id: 'agent', instructions: 'Reply.', compaction: false,
          model: { provider: 'gateway', id: 'custom-model' },
        }).generate('Hello').catch(() => undefined)
        const [url, init] = fetch.mock.calls.at(-1)!
        expect(String(url)).toBe('http://localhost:1234/prefix' + path)
        expect(new Headers(init?.headers).get('x-tenant')).toBe(value)
        expect(new Headers(init?.headers).get(authName)).toBe(authValue)
        expect(String(init?.body)).toContain('custom-model')
      }
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(headers).toHaveBeenCalledTimes(2)
    } finally { await runtime.close() }
  })

  it.each([
    ['OpenAI', (options: OpenAiProviderOptions) => openAiPlugin(options)],
    ['Anthropic', (options: OpenAiProviderOptions) => anthropicPlugin(options)],
    ['Gemini', (options: OpenAiProviderOptions) => geminiPlugin(options)],
    ['OpenAI adapter', manual(openAiAdapter)],
    ['Anthropic adapter', manual(anthropicAdapter)],
    ['Gemini adapter', manual(geminiAdapter)],
  ] as const)('%s forwards a `path` override and resolved `query` params', async (_name, plugin) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message: 'controlled rejection' } }, { status: 400 }))
    const runtime = await createAgentRuntime({ providers: [plugin({
      id: 'gateway', baseUrl: 'http://localhost:1234/deployments/x',
      allowInsecureHttp: true, apiKey: defineCredentialSource({ id: 'key', resolve: () => 'key' }),
      path: '/custom-path', query: () => ({ 'api-version': '2026-06-01' }),
      fetch, retryPolicy: { mode: 'normal', maxRetries: 0 },
    })] })
    try {
      await runtime.agent({ id: 'agent', instructions: 'Reply.', compaction: false,
        model: { provider: 'gateway', id: 'custom-model' },
      }).generate('Hello').catch(() => undefined)
      const [url] = fetch.mock.calls.at(-1)!
      expect(String(url)).toBe('http://localhost:1234/deployments/x/custom-path?api-version=2026-06-01')
    } finally { await runtime.close() }
  })

  it.each([
    ['OpenAI', (options: OpenAiProviderOptions) => openAiPlugin(options)],
    ['Anthropic', (options: OpenAiProviderOptions) => anthropicPlugin(options)],
    ['Gemini', (options: OpenAiProviderOptions) => geminiPlugin(options)],
    ['OpenAI adapter', manual(openAiAdapter)],
    ['Anthropic adapter', manual(anthropicAdapter)],
    ['Gemini adapter', manual(geminiAdapter)],
  ] as const)('%s deep-merges `body` and runs `transformRequest` last', async (_name, plugin) => {
    let requestedBody: Record<string, unknown> | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ error: { message: 'controlled rejection' } }, { status: 400 })
    })
    const runtime = await createAgentRuntime({ providers: [plugin({
      id: 'gateway', baseUrl: 'http://localhost:1234/prefix',
      allowInsecureHttp: true, apiKey: defineCredentialSource({ id: 'key', resolve: () => 'key' }),
      body: { extra: 'from-body' },
      transformRequest: (body, ctx) => ({ ...(body as Record<string, unknown>), stampedFor: ctx.model }),
      fetch, retryPolicy: { mode: 'normal', maxRetries: 0 },
    })] })
    try {
      await runtime.agent({ id: 'agent', instructions: 'Reply.', compaction: false,
        model: { provider: 'gateway', id: 'custom-model' },
      }).generate('Hello').catch(() => undefined)
      expect(requestedBody).toMatchObject({ extra: 'from-body', stampedFor: 'custom-model' })
    } finally { await runtime.close() }
  })

  it.each([
    ['OpenAI', (options: OpenAiProviderOptions) => openAiPlugin(options)],
    ['Anthropic', (options: OpenAiProviderOptions) => anthropicPlugin(options)],
    ['Gemini', (options: OpenAiProviderOptions) => geminiPlugin(options)],
    ['OpenAI adapter', manual(openAiAdapter)],
    ['Anthropic adapter', manual(anthropicAdapter)],
    ['Gemini adapter', manual(geminiAdapter)],
  ] as const)('%s carries the agent id into `headers` and `transformRequest` context', async (_name, plugin) => {
    let headerCtxAgentId: string | undefined
    let transformCtxAgentId: string | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: { message: 'controlled rejection' } }, { status: 400 }))
    const runtime = await createAgentRuntime({ providers: [plugin({
      id: 'gateway', baseUrl: 'http://localhost:1234/prefix',
      allowInsecureHttp: true, apiKey: defineCredentialSource({ id: 'key', resolve: () => 'key' }),
      headers: ctx => { headerCtxAgentId = ctx.agentId; return {} },
      transformRequest: (body, ctx) => { transformCtxAgentId = ctx.agentId; return body },
      fetch, retryPolicy: { mode: 'normal', maxRetries: 0 },
    })] })
    try {
      await runtime.agent({ id: 'named-agent', instructions: 'Reply.', compaction: false,
        model: { provider: 'gateway', id: 'custom-model' },
      }).generate('Hello').catch(() => undefined)
      expect(headerCtxAgentId).toBe('named-agent')
      expect(transformCtxAgentId).toBe('named-agent')
    } finally { await runtime.close() }
  })

  it.each([
    ['OpenAI', (options: OpenAiProviderOptions) => openAiPlugin(options)],
    ['Anthropic', (options: OpenAiProviderOptions) => anthropicPlugin(options)],
    ['Gemini', (options: OpenAiProviderOptions) => geminiPlugin(options)],
    ['OpenAI adapter', manual(openAiAdapter)],
    ['Anthropic adapter', manual(anthropicAdapter)],
    ['Gemini adapter', manual(geminiAdapter)],
  ] as const)(
    "%s lets an agent's own providerOptions win over the route's headers/body",
    async (_name, plugin) => {
      let requestedHeaders: Headers | undefined
      let requestedBody: Record<string, unknown> | undefined
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        requestedHeaders = new Headers(init?.headers)
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({ error: { message: 'controlled rejection' } }, { status: 400 })
      })
      const runtime = await createAgentRuntime({ providers: [plugin({
        id: 'gateway', baseUrl: 'http://localhost:1234/prefix',
        allowInsecureHttp: true, apiKey: defineCredentialSource({ id: 'key', resolve: () => 'key' }),
        headers: { 'x-route-only': 'route', 'x-shared': 'route' },
        body: { routeOnly: 'route', shared: 'route' },
        fetch, retryPolicy: { mode: 'normal', maxRetries: 0 },
      })] })
      try {
        await runtime.agent({ id: 'agent', instructions: 'Reply.', compaction: false,
          model: { provider: 'gateway', id: 'custom-model' },
          providerOptions: {
            headers: { 'x-shared': 'agent', 'x-agent-only': 'agent' },
            body: { shared: 'agent', agentOnly: 'agent' },
          },
        }).generate('Hello').catch(() => undefined)
        expect(requestedHeaders?.get('x-route-only')).toBe('route')
        expect(requestedHeaders?.get('x-agent-only')).toBe('agent')
        expect(requestedHeaders?.get('x-shared')).toBe('agent')
        expect(requestedBody).toMatchObject({ routeOnly: 'route', agentOnly: 'agent', shared: 'agent' })
      } finally { await runtime.close() }
    },
  )

  it.each([
    ['OpenAI', (options: OpenAiProviderOptions) => openAiPlugin(options)],
    ['Anthropic', (options: OpenAiProviderOptions) => anthropicPlugin(options)],
    ['Gemini', (options: OpenAiProviderOptions) => geminiPlugin(options)],
    ['OpenAI adapter', manual(openAiAdapter)],
    ['Anthropic adapter', manual(anthropicAdapter)],
    ['Gemini adapter', manual(geminiAdapter)],
  ] as const)(
    "%s stacks route → models[] → agent, later tier winning at each step",
    async (_name, plugin) => {
      let requestedHeaders: Headers | undefined
      let requestedBody: Record<string, unknown> | undefined
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        requestedHeaders = new Headers(init?.headers)
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({ error: { message: 'controlled rejection' } }, { status: 400 })
      })
      const runtime = await createAgentRuntime({ providers: [plugin({
        id: 'gateway', baseUrl: 'http://localhost:1234/prefix',
        allowInsecureHttp: true, apiKey: defineCredentialSource({ id: 'key', resolve: () => 'key' }),
        headers: { 'x-route-only': 'route', 'x-tier': 'route' },
        body: { routeOnly: 'route', tier: 'route' },
        models: [{
          id: 'custom-model',
          headers: { 'x-model-only': 'model', 'x-tier': 'model' },
          body: { modelOnly: 'model', tier: 'model' },
        }],
        fetch, retryPolicy: { mode: 'normal', maxRetries: 0 },
      })] })
      try {
        await runtime.agent({ id: 'agent', instructions: 'Reply.', compaction: false,
          model: { provider: 'gateway', id: 'custom-model' },
          providerOptions: { headers: { 'x-tier': 'agent' }, body: { tier: 'agent' } },
        }).generate('Hello').catch(() => undefined)
        expect(requestedHeaders?.get('x-route-only')).toBe('route')
        expect(requestedHeaders?.get('x-model-only')).toBe('model')
        expect(requestedHeaders?.get('x-tier')).toBe('agent')
        expect(requestedBody).toMatchObject({ routeOnly: 'route', modelOnly: 'model', tier: 'agent' })
      } finally { await runtime.close() }
    },
  )

  it.each([
    ['OpenAI', openAiEmbeddingAdapter, { data: [{ index: 0, embedding: [1, 0] }] }],
    ['Gemini', geminiEmbeddingAdapter, { embeddings: [{ values: [1, 0] }] }],
  ] as const)('%s embedding snapshots headers across prepared batches', async (_name, adapterFor, response) => {
    let tenant = 'first'
    const headers = vi.fn(() => ({ 'X-Tenant': tenant }))
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(response))
    const adapter = adapterFor({ apiKey: 'key', headers, fetch,
      baseUrl: 'https://gateway.example/v1', models: [{ id: 'custom-model',
        compatibilityIdentity: 'custom-space', defaultDimensions: 2 }],
    })
    const prepared = await adapter.prepareEmbeddingCall('gateway', 'custom-model', {})
    tenant = 'second'
    const batch = { provider: 'gateway', model: 'custom-model', purpose: 'retrieval-document' as const,
      truncation: 'reject' as const, items: [{ index: 0, contentParts: [{ type: 'text' as const, text: 'hello' }] }] }
    await prepared.embedBatch(batch)
    await prepared.embedBatch(batch)
    expect(headers).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-tenant')))
      .toEqual(['first', 'first'])
    await adapter.embedBatch(batch)
    expect(new Headers(fetch.mock.calls[2]![1]?.headers).get('x-tenant')).toBe('second')
  })

  const ctx = { provider: 'test' }

  it('detaches static headers and lets a caller override a default, but still rejects an intra-object duplicate', () => {
    const source = { 'X-Tenant': 'first' }
    const resolve = endpointHeaders(source)
    source['X-Tenant'] = 'second'
    expect(resolve(ctx)['x-tenant']).toBe('first')
    // Decision 12: the caller's value wins over the route's own default instead of colliding.
    expect(endpointHeaders({ 'OpenAI-Organization': 'other' },
      { 'openai-organization': 'original' })(ctx)['openai-organization']).toBe('other')
    expect(() => endpointHeaders({ Foo: 'a', foo: 'b' })).toThrow()
  })

  it.each(['Authorization', 'x-api-key', 'Host'])(
    'rejects reserved %s headers', name => {
      expect(() => endpointHeaders({ [name]: 'override' })).toThrow()
      expect(() => endpointHeaders(() => ({ [name]: 'override' }))(ctx)).toThrow()
    },
  )

  it.each(['Content-Type', 'x-ai-agent-sdk-version'])(
    'lets a caller override the SDK-set %s header (decision 12)', name => {
      expect(endpointHeaders({ [name]: 'override' })(ctx)[name.toLowerCase()]).toBe('override')
      expect(endpointHeaders(() => ({ [name]: 'override' }))(ctx)[name.toLowerCase()]).toBe('override')
    },
  )
})
