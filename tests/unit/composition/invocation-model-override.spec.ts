/**
 * Per-invocation model selection.
 *
 * The agent's bound target stays the agent's identity; an invocation may aim
 * ONE run somewhere else. The claims worth pinning are the ones a future
 * refactor could silently lose:
 *
 * 1. The override reaches the wire and does not outlive its run.
 * 2. It is resolved against the SAME configured routes as the binding, with the
 *    same codes, and BEFORE any I/O — a bad target costs nothing.
 * 3. Switching model drops the agent's inherited effort and output ceiling: an
 *    effort belongs to the model that offered it, and effort is pure
 *    pass-through now — the SDK has no ladder to carry it against.
 * 4. Effort has NO per-invocation override: it is set once, on the agent, and
 *    an invocation cannot change it — only defining a different agent can.
 */

import { describe, expect, it } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { ReasoningEffortId } from '../../../packages/core/src/primitives/brand.ts'
import { MODEL_BINDING_ERROR_CODES } from '../../../packages/core/src/composition/common/config.ts'
import { createAgentRuntime } from '../../../packages/core/src/index.ts'

/** Advisory efforts each model declares; display metadata only, never enforced. */
const LADDERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'luna-like': Object.freeze(['low', 'medium', 'high']),
  'reserve-like': Object.freeze(['medium', 'max']),
  'no-ladder': Object.freeze([]),
})

class RecordingAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = `${options.provider}/${options.model}@${String(options.reasoningEffort ?? 'none')}`
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const efforts = (LADDERS[id] ?? []).map(effort => ({ id: ReasoningEffortId(effort), name: effort }))
    return Promise.resolve({
      provider, id, name: id, maxOutputTokens: 4_096, context: { contextWindow: 128_000 },
      ...(efforts.length === 0 ? {} : { reasoning: { efforts } }),
    })
  }
}

function plugin(id: string, routes: readonly string[], adapter: ModelAdapter, defaultModel?: { provider: string; id: string }) {
  return {
    kind: 'model-provider-plugin' as const, apiVersion: 1 as const, id, family: 'openai',
    displayName: id, routes: [...routes],
    ...(defaultModel === undefined ? {} : { defaultModel }),
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter([...routes], adapter) },
  }
}

async function runtimeWithTwoRoutes() {
  const adapter = new RecordingAdapter()
  const runtime = await createAgentRuntime({
    providers: [
      plugin('primary', ['primary'], adapter, { provider: 'primary', id: 'luna-like' }),
      plugin('secondary', ['secondary'], adapter, { provider: 'secondary', id: 'reserve-like' }),
    ],
    defaultProvider: 'primary',
  })
  return { adapter, runtime }
}

describe('per-invocation model selection', () => {
  it('aims one run at another model without changing the agent or the next run', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const agent = runtime.agent({ id: 'switcher', model: { provider: 'primary', id: 'luna-like' },
      effort: 'high', instructions: 'Answer.', compaction: false })
    const session = agent.createSession()

    const bound = await session.run('one')
    const moved = await session.run('two', { model: { provider: 'secondary', id: 'reserve-like' } })
    const back = await session.run('three')

    expect(adapter.requests.map(request => [request.provider, request.model, request.reasoningEffort])).toEqual([
      ['primary', 'luna-like', 'high'],
      // Effort belongs to the agent's own model; a model switch drops it.
      ['secondary', 'reserve-like', undefined],
      ['primary', 'luna-like', 'high'],
    ])
    // The binding is the agent's identity and an invocation never rewrites it.
    expect(agent.model).toEqual({ provider: 'primary', id: 'luna-like' })
    expect(bound.report.modelCalls.map(call => [call.provider, call.model])).toEqual([['primary', 'luna-like']])
    expect(moved.report.modelCalls.map(call => [call.provider, call.model])).toEqual([['secondary', 'reserve-like']])
    expect(back.report.modelCalls.map(call => [call.provider, call.model])).toEqual([['primary', 'luna-like']])
    await runtime.close()
  })

  it('has no per-invocation effort override: only the agent\'s own effort ever ships', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'effort-fixed', model: { provider: 'primary', id: 'luna-like' },
      effort: 'low', instructions: 'Answer.', compaction: false }).createSession()
    await session.run('one')
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'primary', model: 'luna-like', reasoningEffort: 'low' })
    await runtime.close()
  })

  it('drops the inherited effort when the model changes, and keeps maxTokens when restated', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'ladders', model: { provider: 'primary', id: 'luna-like' },
      effort: 'high', maxTokens: 2_048, instructions: 'Answer.', compaction: false }).createSession()

    // Effort is pure pass-through and has no per-invocation override, so a model
    // switch always drops the agent's effort — there is nothing to restate it with.
    await session.run('one', { model: { provider: 'secondary', id: 'reserve-like' } })
    const dropped = adapter.requests.at(-1)!
    expect(dropped.model).toBe('reserve-like')
    expect(dropped.reasoningEffort).toBeUndefined()
    expect(dropped.maxTokens).toBeUndefined()

    // maxTokens keeps its per-invocation override.
    await session.run('two', { model: { provider: 'secondary', id: 'reserve-like' }, maxTokens: 512 })
    const restated = adapter.requests.at(-1)!
    expect(restated).toMatchObject({ model: 'reserve-like', maxTokens: 512 })
    expect(restated.reasoningEffort).toBeUndefined()
    await runtime.close()
  })

  it('takes the route default for a route-only override', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'route-only', model: { provider: 'primary', id: 'luna-like' },
      instructions: 'Answer.', compaction: false }).createSession()
    await session.run('one', { model: { provider: 'secondary' } })
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'secondary', model: 'reserve-like' })
    await runtime.close()
  })

  it('rejects an unusable target before any provider traffic', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'guarded', model: { provider: 'primary', id: 'luna-like' },
      instructions: 'Answer.', compaction: false }).createSession()

    await expect(session.run('one', { model: { provider: 'nowhere', id: 'x' } }))
      .rejects.toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.UNKNOWN_ROUTE }))
    expect(() => session.stream('one', { model: { provider: 'nowhere', id: 'x' } }))
      .toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.UNKNOWN_ROUTE }))
    await expect(session.run('one', { model: { provider: 'primary', id: '' } }))
      .rejects.toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.INVALID }))
    // Nothing was dispatched, and the session is still usable afterwards.
    expect(adapter.requests).toHaveLength(0)
    expect(session.isRunning).toBe(false)
    await session.run('one')
    expect(adapter.requests).toHaveLength(1)
    await runtime.close()
  })

  it('reports a route with no configured default instead of borrowing another one', async () => {
    const adapter = new RecordingAdapter()
    const runtime = await createAgentRuntime({
      providers: [
        plugin('primary', ['primary'], adapter, { provider: 'primary', id: 'luna-like' }),
        plugin('bare', ['bare'], adapter),
      ],
      defaultProvider: 'primary',
    })
    const session = runtime.agent({ id: 'bare-route', model: { provider: 'primary', id: 'luna-like' },
      instructions: 'Answer.', compaction: false }).createSession()
    await expect(session.run('one', { model: { provider: 'bare' } }))
      .rejects.toThrow(expect.objectContaining({ code: MODEL_BINDING_ERROR_CODES.MISSING_DEFAULT }))
    expect(adapter.requests).toHaveLength(0)
    await runtime.close()
  })

  it('carries an agent-tier contextWindow/inputModalities through every invocation, even across a model switch', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'capacity', model: { provider: 'primary', id: 'luna-like' },
      contextWindow: 64_000, inputModalities: ['text'],
      instructions: 'Answer.', compaction: false }).createSession()

    await session.run('one')
    // Unlike effort/maxTokens, contextWindow/inputModalities describe the
    // agent's own configuration, not a specific model's ladder, so a model
    // switch does not drop them.
    await session.run('two', { model: { provider: 'secondary', id: 'reserve-like' } })

    expect(adapter.requests.map(request => [request.contextWindow, request.inputModalities])).toEqual([
      [64_000, ['text']],
      [64_000, ['text']],
    ])
    await runtime.close()
  })

  it('rejects unsupported invocation fields rather than ignoring them, including a removed effort override', async () => {
    const { runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'strict-fields', model: { provider: 'primary', id: 'luna-like' },
      instructions: 'Answer.', compaction: false }).createSession()
    await expect(session.run('one', { provider: 'secondary' } as never)).rejects.toThrow(TypeError)
    await expect(session.run('one', { maxTokens: 0 } as never)).rejects.toThrow(TypeError)
    // Effort has no per-invocation override anymore: only the agent definition sets it.
    await expect(session.run('one', { effort: 'high' } as never)).rejects.toThrow(TypeError)
    await runtime.close()
  })
})
