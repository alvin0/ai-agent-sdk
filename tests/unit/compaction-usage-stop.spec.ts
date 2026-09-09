import { describe, expect, it } from 'vitest'
import { defineAgent } from '../../packages/core/src/agent/define/definition.ts'
import { ModelAdapter } from '../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../packages/core/src/stream/chunk.ts'
import { ModelRegistry } from '../../packages/core/src/runtime/registry.ts'
import { ReasoningEffortId } from '../../packages/core/src/primitives/brand.ts'
import type { UsagePolicy } from '../../packages/core/src/agent/accounting/report.ts'
import { defineTool } from '../../packages/core/src/agent/tool/definition.ts'

class Adapter extends ModelAdapter {
  requests: string[] = []
  summaryTokens = 20
  constructor(public summary: 'missing' | 'valid' | 'error' = 'missing', readonly scenario: 'normal' | 'retry' | 'structured' = 'normal') { super() }
  override async resolveModel(provider: string, id: string) {
    const effort = ReasoningEffortId('low')
    return { provider, id, name: id, reasoning: { efforts: [{ id: effort, name: 'Low' }], defaultEffort: effort } }
  }
  async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request.model)
    const summary = request.model === 'summary'
    const text = summary ? 'Checkpoint.' : this.scenario === 'structured' ? 'Process evidence '.repeat(500) : 'Done.'
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    const tokens = summary ? this.summaryTokens : 20
    if (!summary || this.summary !== 'missing') yield { type: 'usage', usage: { inputTokens: tokens - 10, outputTokens: 10, totalTokens: tokens } }
    yield { type: 'finish', reason: !summary && this.scenario === 'retry'
      ? { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'compact and retry' } }
      : summary && this.summary === 'error'
      ? { kind: 'error', failure: { code: 'MAINTENANCE_FAILED', message: 'summary unavailable' } }
      : { kind: 'stop' } }
  }
}

function session(adapter: Adapter, usagePolicy: UsagePolicy) {
  const registry = new ModelRegistry()
  registry.registerAdapter(['fixture'], adapter)
  const value = defineAgent({ id: 'compaction-stop', provider: 'fixture', model: 'main', effort: 'low', instructions: 'Reply.',
    ...(adapter.scenario === 'structured' ? {
      outputFormat: { type: 'json_schema' as const, name: 'answer', schema: { type: 'object' as const } },
      tools: [defineTool({ name: 'lookup', description: 'Lookup', parameters: { type: 'object' }, execute: () => 'ok' })],
    } : {}),
    compaction: { auto: adapter.scenario !== 'retry', summarizationProvider: 'fixture', summarizationModel: 'summary', maxInputTokens: 100, retainTokens: 10, compactionRetries: 2 },
  }).createSession({ registry, usagePolicy, runtimeLimits: { maxTotalTokens: 100 } })
  if (adapter.scenario !== 'structured') value.inject('Prior context '.repeat(1_000))
  return value
}

describe('auto-compaction usage admission through actual AgentSession', () => {
  for (const scenario of ['normal', 'retry', 'structured'] as const) {
  it.each(['fail', 'throw', 'timeout', 'warn'] as const)(`${scenario} stops after summary: %s`, async mode => {
    const adapter = new Adapter('missing', scenario)
    const usagePolicy: UsagePolicy = mode === 'fail' || mode === 'warn' ? { onMissing: mode } : {
      onMissing: 'estimate', estimateTimeoutMs: 10, estimator: { id: mode, estimate: () => {
        if (mode === 'throw') throw new Error('estimator failed')
        return new Promise(() => {})
      } },
    }
    const handle = session(adapter, usagePolicy).stream('Go.')
    const result = await handle.result.then(value => value, error => error)
    const report = await handle.report
    expect(adapter.requests).toEqual(scenario === 'normal' ? ['summary'] : ['main', 'summary'])
    expect(report.modelCalls).toHaveLength(adapter.requests.length)
    expect(report.modelCalls.at(-1)?.model).toBe('summary')
    expect(report.usage.authoritative).toBe(false)
    if (mode === 'warn') expect(result.outcome.reason).toEqual({
      kind: 'usage-unavailable', modelCallId: report.modelCalls.at(-1)?.modelCallId,
    })
    else expect(result.code).toBe('USAGE_REQUIRED')
  })
  }

  it('does not carry the sticky stop into a later invocation', async () => {
    const adapter = new Adapter()
    const value = session(adapter, { onMissing: 'fail' })
    await expect(value.run('Go.')).rejects.toMatchObject({ code: 'USAGE_REQUIRED' })
    adapter.summary = 'valid'
    const response = await value.run('Try with valid summary usage.')
    expect(response.outcome.completed).toBe(true)
    expect(adapter.requests.at(-1)).toBe('main')
  })

  it('keeps the documented normal-turn cap separate from reported summary usage', async () => {
    const adapter = new Adapter('valid')
    adapter.summaryTokens = 120
    const response = await session(adapter, { onMissing: 'fail' }).run('Go.')
    expect(adapter.requests.filter(model => model === 'main')).toHaveLength(1)
    expect(response.outcome.usage?.totalTokens).toBe(20)
    expect(response.report.usage.reported.totalTokens).toBe(
      adapter.requests.filter(model => model === 'summary').length * 120 + 20,
    )
  })

  it.each(['valid', 'error'] as const)('preserves allowed continuation: %s', async summary => {
    const adapter = new Adapter(summary)
    const result = await session(adapter, { onMissing: 'fail' }).run('Go.')
    expect(adapter.requests.at(-1)).toBe('main')
    expect(adapter.requests.filter(model => model === 'main')).toHaveLength(1)
    expect(adapter.requests.filter(model => model === 'summary').length).toBeGreaterThan(0)
    expect(result.outcome.completed).toBe(true)
  })
})
