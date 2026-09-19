import { describe, expect, it, vi } from 'vitest'
import { openAiAdapter, openAiPlugin } from '@alvin0/ai-agent-sdk-provider-openai'
import { createAgentRuntime, ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import { resolvedCatalogModelInfo } from '../../../packages/provider-http/src/base/transport.ts'
import { normalizeResolvedModelInfo } from '../../../packages/core/src/runtime/model-metadata.ts'

const noNetwork = async (): Promise<Response> => { throw new Error('Unexpected network request') }
const key = { apiKey: 'fixture-only', fetch: noNetwork }

describe('standard-price context policy', () => {
  it('carries no hardcoded per-vendor table: an adapter reports nothing until a route or model says so', async () => {
    // No route/model config, and no distinction by baseUrl or model id: the
    // official endpoint gets no special treatment (the redesign's whole point —
    // API chính chủ chỉ là cấu hình mặc định, không phải giới hạn).
    for (const [baseUrl, model] of [
      [undefined, 'gpt-5.6-luna'],
      [undefined, 'unknown-model'],
      ['https://gateway.example/v1', 'gpt-5.6-luna'],
    ] as const) {
      const adapter = openAiAdapter({ ...key, ...(baseUrl === undefined ? {} : { baseUrl }) })
      expect((await adapter.resolveModel('openai', model)).context).toBeUndefined()
    }
  })

  it('fills the SDK constant only once resolved through the registry, never at the raw adapter', async () => {
    const adapter = openAiAdapter(key)
    // The adapter itself still reports nothing — filling gaps is the registry's
    // job (RuntimeDefaults / SDK-constant tier), not any one adapter's.
    expect((await adapter.resolveModel('openai', 'gpt-5.6-luna')).context).toBeUndefined()

    const registry = new ModelRegistry()
    registry.registerAdapter(['openai'], adapter)
    expect((await registry.resolveModelInfo('openai', 'gpt-5.6-luna')).context?.contextWindow).toBe(200_000)

    const withDefaults = new ModelRegistry({ defaults: { contextWindow: 272_000 } })
    withDefaults.registerAdapter(['openai'], adapter)
    expect((await withDefaults.resolveModelInfo('openai', 'gpt-5.6-luna')).context?.contextWindow).toBe(272_000)
  })

  it('lets an explicit model policy carry a ceiling and a pricing warning, entirely from configuration', async () => {
    const adapter = openAiAdapter({ ...key, models: [{
      id: 'gpt-5.6-luna', contextWindow: 800_000, maxContextWindow: 1_050_000, standardPriceInputTokens: 272_000,
    }] })
    expect((await adapter.resolveModel('renamed-route', 'gpt-5.6-luna')).context).toEqual({
      contextWindow: 800_000, maxContextWindow: 1_050_000,
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

  it('lets a model-level defaultContextWindow (a softer hint) still outrank the route default', async () => {
    // Route names 128_000 as its own fallback; the model names 200_000 as ITS
    // fallback, which is more specific and must win — only the model's exact
    // `contextWindow` outranks the route, not the other way around.
    const info = resolvedCatalogModelInfo(
      'custom', 'custom', [{ id: 'custom', defaultContextWindow: 200_000 }], undefined, 128_000,
    )
    expect(info.context?.contextWindow).toBe(200_000)
  })

  it('rejects known technical overflow, without clamping', async () => {
    const adapter = openAiAdapter({ ...key,
      models: [{ id: 'gpt-5.6-luna', contextWindow: 1_050_001, maxContextWindow: 1_050_000 }] })
    await expect(async () => adapter.resolveModel('openai', 'gpt-5.6-luna')).rejects.toThrow(/maxContextWindow/)
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
      models: [{ id: 'gpt-5.6-luna', contextWindow: 200_000, maxTokens: 32_000, defaultMaxTokens: 16_000 }],
    }).resolveModel('openai', 'gpt-5.6-luna')
    expect(() => normalizeResolvedModelInfo('openai', info.id, info, 100_000)).not.toThrow()
  })

  it('enforces policy overrides through the preferred runtime plugin before dispatch', async () => {
    const models = [{ id: 'gpt-5.6-luna', contextWindow: 1_050_001, maxContextWindow: 1_050_000 }]
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
