import { describe, expect, it } from 'vitest'
import {
  ModelAdapter,
  ModelRegistry,
  ReasoningEffortId,
  ToolCallId,
  createCoreSpan,
  type GenerateOptions,
  type ObservationEvent,
  type ObservationPort,
  type ResolvedModelInfo,
  type StreamChunk,
} from '@ai-agent-sdk/core'
import { AgentRunError } from '@ai-agent-sdk/agent'
import { defineAgent } from '@ai-agent-sdk/agent'
import { defineTool } from '@ai-agent-sdk/agent'
import { fixedApprovalBroker } from '@ai-agent-sdk/agent'

class ScriptedAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const low = ReasoningEffortId('low')
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: low, name: 'low' }], defaultEffort: low },
    })
  }
}

function registryFor(rounds: readonly (readonly StreamChunk[])[]) {
  const adapter = new ScriptedAdapter(rounds)
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  return { adapter, registry }
}

function textRound(text: string, usage?: { inputTokens: number; outputTokens: number; totalTokens: number }): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...usage === undefined ? [] : [{ type: 'usage', usage } as const],
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolRound(): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: ToolCallId('lookup-1'), name: 'lookup', arguments: '{}',
    } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function sessionFor(registry: ModelRegistry, options: Parameters<ReturnType<typeof defineAgent>['createSession']>[0] extends infer T ? Omit<T, 'registry'> : never = {}) {
  return defineAgent({
    id: 'accounted-agent', provider: 'test', model: 'scripted', effort: 'low',
    instructions: 'Answer precisely.', compaction: false,
  }).createSession({ registry, ...options })
}

describe('agent run handle and usage contract', () => {
  it('returns one canonical report from both handle.result and AgentResponse', async () => {
    const state = registryFor([textRound('done', { inputTokens: 4, outputTokens: 2, totalTokens: 6 })])
    const handle = sessionFor(state.registry).stream('go')
    const response = await handle.result
    const report = await handle.report

    expect(response.report).toBe(report)
    expect(response.outcome.usage).toEqual({ inputTokens: 4, outputTokens: 2, totalTokens: 6 })
    expect(report.usage).toMatchObject({ authoritative: true, reported: { totalTokens: 6 } })
    expect(report.operationCounts.turn).toMatchObject({ total: 1, success: 1 })
    expect(report.operationCounts.skill).toMatchObject({ total: 1, success: 1 })
  })

  it('never projects missing provider usage as an exact zero', async () => {
    const state = registryFor([textRound('unknown')])
    const response = await sessionFor(state.registry).run('go')

    expect(response.outcome.usage).toBeUndefined()
    expect(response.outcome.usageReport).toMatchObject({
      authoritative: false,
      reported: {},
      coverage: { logicalCalls: 1, missing: 1, possiblyBilledAttemptsWithoutUsage: 1 },
    })
    expect(response.report.errors).toContainEqual(expect.objectContaining({ code: 'USAGE_MISSING' }))
  })

  it('stops before another dispatch when warn policy meets an explicit cumulative budget', async () => {
    const state = registryFor([toolRound(), textRound('must not dispatch')])
    const lookup = defineTool({
      name: 'lookup', description: 'Lookup.', parameters: { type: 'object' }, execute: () => ({ ok: true }),
    })
    const session = defineAgent({
      id: 'budget-agent', provider: 'test', model: 'scripted', effort: 'low',
      instructions: 'Use the lookup.', tools: [lookup], compaction: false,
    }).createSession({ registry: state.registry, runtimeLimits: { maxTotalTokens: 100 } })

    const response = await session.run('go')
    expect(response.outcome.reason).toMatchObject({ kind: 'usage-unavailable' })
    expect(state.adapter.requests).toHaveLength(1)
  })

  it('uses estimates only for missing budget portions while keeping them non-authoritative', async () => {
    const state = registryFor([toolRound(), textRound('must not dispatch')])
    const lookup = defineTool({
      name: 'lookup', description: 'Lookup.', parameters: { type: 'object' }, execute: () => ({ ok: true }),
    })
    const session = defineAgent({
      id: 'estimated-budget-agent', provider: 'test', model: 'scripted', effort: 'low',
      instructions: 'Use the lookup.', tools: [lookup], compaction: false,
    }).createSession({
      registry: state.registry,
      runtimeLimits: { maxTotalTokens: 100 },
      usagePolicy: {
        onMissing: 'estimate',
        estimator: { id: 'test-estimator', estimate: () => ({ inputTokens: 90, outputTokens: 10, totalTokens: 100 }) },
      },
    })

    const response = await session.run('go')
    expect(response.outcome.reason).toEqual({
      kind: 'budget-exhausted', budget: 'tokens', forcedFinalAnswer: false,
    })
    expect(response.outcome.usage).toBeUndefined()
    expect(response.outcome.usageReport).toMatchObject({
      reported: {}, estimated: { totalTokens: 100 }, authoritative: false,
    })
    expect(state.adapter.requests).toHaveLength(1)
  })

  it('allows warn policy to continue when no cumulative token budget is configured', async () => {
    const state = registryFor([toolRound(), textRound('continued')])
    const lookup = defineTool({
      name: 'lookup', description: 'Lookup.', parameters: { type: 'object' }, execute: () => ({ ok: true }),
    })
    const session = defineAgent({
      id: 'warn-agent', provider: 'test', model: 'scripted', effort: 'low',
      instructions: 'Use the lookup.', tools: [lookup], compaction: false,
    }).createSession({ registry: state.registry })

    const response = await session.run('go')
    expect(response.text).toBe('continued')
    expect(response.outcome.usage).toBeUndefined()
    expect(state.adapter.requests).toHaveLength(2)
  })

  it('preserves the finalized report when fail policy rejects missing usage', async () => {
    const state = registryFor([textRound('provider response completed')])
    const handle = sessionFor(state.registry, { usagePolicy: { onMissing: 'fail' } }).stream('go')

    const report = await handle.report
    await expect(handle.result).rejects.toMatchObject({
      name: 'AgentRunError', code: 'USAGE_REQUIRED', runId: handle.runId, report,
    })
    await handle.result.catch(error => expect(error).toBeInstanceOf(AgentRunError))
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'USAGE_REQUIRED' }))
  })

  it('uses one strictly increasing observation sequence across run and model events', async () => {
    const state = registryFor([textRound('observed', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })])
    const events: ObservationEvent[] = []
    const observation: ObservationPort = {
      mode: 'operational',
      openSpan: input => createCoreSpan(input),
      capture: event => {
        events.push(event)
        return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
      },
    }
    await sessionFor(state.registry, { observation }).run('go')

    expect(events.some(event => event.name === 'sdk.agent.run')).toBe(true)
    expect(events.some(event => event.name === 'sdk.model.call')).toBe(true)
    expect(events.map(event => event.sequence)).toEqual(
      [...events.map(event => event.sequence)].sort((left, right) => left - right),
    )
    expect(new Set(events.map(event => event.sequence)).size).toBe(events.length)
  })

  it('closes tool, hook, and approval-wait operations exactly once', async () => {
    const state = registryFor([
      [
        ...toolRound().slice(0, -1),
        { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      textRound('done', { inputTokens: 3, outputTokens: 1, totalTokens: 4 }),
    ])
    const lookup = defineTool({
      name: 'lookup', description: 'Lookup.', parameters: { type: 'object' }, execute: () => ({ ok: true }),
    })
    const session = defineAgent({
      id: 'operation-agent', provider: 'test', model: 'scripted', effort: 'low',
      instructions: 'Use the lookup.', tools: [lookup], compaction: false,
    }).createSession({
      registry: state.registry,
      approvals: fixedApprovalBroker('allow'),
      interceptors: [{ name: 'approval', before: async () => ({ kind: 'ask' }) }],
      hooks: { beforeStep: () => ({ kind: 'proceed' }) },
    })

    const response = await session.run('go')
    expect(response.report.operationCounts.tool).toMatchObject({ total: 1, success: 1, unknown: 0 })
    expect(response.report.operationCounts.hook).toMatchObject({ total: 2, success: 2, unknown: 0 })
    expect(response.report.operationCounts['user-input']).toMatchObject({ total: 1, success: 1, unknown: 0 })
  })

  it('preserves the report but fails closed when an audit terminal checkpoint is rejected', async () => {
    const state = registryFor([textRound('done', { inputTokens: 1, outputTokens: 1, totalTokens: 2 })])
    const observation: ObservationPort = {
      mode: 'audit',
      openSpan: input => createCoreSpan(input),
      capture: event => ({ eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }),
      checkpoint: event => Promise.resolve({
        eventId: event.eventId, status: 'rejected', durable: false, boundary: 'none', reason: 'exporter-unavailable',
      }),
    }
    const handle = sessionFor(state.registry, { observation }).stream('go')
    const report = await handle.report

    expect(report.delivery.complete).toBe(false)
    await expect(handle.result).rejects.toMatchObject({
      name: 'AgentRunError', code: 'OBSERVABILITY_AUDIT_UNAVAILABLE', report,
    })
  })

  it('finalizes an aborted report when the public event consumer stops', async () => {
    class BlockingAdapter extends ModelAdapter {
      override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
        const low = ReasoningEffortId('low')
        return Promise.resolve({
          provider, id: model, name: model,
          reasoning: { efforts: [{ id: low, name: 'low' }], defaultEffort: low },
        })
      }
      async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      }
    }
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], new BlockingAdapter())
    const handle = sessionFor(registry).stream('go')
    for await (const event of handle) {
      if (event.type === 'text-delta') break
    }

    const report = await handle.report
    expect(report.status).toBe('aborted')
    await expect(handle.result).rejects.toMatchObject({ name: 'AgentRunError', report })
  })
})
