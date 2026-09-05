/** Full basic-agent Worker entry using the audit-only target composition shape. */

import {
  createAgentRuntime,
  ModelAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type ModelProviderRegistrar,
  type ResolvedModelInfo,
  type StreamChunk,
} from '@ai-agent-sdk/core'

class BenchmarkAdapter extends ModelAdapter {
  calls = 0

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'text-delta', index: 0, text: 'worker-ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'worker-ok' } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const low = ReasoningEffortId('low')
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: low, name: 'low' }], defaultEffort: low },
    })
  }
}

export default {
  async fetch(): Promise<Response> {
    Reflect.set(globalThis, 'Buffer', undefined)
    Reflect.set(globalThis, 'process', undefined)
    const adapter = new BenchmarkAdapter()
    const runtime = await createAgentRuntime({
      providers: [{
        kind: 'model-provider-plugin', apiVersion: 1,
        id: 'worker-benchmark', family: 'worker-benchmark',
        displayName: 'Worker benchmark', routes: ['worker-benchmark'],
        defaultModel: { provider: 'worker-benchmark', id: 'fixture-model' },
        setup(registrar: ModelProviderRegistrar) {
          registrar.registerAdapter(['worker-benchmark'], adapter)
        },
      }],
      diagnosticMaxEvents: 32,
      closeTimeoutMs: 5_000,
    })
    const agent = runtime.agent({
      id: 'worker-agent', model: { provider: 'worker-benchmark' },
      effort: 'low',
      instructions: 'Return the fixture response.',
      compaction: false,
    })
    let totalTokens = 0
    for (let index = 0; index < 64; index++) {
      const response = await agent.generate(`run-${index}`)
      totalTokens += response.report.usage.reported.totalTokens ?? 0
      if (response.text !== 'worker-ok') throw new Error('unexpected worker response')
      // Give the DevTools inspector a task boundary every four runs so its
      // sampler can observe growth during this synthetic stress request.
      if (index % 4 === 3) await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    }
    const diagnostics = runtime.diagnostics()
    const close = await runtime.close()
    const globals = globalThis as unknown as Record<string, unknown>
    return Response.json({
      calls: adapter.calls,
      totalTokens,
      diagnosticEvents: diagnostics?.events.length,
      evictedEvents: diagnostics?.evictedEvents,
      closeState: close.state,
      deadlineReached: close.deadlineReached,
      buffer: typeof globals.Buffer,
      process: typeof globals.process,
    })
  },
}
