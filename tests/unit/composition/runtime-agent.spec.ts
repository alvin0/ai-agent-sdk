import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { ModelInvocationContext } from '../../../packages/core/src/observation/report.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { RuntimeAgentRunEvent } from '../../../packages/core/src/composition/agent/types.ts'
import { defineTool } from '../../../packages/core/src/agent/tool/definition.ts'
import { ToolCallId } from '../../../packages/core/src/primitives/brand.ts'

class RuntimeAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  readonly contexts: ModelInvocationContext[] = []
  async * stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (context !== undefined) this.contexts.push(context)
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id, name: id })
  }
}

class ToolAdapter extends RuntimeAdapter {
  override async * stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (context !== undefined) this.contexts.push(context)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('lookup-1'), name: 'lookup', arguments: '{}',
      } }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* super.stream(options, context)
  }
}

class EventSurfaceAdapter extends ModelAdapter {
  calls = 0
  async * stream(): AsyncIterable<StreamChunk> {
    this.calls++
    if (this.calls === 1) {
      yield { type: 'text-delta', index: 0, text: 'Searching', phase: 'commentary' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Searching', phase: 'commentary' } }
      yield { type: 'block-end', index: 1, block: {
        type: 'native-tool-call', id: 'native-search-1', name: 'web-search', status: 'completed',
        arguments: { query: 'runtime events' }, content: [{ type: 'text', text: 'native result' }],
      } }
      yield { type: 'block-end', index: 2, block: {
        type: 'tool-call', id: ToolCallId('host-tool-1'), name: 'lookup', arguments: '{"key":"value"}',
      } }
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'Final answer', phase: 'final-answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Final answer', phase: 'final-answer' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'account-a', displayName: 'Account A',
    family: 'openai', routes: ['openai-a'], defaultModel: { provider: 'openai-a', id: 'default-model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['openai-a'], adapter) },
  }
}

describe('runtime-bound agent', () => {
  it('resolves a configured per-route default and preserves omitted reasoning effort', async () => {
    const adapter = new RuntimeAdapter(), plugin = provider(adapter)
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin] })
    const agent = runtime.agent({ id: 'assistant', instructions: 'AGENT', compaction: false })
    expect(agent.model).toEqual({ provider: 'openai-a', id: 'default-model' })
    expect(Object.isFrozen(agent.model)).toBe(true)

    const response = await agent.generate('Hi')
    expect(response).toMatchObject({ text: 'hello', usage: { authoritative: true, reported: { totalTokens: 5 } },
      report: { kind: 'run-terminal-record', status: 'success', delivery: { mode: 'operational', complete: true } } })
    expect(response.report).toBe(response.report)
    expect(adapter.requests[0]).toMatchObject({ provider: 'openai-a', model: 'default-model' })
    expect(adapter.requests[0]).not.toHaveProperty('reasoningEffort')
    expect(adapter.contexts[0]).toMatchObject({ terminalCheckpointOwner: 'agent-run' })
    await runtime.close()
  })

  it('lets every agent independently select a full model target', async () => {
    const adapter = new RuntimeAdapter(), runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const first = runtime.agent({ id: 'first', instructions: 'First', model: { provider: 'openai-a', id: 'reasoning' }, compaction: false })
    const second = runtime.agent({ id: 'second', instructions: 'Second', model: { provider: 'openai-a' }, compaction: false })
    expect(first.model).toEqual({ provider: 'openai-a', id: 'reasoning' })
    expect(second.model).toEqual({ provider: 'openai-a', id: 'default-model' })
    await first.generate('one')
    await second.generate('two')
    expect(adapter.requests.map(request => request.model)).toEqual(['reasoning', 'default-model'])
    await runtime.close()
  })

  it('streams one ordered public projection with stable IDs and one terminal usage event', async () => {
    const adapter = new RuntimeAdapter(), runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const events: RuntimeAgentRunEvent[] = []
    const response = await runtime.agent({ id: 'streamer', instructions: 'Stream', compaction: false }).generate('go', {
      onEvent: event => { events.push(event) },
    })
    expect(events.map(event => event.type)).toEqual(['assistant-delta', 'usage'])
    expect(events.map(event => event.sequence)).toEqual([1, 2])
    expect(events.every(event => event.runId === response.runId && event.traceId === response.traceId)).toBe(true)
    expect(events[1]).toMatchObject({ type: 'usage', report: response.report })
    await runtime.close()
  })

  it('streams commentary, native progress, host tool progress, final text and terminal usage on one surface', async () => {
    const adapter = new EventSurfaceAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const events: RuntimeAgentRunEvent[] = []
    const response = await runtime.agent({ id: 'event-surface', instructions: 'Use both tools', tools: [
      defineTool({ name: 'lookup', description: 'Lookup', parameters: { type: 'object' },
        execute: () => ({ ok: true }) }),
    ], compaction: false }).generate('go', { onEvent: event => { events.push(event) } })
    expect(events.map(event => event.type)).toEqual([
      'commentary-delta', 'assistant-native-tool', 'tool-call', 'tool-result', 'assistant-delta', 'usage',
    ])
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.every(event => event.runId === response.runId && event.traceId === response.traceId)).toBe(true)
    expect(events[1]).toMatchObject({
      type: 'assistant-native-tool', callId: 'native-search-1', provider: 'openai-a', name: 'web-search',
      status: 'completed', input: { query: 'runtime events' }, output: [{ type: 'text', text: 'native result' }],
    })
    expect(events[2]).toMatchObject({ type: 'tool-call', callId: 'host-tool-1', name: 'lookup', input: { key: 'value' } })
    expect(events[3]).toMatchObject({ type: 'tool-result', callId: 'host-tool-1', name: 'lookup', status: 'completed' })
    expect(events[5]).toMatchObject({ type: 'usage', report: response.report })
    await runtime.close()
  })

  it('injects the same run-correlated logger into model, tool and hook contexts', async () => {
    const adapter = new ToolAdapter(), toolLoggers: unknown[] = [], hookLoggers: unknown[] = []
    const lookup = defineTool({ name: 'lookup', description: 'Lookup', parameters: { type: 'object' },
      execute: (_input, context) => { toolLoggers.push(context.logger); context.logger?.info('tool active'); return { ok: true } } })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const response = await runtime.agent({ id: 'logged', instructions: 'Use tool', tools: [lookup], compaction: false }).generate('go', {
      onEvent: () => undefined,
    })
    const session = runtime.agent({ id: 'hooked', instructions: 'Hook', compaction: false }).createSession({
      hooks: { beforeStep(context) { hookLoggers.push(context.logger); context.logger?.info('hook active'); return { kind: 'proceed' } } },
    })
    await session.run('hook')
    expect(adapter.contexts.every(context => context.logger !== undefined)).toBe(true)
    expect(toolLoggers[0]).toBe(adapter.contexts[0]?.logger)
    expect(hookLoggers[0]).toBe(adapter.contexts.at(-1)?.logger)
    const logs = runtime.diagnostics().events.filter(event =>
      event.name === 'sdk.log' && (event.data.message === 'tool active' || event.data.message === 'hook active'))
    expect(logs).toHaveLength(2)
    expect(logs[0]?.correlation.runId).toBe(response.runId)
    await runtime.close()
  })

  it('captures direct agent and session tool literals before later mutation', async () => {
    const adapter = new ToolAdapter(), original = vi.fn(() => ({ source: 'original' }))
    const replacement = vi.fn(() => ({ source: 'replacement' }))
    const schema = { type: 'object', properties: { stable: { type: 'boolean' } } }
    const literal = { name: 'lookup', description: 'Lookup', parameters: schema, execute: original }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const agent = runtime.agent({ id: 'captured-agent', instructions: 'Use tool', tools: [literal], compaction: false })
    literal.execute = replacement
    schema.type = 'changed'
    await agent.generate('go')
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(adapter.requests[0]?.tools?.[0]).toMatchObject({ parameters: { type: 'object' } })

    const secondAdapter = new ToolAdapter()
    const secondRuntime = await createRuntimeCompositionOwner({ providers: [provider(secondAdapter)] })
    const sessionOriginal = vi.fn(() => ({ source: 'session' }))
    const sessionLiteral = { name: 'lookup', description: 'Lookup', parameters: { type: 'object' }, execute: sessionOriginal }
    const session = secondRuntime.agent({ id: 'captured-session', instructions: 'Use tool', compaction: false })
      .createSession({ tools: [sessionLiteral] })
    sessionLiteral.execute = replacement
    await session.run('go')
    expect(sessionOriginal).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    await runtime.close()
    await secondRuntime.close()
  })

  it('keeps snapshots readable but rejects mutation and execution after close', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new RuntimeAdapter())] })
    const agent = runtime.agent({ id: 'persistent', instructions: 'Persist', compaction: false })
    const session = agent.createSession({ conversationId: 'conversation-1' })
    await session.run('first')
    const before = session.snapshot()
    await runtime.close()
    expect(session.snapshot()).toEqual(before)
    expect(() => session.inject('late')).toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSED' }))
    expect(() => session.reset()).toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSED' }))
    expect(() => agent.stream('late')).toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSED' }))
    expect(() => runtime.agent({ id: 'late', instructions: 'Late' })).toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSED' }))
  })

  it('rejects invalid run overlays before operation admission or history mutation', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new RuntimeAdapter())] })
    const session = runtime.agent({ id: 'overlay', instructions: 'Overlay', compaction: false }).createSession()
    const generation = session.snapshot().history.entries.length
    expect(() => session.stream('not admitted', { additionalInstructions: '  ' })).toThrow(expect.objectContaining({
      code: 'RUN_ADDITIONAL_INSTRUCTIONS_INVALID',
    }))
    expect(runtime.operations.activeCount).toBe(0)
    expect(session.snapshot().history.entries).toHaveLength(generation)
    await runtime.close()
  })

  it('rejects an invalid run signal before operation admission or history mutation', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new RuntimeAdapter())] })
    const session = runtime.agent({ id: 'invalid-signal', instructions: 'Signal', compaction: false }).createSession()
    const before = session.snapshot()
    expect(() => session.stream('not admitted', { signal: {} as AbortSignal })).toThrow(TypeError)
    expect(runtime.operations.activeCount).toBe(0)
    expect(session.snapshot()).toEqual(before)
    await runtime.close()
  })

  it('does not invoke accessor-backed definition fields', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new RuntimeAdapter())] })
    const read = vi.fn(() => 'secret')
    const definition = { id: 'hostile', instructions: 'safe', get model() { return read() } }
    expect(() => runtime.agent(definition as never)).toThrow('metadata must not use accessors')
    expect(read).not.toHaveBeenCalled()
    await runtime.close()
  })
})
