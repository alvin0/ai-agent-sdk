import { describe, expect, it, vi } from 'vitest'
import { openAiAdapter, openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import { anthropicAdapter } from '@alvin0/ai-agent-sdk-provider-anthropic'
import { geminiAdapter } from '@alvin0/ai-agent-sdk-provider-gemini'
import { createAgentRuntime } from '@alvin0/ai-agent-sdk-core'
import { resolvedCatalogModelInfo } from '../../../packages/provider-http/src/base/transport.ts'
import { normalizeResolvedModelInfo } from '../../../packages/core/src/runtime/model-metadata.ts'

const noNetwork = async (): Promise<Response> => { throw new Error('Unexpected network request') }
const key = { apiKey: 'fixture-only', fetch: noNetwork }

describe('standard-price context policy', () => {
  it('uses exact model policies and conservative unknown-model fallbacks', async () => {
    for (const [adapter, route, model, context] of [
      [openAiAdapter(key), 'openai', 'gpt-5.6-luna', 272_000],
      [openAiAdapter(key), 'openai', 'gpt-5.6-sol', 272_000],
      [openAiAdapter(key), 'openai', 'gpt-5.6-terra', 272_000],
      [openAiAdapter(key), 'openai', 'unknown', 128_000],
      [anthropicAdapter(key), 'anthropic', 'claude-sonnet-4-6', 1_000_000],
      [anthropicAdapter(key), 'anthropic', 'claude-haiku-4-5', 200_000],
      [geminiAdapter(key), 'gemini', 'gemini-3.1-pro-preview', 200_000],
      [geminiAdapter(key), 'gemini', 'gemini-2.5-flash', 1_000_000],
      [geminiAdapter(key), 'gemini', 'gemini-3-flash-preview', 1_000_000],
      [geminiAdapter(key), 'gemini', 'unknown', 200_000],
    ] as const) {
      expect((await adapter.resolveModel(route, model)).context?.contextWindow).toBe(context)
    }
  })

  it('allows an explicit extended window with an advisory warning and known ceiling', async () => {
    const adapter = openAiAdapter({ ...key, models: [{ id: 'gpt-5.6-luna', contextWindow: 800_000 }] })
    expect((await adapter.resolveModel('renamed-route', 'gpt-5.6-luna')).context).toEqual({
      contextWindow: 800_000, defaultContextWindow: 272_000, maxContextWindow: 1_050_000,
      standardPriceInputTokens: 272_000, pricingWarning: 'extended-context-may-cost-more',
    })
  })

  it('gives explicit model overrides priority over provider overrides and preserves smaller budgets', async () => {
    const adapter = openAiAdapter({ ...key, defaultContextWindow: 800_000,
      models: [{ id: 'gpt-5.6-luna', contextWindow: 64_000 }] })
    const info = await adapter.resolveModel('openai', 'gpt-5.6-luna')
    expect(info.context?.contextWindow).toBe(64_000)
    expect(info.context?.pricingWarning).toBeUndefined()
    expect((await openAiAdapter({ ...key, defaultContextWindow: 800_000 })
      .resolveModel('openai', 'gpt-5.6-luna')).context?.contextWindow).toBe(800_000)
  })

  it('rejects known technical overflow, without clamping', async () => {
    const adapter = openAiAdapter({ ...key, defaultContextWindow: 1_050_001 })
    await expect(async () => adapter.resolveModel('openai', 'gpt-5.6-luna')).rejects.toThrow(/maxContextWindow/)
  })

  it('does not apply official endpoint facts to a custom gateway or a lookalike model ID', async () => {
    expect((await openAiAdapter({ ...key, baseUrl: 'https://gateway.example/v1' })
      .resolveModel('openai', 'gpt-5.6-luna')).context).toEqual({ contextWindow: 128_000 })
    expect((await openAiAdapter(key).resolveModel('openai', 'gpt-5.6-luna-unverified')).context)
      .toEqual({ contextWindow: 128_000 })
  })

  it('supports custom catalog policies and rejects malformed policy numbers', () => {
    const entry = { id: 'custom', defaultContextWindow: 200_000, maxContextWindow: 1_000_000, standardPriceInputTokens: 200_000 }
    expect(resolvedCatalogModelInfo('custom', 'custom', [entry], 8_192, 128_000).context)
      .toMatchObject({ contextWindow: 200_000, maxContextWindow: 1_000_000 })
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => resolvedCatalogModelInfo('custom', 'custom', [{ ...entry, maxContextWindow: value }], 8_192, 128_000))
        .toThrow(/positive safe integer/)
    }
  })

  it('does not confuse an output ceiling with a smaller operating context', async () => {
    const { reasoning: _reasoning, ...info } = await openAiAdapter({ ...key,
      models: [{ id: 'gpt-5.6-luna', contextWindow: 64_000, maxTokens: 128_000, defaultMaxTokens: 32_000 }],
    }).resolveModel('openai', 'gpt-5.6-luna')
    expect(() => normalizeResolvedModelInfo('openai', info.id, info, 100_000)).not.toThrow()
  })

  it('enforces policy overrides through the preferred runtime plugin before dispatch', async () => {
    const models = [{ id: 'gpt-5.6-luna', contextWindow: 1_050_001 }]
    const fetch = vi.fn(noNetwork)
    const plugin = openAiPlugin({ ...key, fetch, defaultModel: 'gpt-5.6-luna', models })
    const runtime = await createAgentRuntime({ providers: [plugin], defaultProvider: 'openai' })
    try {
      const session = runtime.agent({ id: 'context-test', instructions: 'Answer briefly.' }).createSession()
      await expect(session.run('hello')).rejects.toBeDefined()
      expect(fetch).not.toHaveBeenCalled()
    } finally { await runtime.close() }
  })

  it('captures overrides when constructing the adapter', async () => {
    const models = [{ id: 'gpt-5.6-luna', contextWindow: 800_000 }]
    const adapter = openAiAdapter({ ...key, models })
    models[0]!.contextWindow = 272_000
    expect((await adapter.resolveModel('openai', 'gpt-5.6-luna')).context?.contextWindow).toBe(800_000)
  })
})
