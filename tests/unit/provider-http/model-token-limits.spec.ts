import { describe, expect, it } from 'vitest'
import { resolvedCatalogModelInfo } from '../../../packages/provider-http/src/base/transport.ts'
import { resolveCallWithModelInfo } from '../../../packages/core/src/runtime/model-metadata.ts'
import { codexAdapter, memoryCodexCredentialStore } from '@alvin0/ai-agent-sdk-provider-codex'

describe('catalog output defaults versus model ceilings', () => {
  it('keeps Codex discovery on the standard window even when an extended maximum is advertised', async () => {
    const accessToken = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }))}.signature`
    const adapter = codexAdapter({
      authStore: memoryCodexCredentialStore({ tokens: {
        id_token: 'e30.e30.signature', access_token: accessToken, refresh_token: 'fixture-refresh',
      } }),
      fetch: async () => Response.json({ models: ['gpt-5.6-luna', 'gpt-reserve'].map(slug => ({
        slug, context_window: 272_000, max_context_window: 872_000, input_modalities: ['text'],
      })) }),
    })
    for (const model of ['gpt-5.6-luna', 'gpt-reserve']) {
      const info = await adapter.resolveModel('codex', model)
      expect(info.context?.contextWindow).toBe(272_000)
      expect(info.context?.defaultContextWindow).toBe(272_000)
      expect(info.context?.maxContextWindow).toBe(872_000)
      expect(info.defaultMaxTokens).toBe(32_000)
      expect(info.maxOutputTokens).toBeUndefined()
    }
  })

  it('lets a Codex caller opt into the discovered extended window, but not exceed it', async () => {
    const accessToken = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 }))}.signature`
    const options = {
      authStore: memoryCodexCredentialStore({ tokens: {
        id_token: 'e30.e30.signature', access_token: accessToken, refresh_token: 'fixture-refresh',
      } }),
      fetch: async () => Response.json({ models: [{ slug: 'gpt-reserve', context_window: 272_000, max_context_window: 872_000 }] }),
    }
    expect((await codexAdapter({ ...options, defaultContextWindow: 800_000 })
      .resolveModel('codex', 'gpt-reserve')).context?.contextWindow).toBe(800_000)
    await expect(codexAdapter({ ...options, defaultContextWindow: 872_001 })
      .resolveModel('codex', 'gpt-reserve')).rejects.toThrow(/maxContextWindow/)
  })

  it('does not invent a hard ceiling from the provider fallback', () => {
    const { reasoning: _reasoning, ...info } = resolvedCatalogModelInfo('codex', 'gpt-5.6-luna', [], 32_000, 272_000)
    expect(info.defaultMaxTokens).toBe(32_000)
    expect(info.maxOutputTokens).toBeUndefined()
    expect(resolveCallWithModelInfo({ provider: 'codex', model: info.id, maxTokens: 64_000 }, info)
      .config.maxTokens).toBe(64_000)
    expect(() => resolveCallWithModelInfo({ provider: 'codex', model: info.id, maxTokens: 272_000 }, info))
      .toThrow(/combined context window/)
  })

  it('supports a modern model ceiling independently of its default budget', () => {
    const { reasoning: _reasoning, ...info } = resolvedCatalogModelInfo('openai', 'gpt-5.6-luna', [{
      id: 'gpt-5.6-luna', contextWindow: 272_000, maxTokens: 128_000, defaultMaxTokens: 32_000,
    }], 8_192, 128_000)
    expect(info).toMatchObject({ context: { contextWindow: 272_000 }, defaultMaxTokens: 32_000, maxOutputTokens: 128_000 })
    expect(resolveCallWithModelInfo({ provider: 'openai', model: info.id, maxTokens: 128_000 }, info)
      .config.maxTokens).toBe(128_000)
    expect(() => resolveCallWithModelInfo({ provider: 'openai', model: info.id, maxTokens: 128_001 }, info))
      .toThrow(/supports at most/)
  })

  it('preserves legacy catalog maxTokens as both default and ceiling', () => {
    expect(resolvedCatalogModelInfo('copilot', 'model', [{ id: 'model', maxTokens: 64_000 }], 8_192, 128_000))
      .toMatchObject({ defaultMaxTokens: 64_000, maxOutputTokens: 64_000 })
  })
})
