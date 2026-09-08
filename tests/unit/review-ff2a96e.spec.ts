/**
 * Full-SDK regressions adapted from the pinned ff2a96e review, with boundary,
 * lifecycle, completion and crash controls. No paid provider calls are used.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRuntimeCompositionOwner } from '../../packages/core/src/composition/runtime/owner.ts'
import type { ComposableModelProviderPlugin } from '../../packages/core/src/composition/provider/types.ts'
import { defineAgent } from '../../packages/core/src/agent/define/definition.ts'
import { ModelAdapter } from '../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../packages/core/src/contract/model-info.ts'
import { ModelRegistry } from '../../packages/core/src/runtime/registry.ts'
import type { StreamChunk } from '../../packages/core/src/stream/chunk.ts'
import { ReasoningEffortId, ToolCallId } from '../../packages/core/src/primitives/brand.ts'
import { defineTool } from '../../packages/core/src/agent/tool/definition.ts'

type Step = { text?: string; tokens?: number; fail?: boolean; tool?: boolean; truncated?: boolean }
class Scripted extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly steps: readonly Step[]) { super() }
  override async resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const low = ReasoningEffortId('low')
    return { provider, id, name: id,
      reasoning: { efforts: [{ id: low, name: 'Low' }], defaultEffort: low } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.steps[this.requests.length]
    this.requests.push(options)
    if (step === undefined) throw new Error('Unexpected extra model request')
    if (step.tool) yield { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: ToolCallId(`call-${this.requests.length}`), name: 'lookup', arguments: '{}',
    } }
    if (step.text !== undefined) {
      yield { type: 'text-delta', index: 0, text: step.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: step.text } }
    }
    if (step.tokens !== undefined) yield { type: 'usage', usage: {
      inputTokens: step.tokens - 10, outputTokens: 10, totalTokens: step.tokens,
    } }
    yield { type: 'finish', reason: step.fail
      ? { kind: 'error', failure: { code: 'SERVER', message: 'Fixture server error' } }
      : { kind: step.truncated ? 'max-tokens' : step.tool ? 'tool-calls' : 'stop' } }
  }
}
function definition(extra: Partial<Parameters<typeof defineAgent>[0]> = {}) {
  return defineAgent({ id: 'logic-review', provider: 'fixture', model: 'mock', effort: 'low',
    instructions: 'Reply.', compaction: false, maxTurns: 3, ...extra })
}
function registry(adapter: ModelAdapter) {
  const value = new ModelRegistry()
  value.registerAdapter(['fixture'], adapter)
  return value
}
const observe = <T>(pending: Promise<T>) => pending.then(
  value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('post-response admission must honor budget and usage policy', () => {
  it('does not dispatch a structured finalizer after the known token cap', async () => {
    const adapter = new Scripted([{ text: 'Process complete', tokens: 100 }, { text: '{"ok":true}', tokens: 100 }])
    const session = definition({
      outputFormat: { type: 'json_schema', name: 'answer', schema: {
        type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false,
      } },
      tools: [defineTool({ name: 'lookup', description: 'Fixture', parameters: { type: 'object' }, execute: () => 'ok' })],
    }).createSession({ registry: registry(adapter), compaction: false, runtimeLimits: { maxTotalTokens: 100 } })
    await observe(session.run('go'))
    // Primary invariant: no second physical model dispatch. Stop representation
    // (budget outcome versus a stable error) can be agreed separately.
    expect(adapter.requests).toHaveLength(1)
  })

  it('does not let onRequestError retry override a consumed token cap', async () => {
    const adapter = new Scripted([{ tokens: 120, fail: true }, { text: 'Recovered', tokens: 120 }])
    const session = definition().createSession({ registry: registry(adapter), compaction: false,
      runtimeLimits: { maxTotalTokens: 100 }, hooks: { onRequestError: async () => 'retry' as const } })
    await observe(session.run('go'))
    expect(adapter.requests).toHaveLength(1)
  })

  it('does not let onTurnEnd injection reopen an exhausted turn', async () => {
    const adapter = new Scripted([{ text: 'First result', tokens: 120 }, { text: 'Second result', tokens: 120 }])
    let inject!: () => void
    const session = definition().createSession({ registry: registry(adapter), compaction: false,
      runtimeLimits: { maxTotalTokens: 100 }, hooks: { onTurnEnd: async ({ canContinue }) => {
        if (canContinue && adapter.requests.length === 1) inject()
      } } })
    inject = () => { session.inject('Check once more') }
    await observe(session.run('go'))
    expect(adapter.requests).toHaveLength(1)
  })

  it('does not retry an errored response that already failed required-usage policy', async () => {
    const adapter = new Scripted([{ fail: true }, { text: 'Second result', tokens: 120 }])
    const session = definition().createSession({ registry: registry(adapter), compaction: false,
      usagePolicy: { onMissing: 'fail' }, hooks: { onRequestError: async () => 'retry' as const } })
    await observe(session.run('go'))
    expect(adapter.requests).toHaveLength(1)
  })
})

const lookup = defineTool({ name: 'lookup', description: 'Fixture', parameters: { type: 'object' }, execute: () => 'ok' })
const format = { type: 'json_schema', name: 'answer', schema: { type: 'object' } } as const

describe('admission boundary and negative controls', () => {
  it('required usage declines tools but retains history pairing', async () => {
    const adapter = new Scripted([{ tool: true }])
    let executions = 0, retries = 0
    const session = definition({ tools: [defineTool({ name: 'lookup', description: 'Fixture', parameters: { type: 'object' },
      execute: () => { executions++; return 'ok' },
    })] }).createSession({ registry: registry(adapter), usagePolicy: { onMissing: 'fail' }, hooks: {
      onRequestError: () => { retries++; return 'retry' },
    } })
    await expect(session.run('go')).rejects.toMatchObject({ code: 'USAGE_REQUIRED' })
    expect(adapter.requests).toHaveLength(1)
    expect(executions).toBe(0)
    expect(retries).toBe(0)
    expect(JSON.stringify(session.snapshot().history)).toContain('tool-result')
  })
  for (const transition of ['structured', 'retry', 'hook', 'forced'] as const) {
    it.each([99, 100, 101])(`${transition}: cap boundary %i`, async tokens => {
      const adapter = new Scripted([{ text: 'first', tokens, fail: transition === 'retry', tool: transition === 'forced' },
        { text: '{}', tokens: 10 }])
      let inject!: () => void
      const session = definition({
        ...(transition === 'structured' ? { outputFormat: format, tools: [lookup] } : {}),
        ...(transition === 'forced' ? { tools: [lookup], maxTurns: 1 } : {}),
      }).createSession({ registry: registry(adapter), compaction: false,
        runtimeLimits: { maxTotalTokens: 100 }, hooks: {
          onRequestError: async () => 'retry' as const,
          onTurnEnd: ({ canContinue }) => { if (transition === 'hook' && canContinue && adapter.requests.length === 1) inject() },
        } })
      inject = () => { session.inject('again') }
      await session.run('go')
      expect(adapter.requests).toHaveLength(tokens < 100 ? 2 : 1)
      if (transition === 'forced') {
        const events = session.snapshot().history
        expect(JSON.stringify(events)).toContain('tool-result')
      }
    })
  }

  it('estimated usage also stops a structured finalizer at the cap', async () => {
    const adapter = new Scripted([{ text: 'process' }, { text: '{}' }])
    const result = await definition({ outputFormat: format, tools: [lookup] }).createSession({
      registry: registry(adapter), runtimeLimits: { maxTotalTokens: 100 }, usagePolicy: {
        onMissing: 'estimate', estimator: { id: 'local', estimate: () => ({ totalTokens: 100 }) },
      },
    }).run('go')
    expect(adapter.requests).toHaveLength(1)
    expect(result.outcome.reason.kind).toBe('budget-exhausted')
  })

  it('an always-retry hook still terminates at the step limit', async () => {
    const adapter = new Scripted(Array.from({ length: 3 }, () => ({ fail: true, tokens: 10 })))
    await definition().createSession({ registry: registry(adapter), hooks: { onRequestError: () => 'retry' } }).run('go')
    expect(adapter.requests).toHaveLength(3)
  })

  it('abort inside the retry hook cannot dispatch again', async () => {
    const adapter = new Scripted([{ fail: true, tokens: 10 }])
    const controller = new AbortController()
    await definition().createSession({ registry: registry(adapter), hooks: {
      onRequestError: () => { controller.abort(); return 'retry' },
    } }).run('go', { signal: controller.signal }).catch(() => undefined)
    expect(adapter.requests).toHaveLength(1)
  })
})

function plugin(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id: 'fixture', displayName: 'Fixture',
    routes: ['fixture'], defaultModel: { provider: 'fixture', id: 'mock' },
    setup(registrar) { registrar.registerAdapter(['fixture'], adapter) } }
}

describe('composition completion and estimator ownership', () => {
  it('a concluding tool completes basic mode', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(new Scripted([{ tool: true, tokens: 10 }]))] })
    try {
      const result = await runtime.agent({ id: 'conclude', instructions: 'Go', compaction: false, tools: [defineTool({
        name: 'lookup', description: 'Conclude', parameters: { type: 'object' },
        execute: (_args, context) => { context.concludeTurn(); return 'done' },
      })] }).generate('go')
      expect(result).toMatchObject({ completed: true, stopReason: 'concluded-by-tool', report: { status: 'success' } })
    } finally { await runtime.close() }
  })

  it('deep mode without an accepted submission does not claim objective completion', async () => {
    const adapter = new Scripted(Array.from({ length: 4 }, () => ({ text: 'not submitted', tokens: 10 })))
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    try {
      const result = await runtime.agent({ id: 'deep', instructions: 'Go', mode: 'deep', maxTurns: 1, compaction: false }).generate('go')
      expect(result.completed).toBe(false)
      expect(result.report.status).toBe('success')
      expect(adapter.requests.length).toBeLessThanOrEqual(2)
    } finally { await runtime.close() }
  })
  it.each([
    { step: { text: 'done', tokens: 10 }, completed: true, reason: 'completed' },
    { step: { text: 'cut', tokens: 10, truncated: true }, completed: false, reason: 'max-tokens' },
    { step: { tool: true, tokens: 100 }, completed: false, reason: 'budget-exhausted' },
    { step: { text: 'unknown' }, completed: false, reason: 'usage-unavailable' },
  ])('projects $reason separately from execution success', async ({ step, completed, reason }) => {
    const adapter = new Scripted([step])
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    try {
      const result = await runtime.agent({ id: 'projection', instructions: 'Go', tools: [lookup], compaction: false })
        .createSession({ runtimeLimits: { maxTotalTokens: 100 } }).run('go')
      expect(result).toMatchObject({ completed, stopReason: reason, report: { status: 'success' } })
    } finally { await runtime.close() }
  })

  it.each(['abort', 'close', 'timeout'] as const)('settles pending estimation on %s, retaining evidence and ignoring late results', async action => {
    const adapter = new Scripted([{ text: 'raw provider evidence' }])
    const entered = deferred<void>(), gate = deferred<{ totalTokens: number }>()
    let signal!: AbortSignal
    const runtime = await createRuntimeCompositionOwner({ providers: [plugin(adapter)] })
    const session = runtime.agent({ id: 'bounded', instructions: 'Go', compaction: false }).createSession({ usagePolicy: {
      onMissing: 'estimate', estimateTimeoutMs: action === 'timeout' ? 20 : 30_000,
      estimator: { id: 'pending', estimate: input => { signal = input.signal; entered.resolve(); return gate.promise } },
    } })
    const handle = session.stream('go'), result = observe(handle.result)
    try {
      await entered.promise
      if (action === 'abort') handle.abort()
      if (action === 'close') await runtime.close()
      expect((await result).ok).toBe(false)
      const report = await handle.report
      const snapshot = JSON.stringify(report)
      expect(report.modelCalls).toHaveLength(1)
      expect(report.usage.authoritative).toBe(false)
      expect(signal.aborted).toBe(true)
      expect(session.isRunning).toBe(false)
      gate.resolve({ totalTokens: 99 })
      await pause(0)
      expect(JSON.stringify(await handle.report)).toBe(snapshot)
      expect(adapter.requests).toHaveLength(1)
    } finally { gate.resolve({ totalTokens: 99 }); await runtime.close() }
  })

  it('pre-aborted loop promise helpers observe rejection in a real Node process', () => {
    // Exercise emitted JavaScript; Node 26 removed transform-types and native
    // strip-only mode cannot load the source's parameter properties.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { nextWithAbort, nextValueWithAbort } from './packages/core/dist/agent/loop/turn/cancellation.js';
      const signal = AbortSignal.abort();
      await nextWithAbort(Promise.reject(new Error('iterator late rejection')), signal).catch(() => {});
      await nextValueWithAbort(Promise.reject(new Error('hook late rejection')), signal).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
    `], { timeout: 5_000, stdio: 'pipe' })
  })

  it('compaction observes a rejection created at the same time as cancellation', () => {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { ModelRegistry, createTextMessage } from '@ai-agent-sdk/core';
      import { ContextCompactor, History, resolveCompactionConfig } from '@ai-agent-sdk/core/agent';
      const controller = new AbortController();
      const registry = new ModelRegistry();
      registry.resolveModelInfo = () => {
        controller.abort(new Error('caller aborted'));
        return Promise.reject(new Error('late catalog rejection'));
      };
      const history = new History();
      history.append({ kind: 'user', message: createTextMessage('first') });
      history.append({ kind: 'user', message: createTextMessage('second') });
      const compactor = new ContextCompactor({ registry, config: { provider: 'fixture', model: 'mock' },
        history: () => history, system: () => '', tools: () => [],
        policy: resolveCompactionConfig({ auto: false, maxInputTokens: 100 }) });
      await compactor.compactNow(controller.signal).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
    `], { timeout: 5_000, stdio: 'pipe' })
  })
})

describe('usage estimation is an abortable extension point', () => {
  it('settles caller cancellation without waiting for an uncooperative estimator', async () => {
    const adapter = new Scripted([{ text: 'Provider returned no usage' }])
    const entered = deferred<void>()
    const gate = deferred<{ inputTokens: number; outputTokens: number; totalTokens: number }>()
    const session = definition().createSession({ registry: registry(adapter), compaction: false,
      runtimeLimits: { modelTimeoutMs: 25 }, usagePolicy: { onMissing: 'estimate', estimator: {
        id: 'uncooperative', estimate: () => { entered.resolve(); return gate.promise },
      } } })
    const controller = new AbortController()
    const handle = session.stream('go', { signal: controller.signal })
    let settled = false
    const outcome = observe(handle.result).then(value => { settled = true; return value })
    try {
      await entered.promise
      controller.abort()
      await pause(75)
      expect(settled).toBe(true)
      expect(adapter.requests).toHaveLength(1)
    } finally {
      // Never leave the failing test's callback pending in the test worker.
      gate.resolve({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })
      await outcome
    }
  })
})
