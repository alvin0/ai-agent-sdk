import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ModelInvocationContext } from '../../../packages/core/src/observation/report.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import type { ApprovalDecision } from '../../../packages/core/src/agent/tool/approval.ts'
import { ToolCallId } from '../../../packages/core/src/primitives/brand.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { defineTool } from '../../../packages/core/src/agent/tool/definition.ts'
import type { ToolExecutionResult } from '../../../packages/core/src/agent/tool/definition.ts'
import type { PostToolDecision, PreToolDecision, ToolInterceptor } from '../../../packages/core/src/agent/tool/pipeline.ts'
import type { TurnHooks } from '../../../packages/core/src/agent/loop/events.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'

class PolicyAdapter extends ModelAdapter {
  calls = 0
  beforeFinish?: () => void
  async * stream(_options: GenerateOptions, _context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    this.calls++
    if (this.calls === 1) {
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('policy-call'), name: 'work', arguments: '{}',
      } }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    this.beforeFinish?.()
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class MissingUsageAdapter extends ModelAdapter {
  calls = 0
  beforeFinish?: () => void
  async * stream(): AsyncIterable<StreamChunk> {
    this.calls++
    this.beforeFinish?.()
    yield { type: 'text-delta', index: 0, text: 'estimated' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'estimated' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class RetryPolicyAdapter extends ModelAdapter {
  calls = 0
  async * stream(): AsyncIterable<StreamChunk> {
    this.calls++
    if (this.calls === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RETRY_ONCE', message: 'retry once' } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'retried' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'retried' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class UserInputPolicyAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: ToolCallId('human-policy-call'), name: 'request_user_input',
      arguments: JSON.stringify({ questions: [{
        id: 'choice', header: 'Choice', question: 'Which option?', options: [
          { label: 'A', description: 'Choose A.' }, { label: 'B', description: 'Choose B.' },
        ],
      }] }),
    } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function plugin(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'policy-provider', displayName: 'Policy Provider',
    routes: ['policy'], defaultModel: { provider: 'policy', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['policy'], adapter) },
  }
}

describe('runtime agent policy capture', () => {
  it('keeps the captured approval method while the original broker is parked', async () => {
    const adapter = new PolicyAdapter(), execute = vi.fn(() => ({ ok: true }))
    let answer!: (decision: 'allow' | 'deny' | 'abort') => void
    const parked = new Promise<void>(resolve => {
      answer = () => undefined
      void resolve
    })
    let entered!: () => void
    const requested = new Promise<void>(resolve => { entered = resolve })
    const broker = {
      request: vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<'allow' | 'deny' | 'abort'>(resolve => {
        answer = resolve
        signal?.addEventListener('abort', () => resolve('abort'), { once: true })
        entered()
      })),
    }
    void parked
    const replacement = vi.fn(() => Promise.resolve<'deny'>('deny'))
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    const session = runtime.agent({ id: 'approval-capture', instructions: 'Use work', tools: [
      defineTool({ name: 'work', description: 'Work', parameters: { type: 'object' }, execute }),
    ], compaction: false }).createSession({
      approvals: broker,
      interceptors: [{ name: 'approval', before: async () => ({ kind: 'ask' }) }],
    })
    const pending = session.run('go')
    await requested
    broker.request = replacement
    answer('allow')
    await pending
    expect(execute).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('captures all interceptor and hook stages before the run starts', async () => {
    const adapter = new PolicyAdapter(), around = vi.fn(async (_call: unknown, next: () => Promise<ToolExecutionResult>) => await next())
    const aroundReplacement = vi.fn(async (_call: unknown, next: () => Promise<ToolExecutionResult>) => await next())
    const after = vi.fn(async (_call: unknown, _result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => await next())
    const afterReplacement = vi.fn(async (_call: unknown, _result: ToolExecutionResult, next: () => Promise<PostToolDecision>) => await next())
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const beforeEntered = new Promise<void>(resolve => { entered = resolve })
    const before = vi.fn(async (_call: unknown, next: () => Promise<PreToolDecision>) => { entered(); await gate; return await next() })
    const beforeReplacement = vi.fn(async (_call: unknown, next: () => Promise<PreToolDecision>) => await next())
    const interceptor = {
      name: 'captured',
      before, around, after,
    }
    const hookReplacement = vi.fn(() => ({ kind: 'proceed' as const }))
    const hooks = {
      beforeStep: vi.fn(() => {
        hooks.beforeStep = hookReplacement
        return { kind: 'proceed' as const }
      }),
    }
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    const pending = runtime.agent({ id: 'policy-capture', instructions: 'Use work', tools: [
      defineTool({ name: 'work', description: 'Work', parameters: { type: 'object' }, execute: () => ({ ok: true }) }),
    ], compaction: false }).createSession({ interceptors: [interceptor as ToolInterceptor], hooks }).run('go')
    await beforeEntered
    interceptor.before = beforeReplacement
    interceptor.around = aroundReplacement
    interceptor.after = afterReplacement
    release()
    await pending
    expect(before).toHaveBeenCalledOnce()
    expect(beforeReplacement).not.toHaveBeenCalled()
    expect(around).toHaveBeenCalledOnce()
    expect(aroundReplacement).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledOnce()
    expect(afterReplacement).not.toHaveBeenCalled()
    expect(hooks.beforeStep).toBe(hookReplacement)
    expect(hookReplacement).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('captures every turn hook with its receiver before later replacement', async () => {
    const adapter = new RetryPolicyAdapter()
    const calls: string[] = []
    type MutableHooks = {
      prefix: string
      beforeStep: NonNullable<TurnHooks['beforeStep']>
      onRequestError: NonNullable<TurnHooks['onRequestError']>
      checkpoint: NonNullable<TurnHooks['checkpoint']>
      onTurnEnd: NonNullable<TurnHooks['onTurnEnd']>
    }
    const hooks: MutableHooks = {
      prefix: 'original',
      beforeStep(this: MutableHooks) { calls.push(`${this.prefix}:beforeStep`); return { kind: 'proceed' as const } },
      onRequestError(this: MutableHooks) { calls.push(`${this.prefix}:onRequestError`); return 'retry' as const },
      checkpoint(this: MutableHooks) { calls.push(`${this.prefix}:checkpoint`) },
      onTurnEnd(this: MutableHooks) { calls.push(`${this.prefix}:onTurnEnd`) },
    }
    const replacement = vi.fn(() => ({ kind: 'proceed' as const }))
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    const session = runtime.agent({ id: 'all-hooks', instructions: 'Retry', compaction: false })
      .createSession({ hooks })
    hooks.prefix = 'mutated'
    hooks.beforeStep = replacement
    hooks.onRequestError = vi.fn(() => 'fail' as const)
    hooks.checkpoint = vi.fn()
    hooks.onTurnEnd = vi.fn()
    await expect(session.run('go')).resolves.toMatchObject({ text: 'retried' })
    expect(calls).toEqual([
      'mutated:beforeStep', 'mutated:checkpoint', 'mutated:onRequestError',
      'mutated:beforeStep', 'mutated:checkpoint', 'mutated:onTurnEnd',
    ])
    expect(replacement).not.toHaveBeenCalled()
    expect(adapter.calls).toBe(2)
    await runtime.close()
  })

  it('captures the usage estimator before model completion', async () => {
    const adapter = new MissingUsageAdapter()
    const estimate = vi.fn(() => ({ inputTokens: 8, outputTokens: 2 }))
    const replacement = vi.fn(() => ({ inputTokens: 999, outputTokens: 999 }))
    const estimator = { id: 'local-estimator', estimate }
    adapter.beforeFinish = () => { estimator.estimate = replacement }
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    const response = await runtime.agent({ id: 'estimate-capture', instructions: 'Answer', compaction: false })
      .createSession({ usagePolicy: { onMissing: 'estimate', estimator } }).run('go')
    expect(estimate).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(response.usage).toMatchObject({ authoritative: false, estimated: { inputTokens: 8, outputTokens: 2 } })
    await runtime.close()
  })

  it('contains throwing policy property access before model dispatch', async () => {
    const adapter = new PolicyAdapter(), accessed = vi.fn()
    const hooks = {}
    Object.defineProperty(hooks, 'beforeStep', { get() { accessed(); throw new Error('secret getter detail') } })
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    expect(() => runtime.agent({ id: 'bad-policy', instructions: 'No dispatch', compaction: false })
      .createSession({ hooks })).toThrow(/could not be captured/)
    expect(accessed).toHaveBeenCalledOnce()
    expect(adapter.calls).toBe(0)
    await runtime.close()
  })

  it('settles a captured parked approval when runtime close cancels the run', async () => {
    const adapter = new PolicyAdapter()
    let entered!: () => void
    const requested = new Promise<void>(resolve => { entered = resolve })
    let seenSignal: AbortSignal | undefined
    const original = vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<ApprovalDecision>(resolve => {
      seenSignal = signal
      signal?.addEventListener('abort', () => resolve('abort'), { once: true })
      entered()
    }))
    const broker: { request: (_request: unknown, signal?: AbortSignal) => Promise<ApprovalDecision> } = { request: original }
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    const session = runtime.agent({ id: 'approval-close', instructions: 'Use work', tools: [
      defineTool({ name: 'work', description: 'Work', parameters: { type: 'object' }, execute: () => ({ ok: true }) }),
    ], compaction: false }).createSession({
      approvals: broker,
      interceptors: [{ name: 'approval', before: async () => ({ kind: 'ask' }) }],
    })
    const pending = session.run('go')
    void pending.catch(() => undefined)
    await requested
    broker.request = vi.fn(() => Promise.resolve<'deny'>('deny'))
    const close = runtime.close()
    await expect(pending).rejects.toMatchObject({ report: { status: 'aborted' } })
    await expect(close).resolves.toMatchObject({ state: 'closed', quiescenceEnd: 'settled', unsettledRuns: 0 })
    expect(original).toHaveBeenCalledOnce()
    expect(seenSignal?.aborted).toBe(true)
  })

  it('settles a captured parked user-input request when runtime close cancels the run', async () => {
    const adapter = new UserInputPolicyAdapter()
    let entered!: () => void
    const requested = new Promise<void>(resolve => { entered = resolve })
    let seenSignal: AbortSignal | undefined
    const original = vi.fn((_request: unknown, signal?: AbortSignal) => new Promise<'abort'>(resolve => {
      seenSignal = signal
      signal?.addEventListener('abort', () => resolve('abort'), { once: true })
      entered()
    }))
    const broker = { request: original }
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    const session = runtime.agent({ id: 'user-input-close', instructions: 'Ask', mode: 'deep-human-in-loop',
      compaction: false }).createSession({ userInput: broker })
    const pending = session.run('go')
    void pending.catch(() => undefined)
    await requested
    broker.request = vi.fn(() => Promise.resolve<'abort'>('abort'))
    const close = runtime.close()
    await expect(pending).rejects.toMatchObject({ report: { status: 'aborted' } })
    await expect(close).resolves.toMatchObject({ state: 'closed', quiescenceEnd: 'settled', unsettledRuns: 0 })
    expect(original).toHaveBeenCalledOnce()
    expect(seenSignal?.aborted).toBe(true)
  })
})
