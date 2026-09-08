import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@ai-agent-sdk/core'
import { createHttpProvider } from '@ai-agent-sdk/provider-http'
import { openAiResponsesProtocol } from '@ai-agent-sdk/protocol-responses'
import { CODEX_CATALOG_POLICY } from '../../samples/chat-agents/backend/src/model-policy.ts'

describe('long-running research model metadata', () => {
  it.each([0, CODEX_CATALOG_POLICY.catalogStaleTtlMs])('handles catalogue refresh failure with stale allowance %s', async stale => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const max = ReasoningEffortId('max')
    const discoverModels = vi.fn().mockResolvedValueOnce([{ id: 'research-model', reasoning: {
      efforts: [{ id: max, name: 'Max' }], defaultEffort: max,
    } }]).mockRejectedValue(new Error('catalogue temporarily unavailable'))
    const adapter = createHttpProvider({ displayName: 'Research provider', baseUrl: 'https://provider.test',
      auth: { kind: 'none' }, protocol: openAiResponsesProtocol, discoverModels, catalogStaleTtlMs: stale })
    try {
      expect((await adapter.resolveModel('test', 'research-model')).reasoning?.defaultEffort).toBe('max')
      now += 6 * 60_000 // The normal five-minute catalogue cache has expired.
      const prepared = await adapter.prepareCall('test', 'research-model')
      expect(prepared.model.reasoning?.defaultEffort).toBe(stale === 0 ? undefined : 'max')
      now += 31 * 60_000
      expect((await adapter.resolveModel('test', 'research-model')).reasoning).toBeUndefined()
    } finally { clock.mockRestore() }
  })
})
