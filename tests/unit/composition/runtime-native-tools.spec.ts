import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { NativeImageGenerationTool, NativeWebSearchTool, ToolChoice } from '../../../packages/core/src/contract/tool.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'

class NativeAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  allowed?: ResolvedModelInfo['nativeTools']
  nativeArguments: unknown = { query: 'PRIVATE_NATIVE_QUERY/7f11~SENTINEL%' }
  nativeContent: unknown = [{ type: 'text', text: 'PRIVATE_NATIVE_RESULT/3a92~SENTINEL%' }]
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id, name: id, ...(this.allowed === undefined ? {} : { nativeTools: this.allowed }) })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'native-tool-call', id: 'native-1',
      name: 'web-search', status: 'completed', arguments: this.nativeArguments as never,
      content: this.nativeContent as never } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'native-provider', displayName: 'Native Provider',
    routes: ['native'], defaultModel: { provider: 'native', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['native'], adapter) },
  }
}

describe('runtime native tool binding', () => {
  it('deep-detaches config and tool choice while keeping progress outside host policy', async () => {
    const adapter = new NativeAdapter(), approvals = { request: vi.fn(() => Promise.resolve<'deny'>('deny')) }
    const interceptor = { name: 'host-only', before: vi.fn(async () => ({ kind: 'deny' as const, reason: 'host only' })) }
    const domains = ['example.com']
    const native: NativeWebSearchTool = { type: 'native', name: 'web-search', searchContextSize: 'high', allowedDomains: domains,
      userLocation: { city: 'Hanoi', country: 'VN' }, maxUses: 12 }
    const choice: { type: 'native'; name: 'web-search' | 'image-generation' } = { type: 'native', name: 'web-search' }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const agent = runtime.agent({ id: 'native-agent', instructions: 'Search', nativeTools: [native], toolChoice: choice as ToolChoice,
      compaction: false })
    domains[0] = 'mutated.invalid'
    ;(native as { searchContextSize?: string }).searchContextSize = 'low'
    choice.name = 'image-generation'
    const events: import('../../../packages/core/src/composition/agent/types.ts').RuntimeAgentRunEvent[] = []
    await agent.createSession({ approvals, interceptors: [interceptor] }).run('search', {
      onEvent: event => { events.push(event) },
    })
    expect(adapter.requests[0]?.tools?.[0]).toEqual({ type: 'native', name: 'web-search', searchContextSize: 'high',
      allowedDomains: ['example.com'], userLocation: { city: 'Hanoi', country: 'VN' }, maxUses: 12 })
    expect(adapter.requests[0]?.toolChoice).toEqual({ type: 'native', name: 'web-search' })
    const nativeEvent = events.find(event => event.type === 'assistant-native-tool')
    expect(nativeEvent).toMatchObject({ type: 'assistant-native-tool', callId: 'native-1', provider: 'native',
      input: { query: 'PRIVATE_NATIVE_QUERY/7f11~SENTINEL%' },
      output: [{ type: 'text', text: 'PRIVATE_NATIVE_RESULT/3a92~SENTINEL%' }] })
    expect(Object.isFrozen(nativeEvent)).toBe(true)
    if (nativeEvent?.type === 'assistant-native-tool') {
      expect(Object.isFrozen(nativeEvent.input)).toBe(true)
      expect(Object.isFrozen(nativeEvent.output)).toBe(true)
    }
    ;(adapter.nativeArguments as { query: string }).query = 'mutated-after-run'
    ;(adapter.nativeContent as { text: string }[])[0]!.text = 'mutated-after-run'
    expect(nativeEvent).toMatchObject({ input: { query: 'PRIVATE_NATIVE_QUERY/7f11~SENTINEL%' },
      output: [{ type: 'text', text: 'PRIVATE_NATIVE_RESULT/3a92~SENTINEL%' }] })
    expect(JSON.stringify(runtime.diagnostics())).not.toContain('PRIVATE_NATIVE_QUERY/7f11~SENTINEL%')
    expect(JSON.stringify(runtime.diagnostics())).not.toContain('PRIVATE_NATIVE_RESULT/3a92~SENTINEL%')
    expect(approvals.request).not.toHaveBeenCalled()
    expect(interceptor.before).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('omits optional native payloads that exceed the bounded public JSON envelope', async () => {
    const adapter = new NativeAdapter()
    adapter.nativeArguments = { query: 'x'.repeat(65 * 1024) }
    adapter.nativeContent = [{ type: 'extension-result', value: 'y'.repeat(65 * 1024) }]
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const events: import('../../../packages/core/src/composition/agent/types.ts').RuntimeAgentRunEvent[] = []
    await runtime.agent({ id: 'bounded-native-event', instructions: 'Search', nativeTools: [
      { type: 'native', name: 'web-search' },
    ], compaction: false }).generate('go', { onEvent: event => { events.push(event) } })
    const nativeEvent = events.find(event => event.type === 'assistant-native-tool')
    expect(nativeEvent).toMatchObject({ type: 'assistant-native-tool', callId: 'native-1', status: 'completed' })
    expect(nativeEvent).not.toHaveProperty('input')
    expect(nativeEvent).not.toHaveProperty('output')
    await runtime.close()
  })

  it('rejects accessors, cycles, callbacks, credential-like fields and unknown names before dispatch', async () => {
    const adapter = new NativeAdapter(), runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const getter = vi.fn(() => 'high')
    const accessor = { type: 'native', name: 'web-search' }
    Object.defineProperty(accessor, 'searchContextSize', { enumerable: true, get: getter })
    expect(() => runtime.agent({ id: 'accessor-native', instructions: 'No', nativeTools: [accessor as never] }))
      .toThrow(expect.objectContaining({ code: 'NATIVE_TOOL_CONFIG_INVALID' }))
    expect(getter).not.toHaveBeenCalled()

    const cyclic: Record<string, unknown> = { type: 'native', name: 'web-search' }; cyclic.userLocation = cyclic
    for (const nativeTools of [
      [cyclic],
      [{ type: 'native', name: 'web-search', callback: () => undefined }],
      [{ type: 'native', name: 'web-search', apiKey: 'secret' }],
      [{ type: 'native', name: 'unknown' }],
    ]) expect(() => runtime.agent({ id: `invalid-${String(nativeTools.length)}`, instructions: 'No', nativeTools: nativeTools as never }))
      .toThrow(expect.objectContaining({ code: 'NATIVE_TOOL_CONFIG_INVALID' }))
    expect(adapter.requests).toHaveLength(0)
    await runtime.close()
  })

  it('treats absent capability metadata as unknown and an explicit list as an allowlist', async () => {
    const unknownAdapter = new NativeAdapter(), unknownRuntime = await createRuntimeCompositionOwner({ providers: [provider(unknownAdapter)] })
    const image: NativeImageGenerationTool = { type: 'native', name: 'image-generation', format: 'webp', partialImages: 1 }
    await unknownRuntime.agent({ id: 'unknown-capability', instructions: 'Generate', nativeTools: [image], compaction: false }).generate('go')
    expect(unknownAdapter.requests).toHaveLength(1)
    await unknownRuntime.close()

    const explicitAdapter = new NativeAdapter(); explicitAdapter.allowed = ['web-search']
    const explicitRuntime = await createRuntimeCompositionOwner({ providers: [provider(explicitAdapter)] })
    const handle = explicitRuntime.agent({ id: 'explicit-capability', instructions: 'Generate', nativeTools: [image], compaction: false }).stream('go')
    await expect(handle.result).rejects.toMatchObject({ report: { status: 'error' } })
    expect(explicitAdapter.requests).toHaveLength(0)
    await explicitRuntime.close()
  })
})
