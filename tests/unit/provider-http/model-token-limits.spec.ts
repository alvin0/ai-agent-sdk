import { describe, expect, it } from 'vitest'
import { resolvedCatalogModelInfo } from '../../../packages/provider-http/src/base/transport.ts'
import {
  normalizeResolvedModelInfo, resolveCallWithModelInfo,
} from '../../../packages/core/src/runtime/model-metadata.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'

/** The transport compiles against core's published types and the check against its source; the shapes are one. */
const normalize = (provider: string, model: string, info: object, maxBytes: number) =>
  normalizeResolvedModelInfo(provider, model, info as ResolvedModelInfo, maxBytes)
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

  it('does not inherit an output ceiling that would leave no input headroom', () => {
    // A ceiling-only catalog entry (maxContextWindow 400k, maxTokens 128k) on a
    // 128k route used to resolve defaultMaxTokens 128k inside a 128k window.
    const entry = { id: 'model', maxContextWindow: 400_000, maxTokens: 128_000 }
    const withRouteDefault = resolvedCatalogModelInfo('openai', 'model', [entry], 8_192, 128_000)
    expect(withRouteDefault).toMatchObject({
      context: { contextWindow: 128_000 }, defaultMaxTokens: 8_192, maxOutputTokens: 128_000,
    })
    expect(() => normalize('openai', 'model', withRouteDefault, 100_000)).not.toThrow()

    const withoutRouteDefault = resolvedCatalogModelInfo('openai', 'model', [entry], undefined, 128_000)
    expect(withoutRouteDefault.defaultMaxTokens).toBeUndefined()
    expect(() => normalize('openai', 'model', withoutRouteDefault, 100_000)).not.toThrow()
  })

  it('drops a route window fallback that a window-less output ceiling contradicts', () => {
    // An operator catalog row with an output ceiling and no context window
    // (128k ceiling on a 128k route) used to fail every call before dispatch.
    for (const maxTokens of [128_000, 200_000]) {
      const info = resolvedCatalogModelInfo('openai', 'model', [{ id: 'model', maxTokens }], 32_000, 128_000)
      expect(info.context).toBeUndefined()
      expect(info).toMatchObject({ defaultMaxTokens: 32_000, maxOutputTokens: maxTokens })
      const normalized = normalize('openai', 'model', info, 100_000)
      expect(() => resolveCallWithModelInfo({ provider: 'openai', model: 'model' }, normalized)).not.toThrow()
    }
    // Without a route default below the ceiling, no per-request default is invented.
    const noDefault = resolvedCatalogModelInfo('openai', 'model',
      [{ id: 'model', maxTokens: 128_000 }], undefined, 128_000)
    expect(noDefault.defaultMaxTokens).toBeUndefined()
    expect(() => normalize('openai', 'model', noDefault, 100_000)).not.toThrow()
  })

  it('keeps the route window when the ceiling fits it or the model names its own window', () => {
    expect(resolvedCatalogModelInfo('openai', 'model', [{ id: 'model', maxTokens: 64_000 }], 32_000, 128_000))
      .toMatchObject({ context: { contextWindow: 128_000 }, defaultMaxTokens: 64_000 })
    // A declared window, however small, is the model's own fact and is never dropped.
    const declared = resolvedCatalogModelInfo('openai', 'model',
      [{ id: 'model', contextWindow: 32_000, maxTokens: 32_000 }], 8_192, 128_000)
    expect(declared.context?.contextWindow).toBe(32_000)
    expect(() => normalize('openai', 'model', declared, 100_000)).toThrow(/no input headroom/)
  })

  it('still rejects an explicit defaultMaxTokens without input headroom', () => {
    const info = resolvedCatalogModelInfo('openai', 'model',
      [{ id: 'model', contextWindow: 128_000, defaultMaxTokens: 128_000 }])
    expect(() => normalize('openai', 'model', info, 100_000)).toThrow(/no input headroom/)
  })
})
