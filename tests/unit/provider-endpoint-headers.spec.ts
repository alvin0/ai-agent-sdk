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

  it('detaches static headers and rejects collisions without silently overwriting', () => {
    const source = { 'X-Tenant': 'first' }
    const resolve = endpointHeaders(source)
    source['X-Tenant'] = 'second'
    expect(resolve()['x-tenant']).toBe('first')
    expect(() => endpointHeaders({ 'OpenAI-Organization': 'other' },
      { 'openai-organization': 'original' })).toThrow()
    expect(() => endpointHeaders({ Foo: 'a', foo: 'b' })).toThrow()
  })

  it.each(['Authorization', 'x-api-key', 'Content-Type', 'Host', 'x-ai-agent-sdk-version'])(
    'rejects reserved %s headers', name => {
      expect(() => endpointHeaders({ [name]: 'override' })).toThrow()
      expect(() => endpointHeaders(() => ({ [name]: 'override' }))()).toThrow()
    },
  )
})
