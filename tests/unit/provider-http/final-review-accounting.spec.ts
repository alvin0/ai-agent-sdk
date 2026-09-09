import { describe, expect, it } from 'vitest'
import { ModelRegistry, ReasoningEffortId, validateUsageCounters, withRetry } from '@alvin0/ai-agent-sdk-core'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { createRuntimeHttpProvider, defineWireProtocol } from '@alvin0/ai-agent-sdk-provider-http'

describe('final review provider retry to terminal ledger', () => {
  it('keeps partial attempt evidence and a readable terminal report after a successful retry', async () => {
    const protocol = defineWireProtocol({
      id: 'partial-retry', defaultDialect: {}, endpointPath: () => '/stream', serialize: () => ({}),
      async *translate(events) {
        for await (const event of events) {
          if (event.data === 'partial') {
            yield { type: 'usage' as const, usage: { inputTokens: 100 } }
            yield { type: 'finish' as const, reason: { kind: 'error' as const,
              failure: { code: 'TRANSPORT', message: 'injected pre-public-chunk failure' } } }
          } else {
            yield { type: 'text-delta' as const, index: 0, text: 'done' }
            yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'done' } }
            yield { type: 'usage' as const, usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 } }
            yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
          }
        }
      },
    })
    let calls = 0
    const low = ReasoningEffortId('low')
    const adapter = createRuntimeHttpProvider({
      displayName: 'Partial retry', protocol, baseUrl: 'https://partial.invalid', auth: { kind: 'none' },
      models: [{ id: 'test', reasoning: { efforts: [{ id: low, name: 'low' }], defaultEffort: low } }],
      fetch: async () => new Response(`data: ${++calls === 1 ? 'partial' : 'full'}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    })
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], withRetry(adapter, { policy: {
      mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    } }))
    const session = defineAgent({ id: 'partial-retry', provider: 'test', model: 'test', effort: 'low',
      instructions: 'Reply.', compaction: false }).createSession({ registry })
    const handle = session.stream('go')
    await expect(handle.result).resolves.toMatchObject({ text: 'done' })
    const report = await handle.report
    expect(calls).toBe(2)
    expect(report.usage.authoritative).toBe(false)
    expect(report.modelCalls[0]?.attempts.map(attempt => attempt.reported)).toEqual([
      { inputTokens: 100 }, { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    ])
    expect(report.modelCalls[0]?.reported).toEqual({ inputTokens: 300, outputTokens: 20 })
    expect(validateUsageCounters(report.usage.reported).invalidFields).toEqual([])
    expect(report.status).toBe('success')
  })
})
