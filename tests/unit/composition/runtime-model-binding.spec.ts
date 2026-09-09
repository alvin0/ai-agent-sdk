import { describe, expect, it } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { ReasoningEffortId } from '../../../packages/core/src/primitives/brand.ts'
import { createAgentRuntime } from '../../../packages/core/src/index.ts'

class BindingAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RETRY_BINDING', message: 'retry' } } }
      return
    }
    const text = `bound:${options.provider}/${options.model}`
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id, name: id,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }
}

describe('runtime model binding continuity', () => {
  it('keeps captured provider defaults through mutation, retry, snapshot/resume and report evidence', async () => {
    const adapter = new BindingAdapter()
    const defaultModel = { provider: 'account-route', id: 'captured-default' }
    const routes = ['account-route']
    const plugin = { kind: 'model-provider-plugin' as const, apiVersion: 1 as const,
      id: 'account-instance', family: 'openai', displayName: 'Account Instance', routes, defaultModel,
      setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['account-route'], adapter) } }
    const runtime = await createAgentRuntime({ providers: [plugin], defaultProvider: 'account-route' })
    defaultModel.id = 'mutated-default'
    routes[0] = 'mutated-route'

    const agent = runtime.agent({ id: 'binding-agent', model: { provider: 'account-route' },
      instructions: 'Keep the target.', compaction: false })
    expect(agent.model).toEqual({ provider: 'account-route', id: 'captured-default' })
    const session = agent.createSession({ hooks: { onRequestError: () => 'retry' } })
    const first = await session.run('first')
    expect(adapter.requests.slice(0, 2).map(request => [request.provider, request.model]))
      .toEqual([['account-route', 'captured-default'], ['account-route', 'captured-default']])
    expect(first.report.modelCalls.map(call => [call.provider, call.model]))
      .toEqual([['account-route', 'captured-default'], ['account-route', 'captured-default']])

    const snapshot = JSON.parse(JSON.stringify(session.snapshot())) as ReturnType<typeof session.snapshot>
    const resumed = agent.resumeSession(snapshot)
    const second = await resumed.run('second')
    expect(adapter.requests[2]).toMatchObject({ provider: 'account-route', model: 'captured-default' })
    expect(second.report.modelCalls).toMatchObject([{ provider: 'account-route', model: 'captured-default' }])
    expect(runtime.providers()).toMatchObject([{ route: 'account-route', defaultModel: { id: 'captured-default' } }])
    await runtime.close()
  })
})
