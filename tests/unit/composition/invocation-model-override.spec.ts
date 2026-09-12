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
 * 3. Switching model drops the inherited effort and output ceiling, because both
 *    belong to the model that offered them.
 * 4. Nothing here introduces failover: an unsupported effort fails the run
 *    rather than quietly landing on another model or another effort.
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
import { AgentRunError } from '../../../packages/core/src/agent/accounting/error.ts'

/** Efforts each model offers, so an override onto the wrong ladder is detectable. */
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
      ...(efforts.length === 0 ? {} : { reasoning: { efforts, defaultEffort: efforts[0]!.id } }),
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
    const moved = await session.run('two', { model: { provider: 'secondary', id: 'reserve-like' }, effort: 'max' })
    const back = await session.run('three')

    expect(adapter.requests.map(request => [request.provider, request.model, request.reasoningEffort])).toEqual([
      ['primary', 'luna-like', 'high'],
      ['secondary', 'reserve-like', 'max'],
      ['primary', 'luna-like', 'high'],
    ])
    // The binding is the agent's identity and an invocation never rewrites it.
    expect(agent.model).toEqual({ provider: 'primary', id: 'luna-like' })
    expect(bound.report.modelCalls.map(call => [call.provider, call.model])).toEqual([['primary', 'luna-like']])
    expect(moved.report.modelCalls.map(call => [call.provider, call.model])).toEqual([['secondary', 'reserve-like']])
    expect(back.report.modelCalls.map(call => [call.provider, call.model])).toEqual([['primary', 'luna-like']])
    await runtime.close()
  })

  it('changes effort alone on the agent\'s own model', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'effort-only', model: { provider: 'primary', id: 'luna-like' },
      effort: 'low', instructions: 'Answer.', compaction: false }).createSession()
    await session.run('one', { effort: 'high' })
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'primary', model: 'luna-like', reasoningEffort: 'high' })
    await runtime.close()
  })

  it('drops the inherited effort and ceiling when the model changes, and keeps them when restated', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'ladders', model: { provider: 'primary', id: 'luna-like' },
      effort: 'high', maxTokens: 2_048, instructions: 'Answer.', compaction: false }).createSession()

    // 'high' is not on the reserve-like ladder; carrying it over would fail the run.
    await session.run('one', { model: { provider: 'secondary', id: 'reserve-like' } })
    const dropped = adapter.requests.at(-1)!
    expect(dropped.model).toBe('reserve-like')
    expect(dropped.reasoningEffort).toBe('medium') // the route's own default, not the agent's 'high'
    expect(dropped.maxTokens).toBeUndefined()

    await session.run('two', { model: { provider: 'secondary', id: 'reserve-like' }, effort: 'max', maxTokens: 512 })
    expect(adapter.requests.at(-1)).toMatchObject({ model: 'reserve-like', reasoningEffort: 'max', maxTokens: 512 })
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

  it('fails the run rather than falling back when the override asks for an unsupported effort', async () => {
    const { adapter, runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'no-failover', model: { provider: 'primary', id: 'luna-like' },
      instructions: 'Answer.', compaction: false }).createSession()
    const failure = await session.run('one', { model: { provider: 'secondary', id: 'reserve-like' }, effort: 'high' })
      .then(() => undefined, (error: unknown) => error as AgentRunError)
    expect(failure).toBeInstanceOf(AgentRunError)
    expect(failure!.report.status).toBe('error')
    expect(failure!.report.errors.map(error => error.code)).toContain('UNSUPPORTED_REASONING_EFFORT')
    // No second dispatch on another model or another effort.
    expect(adapter.requests).toHaveLength(0)
    await runtime.close()
  })

  it('rejects unsupported invocation fields rather than ignoring them', async () => {
    const { runtime } = await runtimeWithTwoRoutes()
    const session = runtime.agent({ id: 'strict-fields', model: { provider: 'primary', id: 'luna-like' },
      instructions: 'Answer.', compaction: false }).createSession()
    await expect(session.run('one', { provider: 'secondary' } as never)).rejects.toThrow(TypeError)
    await expect(session.run('one', { maxTokens: 0 } as never)).rejects.toThrow(TypeError)
    await runtime.close()
  })
})
