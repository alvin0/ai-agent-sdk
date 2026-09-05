import { describe, expect, it } from 'vitest'
import { createAgentRuntime, ModelAdapter, type GenerateOptions, type StreamChunk } from '../../../packages/core/src/index.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'

class PublicAdapter extends ModelAdapter {
  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'public-model', name: 'Public Model' }])
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: options.model }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: options.model } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('public AgentRuntime facade', () => {
  it('exposes the complete immutable composition surface without mutable owner internals', async () => {
    const adapter = new PublicAdapter()
    const runtime = await createAgentRuntime({ providers: [{
      kind: 'model-provider-plugin', apiVersion: 1, id: 'public-plugin', family: 'public-family',
      displayName: 'Public Provider', routes: ['public'], defaultModel: { provider: 'public', id: 'public-model' },
      setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['public'], adapter) },
    }] })
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.keys(runtime).sort()).toEqual([
      'agent', 'close', 'diagnostics', 'logger', 'modelCatalog', 'providers', 'team',
    ])
    expect(runtime).not.toHaveProperty('registry')
    expect(runtime).not.toHaveProperty('operations')
    expect(runtime.providers()).toMatchObject([{ route: 'public', pluginId: 'public-plugin' }])
    await expect(runtime.modelCatalog('public')).resolves.toMatchObject({
      state: 'fresh', provider: { family: 'public-family' }, models: [{ id: 'public-model' }],
    })
    const agent = runtime.agent({ id: 'public-agent', instructions: 'Answer.', compaction: false })
    await expect(agent.generate('go')).resolves.toMatchObject({ text: 'public-model' })
    const team = runtime.team({ id: 'public-team', members: [{ name: 'lead', agent }] })
    expect(team.memberNames).toEqual(['lead'])
    await expect(team.run('lead', 'go')).resolves.toMatchObject({ text: 'public-model' })
    await expect(runtime.close()).resolves.toMatchObject({ state: 'closed' })
  })
})
