import { describe, expect, it, vi } from 'vitest'
import {
  cloneAgent, createAgentRuntime, defineAgent, ModelAdapter,
  type GenerateOptions, type StreamChunk,
} from '../../../packages/core/src/index.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'

class AuthorAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: options.model }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: options.model } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('public defineAgent overload', () => {
  it('keeps string/omitted models on the preserved DefinedAgent path', () => {
    const explicit = defineAgent({ id: 'advanced-explicit', provider: 'custom', model: 'model', instructions: 'A.' })
    const omitted = defineAgent({ id: 'advanced-omitted', instructions: 'B.' })
    expect(explicit.createSession).toBeTypeOf('function')
    expect(explicit.model).toBe('model')
    expect(omitted.createSession).toBeTypeOf('function')
    expect(omitted.model).toBe('gpt-5.6-luna')
    expect(cloneAgent(explicit, { id: 'advanced-copy' })).toMatchObject({ id: 'advanced-copy', model: 'model' })
  })

  it('creates and clones inert frozen runtime definitions without materializing effort', () => {
    const snapshot = vi.fn(() => ({ revision: 'r1', tools: [] }))
    const source = { kind: 'tool-source' as const, apiVersion: 1 as const, id: 'author-source', snapshot }
    const defined = defineAgent({ id: 'runtime-defined', model: { provider: 'account', id: 'strong-model' },
      instructions: 'Runtime.', toolSources: [source] })
    expect(Object.isFrozen(defined)).toBe(true)
    expect(defined).toMatchObject({ id: 'runtime-defined', model: { provider: 'account', id: 'strong-model' } })
    expect(defined).not.toHaveProperty('effort')
    expect(defined).not.toHaveProperty('createSession')
    expect(snapshot).not.toHaveBeenCalled()
    const cloned = cloneAgent(defined, { id: 'runtime-copy', model: { provider: 'account', id: 'fast-model' } })
    expect(cloned).toMatchObject({ id: 'runtime-copy', model: { id: 'fast-model' } })
    expect(defined).toMatchObject({ id: 'runtime-defined', model: { id: 'strong-model' } })
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('chooses the overload from model own-data before touching any capability field', () => {
    const capabilityRead = vi.fn()
    const invalid = { id: 'invalid', instructions: 'Invalid.', model: 42,
      get tools() { capabilityRead(); return [] } }
    expect(() => defineAgent(invalid as never)).toThrow(/string, a model target object, or omitted/)
    expect(capabilityRead).not.toHaveBeenCalled()
    expect(() => defineAgent({ id: 'null-model', instructions: 'Invalid.', model: null } as never)).toThrow()
    expect(() => defineAgent({ id: 'array-model', instructions: 'Invalid.', model: [] } as never)).toThrow()
  })

  it('binds a reusable runtime definition without changing its selected target', async () => {
    const adapter = new AuthorAdapter()
    const runtime = await createAgentRuntime({ providers: [{ kind: 'model-provider-plugin', apiVersion: 1,
      id: 'author-provider', displayName: 'Author', routes: ['account'],
      setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['account'], adapter) } }] })
    const definition = defineAgent({ id: 'runtime-use', model: { provider: 'account', id: 'chosen' },
      instructions: 'Use chosen.', compaction: false })
    await expect(runtime.agent(definition).generate('go')).resolves.toMatchObject({ text: 'chosen' })
    expect(adapter.requests[0]).toMatchObject({ provider: 'account', model: 'chosen' })
    await runtime.close()
  })
})
