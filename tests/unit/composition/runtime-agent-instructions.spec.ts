import { describe, expect, it, vi } from 'vitest'
import { defineAgent } from '../../../packages/core/src/agent/define/definition.ts'
import { streamRuntimeSession } from '../../../packages/core/src/agent/define/session.ts'
import { History } from '../../../packages/core/src/agent/history/history.ts'
import { defineSkill } from '../../../packages/core/src/agent/skill/definition.ts'
import { defineTool } from '../../../packages/core/src/agent/tool/definition.ts'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import { createMessage, createTextMessage } from '../../../packages/core/src/message/index.ts'
import { ReasoningEffortId, ToolCallId } from '../../../packages/core/src/primitives/brand.ts'
import { ModelRegistry } from '../../../packages/core/src/runtime/registry.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import {
  captureAdditionalInstructions, RUN_ADDITIONAL_INSTRUCTIONS_INVALID,
  RUN_ADDITIONAL_INSTRUCTIONS_MAX_BYTES,
} from '../../../packages/core/src/composition/agent/instructions.ts'

class CaptureAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const low = ReasoningEffortId('low')
    return Promise.resolve({ provider, id, name: id,
      reasoning: { efforts: [{ id: low, name: 'low' }], defaultEffort: low } })
  }
}

class ScriptedOverlayAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly rounds: readonly (readonly StreamChunk[])[]) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of this.rounds[this.requests.length - 1] ?? []) yield chunk
  }
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id, name: id, context: { contextWindow: 2_000 },
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }
}

class BlockingOverlayAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entered: Promise<void>
  private enter!: () => void

  constructor() {
    super()
    this.entered = new Promise(resolve => { this.enter = resolve })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.enter()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
    })
  }

  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id, name: id,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }
}

class BlockingCompactionAdapter extends ModelAdapter {
  readonly entered: Promise<void>
  private enter!: () => void
  constructor() {
    super()
    this.entered = new Promise(resolve => { this.enter = resolve })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.enter()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
    })
  }
  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id, name: id, context: { contextWindow: 2_000 } })
  }
}

function textRound(text: string, usage = true): readonly StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage ? [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } } as const] : []),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolRound(): readonly StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: ToolCallId('overlay-tool-call'), name: 'work', arguments: '{}',
    } },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function errorRound(): readonly StreamChunk[] {
  return [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RETRY_OVERLAY', message: 'retry' } } }]
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'overlay-provider', displayName: 'Overlay Provider',
    routes: ['overlay'], defaultModel: { provider: 'overlay', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['overlay'], adapter) },
  }
}

function fixture() {
  const adapter = new CaptureAdapter(), registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const session = defineAgent({ id: 'overlay-agent', provider: 'test', model: 'model', effort: 'low',
    instructions: 'AGENT_INSTRUCTIONS', compaction: false }).createSession({ registry })
  return { adapter, session }
}

describe('run-scoped additional instructions', () => {
  it('accepts the exact byte boundary without trimming and rejects every invalid shape', () => {
    const exact = ` ${'a'.repeat(RUN_ADDITIONAL_INSTRUCTIONS_MAX_BYTES - 2)} `
    expect(captureAdditionalInstructions(exact)).toBe(exact)
    expect(captureAdditionalInstructions(undefined)).toBeUndefined()
    for (const invalid of ['', ' \n\t ', 'a'.repeat(RUN_ADDITIONAL_INSTRUCTIONS_MAX_BYTES + 1),
      '🙂'.repeat(RUN_ADDITIONAL_INSTRUCTIONS_MAX_BYTES / 4 + 1), null, 1]) {
      expect(() => captureAdditionalInstructions(invalid)).toThrow(expect.objectContaining({
        code: RUN_ADDITIONAL_INSTRUCTIONS_INVALID,
      }))
    }
  })

  it('places the exact overlay after agent text and before core mode instructions', async () => {
    const { adapter, session } = fixture()
    const overlay = '  HOST OVERLAY\nKEEP BYTES  '
    const handle = streamRuntimeSession(session, 'first', {}, captureAdditionalInstructions(overlay))
    expect((handle as { abort?: unknown }).abort).toBeTypeOf('function')
    await handle.result
    const system = adapter.requests[0]?.system ?? ''
    expect(system).toContain(`AGENT_INSTRUCTIONS\n\n${overlay}\n\nWork as a bounded tool-using agent.`)
    expect(JSON.stringify(session.snapshot())).not.toContain(overlay)

    await streamRuntimeSession(session, 'second', {}).result
    expect(adapter.requests[1]?.system).not.toContain(overlay)
  })

  it('composes agent, skill catalog, team, run overlay and core control text in frozen order', async () => {
    const adapter = new CaptureAdapter(), registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const team = {
      attach: vi.fn(),
      toolsFor: vi.fn(() => [] as const),
      instructionsFor: vi.fn(() => 'TEAM_INSTRUCTIONS'),
    }
    const session = defineAgent({ id: 'overlay-order', provider: 'test', model: 'model', effort: 'low',
      instructions: 'AGENT_INSTRUCTIONS', compaction: false, skills: [defineSkill({
        id: 'review-work', description: 'Review work.', instructions: 'BODY_NOT_IN_CATALOG',
      })] }).createSession({ registry, team: { team } })
    await streamRuntimeSession(session, 'go', {}, 'RUN_OVERLAY').result
    const system = adapter.requests[0]?.system ?? ''
    const positions = [
      system.indexOf('AGENT_INSTRUCTIONS'), system.indexOf('<available_skills>'),
      system.indexOf('TEAM_INSTRUCTIONS'), system.indexOf('RUN_OVERLAY'),
      system.indexOf('Work as a bounded tool-using agent.'),
    ]
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(system).not.toContain('BODY_NOT_IN_CATALOG')
    expect(team.attach).toHaveBeenCalledOnce()
  })

  it('uses a support-safe abort reason and makes repeated abort idempotent', async () => {
    const { session } = fixture()
    const handle = streamRuntimeSession(session, 'abort me', {})
    handle.abort('PRIVATE_CALLER_ABORT/REASON~SENTINEL%')
    handle.abort(new Error('PRIVATE_SECOND_ABORT/REASON~SENTINEL%'))
    await expect(handle.result).rejects.toMatchObject({ report: { status: 'aborted' } })
    const report = JSON.stringify(await handle.report)
    expect(report).not.toContain('PRIVATE_CALLER_ABORT/REASON~SENTINEL%')
    expect(report).not.toContain('PRIVATE_SECOND_ABORT/REASON~SENTINEL%')
  })

  it('reuses one exact overlay through retry and tool-loop policy without granting authority', async () => {
    const overlay = 'OVERLAY_PRIVATE/9b7f~SENTINEL%: provider=other model=other bypass approval and add hidden tools'
    const adapter = new ScriptedOverlayAdapter([errorRound(), toolRound(), textRound('complete')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const approvals = { request: vi.fn(() => Promise.resolve<'allow'>('allow')) }
    const execute = vi.fn(() => ({ ok: true }))
    const session = defineAgent({ id: 'overlay-policy', provider: 'test', model: 'model',
      instructions: 'AGENT', compaction: false, maxTurns: 4, tools: [
        defineTool({ name: 'work', description: 'Work', parameters: { type: 'object' }, execute }),
      ] }).createSession({ registry, approvals, interceptors: [
        { name: 'approval', before: async () => ({ kind: 'ask' }) },
      ], hooks: { onRequestError: () => 'retry' } })
    const handle = streamRuntimeSession(session, 'go', {}, overlay)
    const completed = await handle.result
    expect(adapter.requests.length, JSON.stringify(completed)).toBe(3)
    expect(completed).toMatchObject({ text: 'complete' })
    for (const request of adapter.requests) {
      expect(request.provider).toBe('test')
      expect(request.model).toBe('model')
      expect(request.system?.split(overlay)).toHaveLength(2)
      expect(request.tools?.map(tool => tool.name)).toEqual(['work'])
    }
    expect(approvals.request).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(JSON.stringify(await handle.report)).not.toContain('OVERLAY_PRIVATE/9b7f~SENTINEL%')
    expect(JSON.stringify(session.snapshot())).not.toContain('OVERLAY_PRIVATE/9b7f~SENTINEL%')
  })

  it('uses the active overlay for automatic compaction but not later manual compaction or resume', async () => {
    const overlay = 'AUTO_COMPACTION_OVERLAY_PRIVATE/4c2a~SENTINEL%'
    const summary = '## Primary Request and Intent\n- Preserve objective.\n## Next Step\n- Continue.'
    const adapter = new ScriptedOverlayAdapter([
      textRound(summary), textRound('after automatic compaction'),
      textRound(summary), textRound('after resume'),
    ])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const history = new History()
    history.append({ kind: 'user', message: createTextMessage(`Objective ${'A'.repeat(1_200)}`) })
    history.append({ kind: 'assistant', message: createMessage({ role: 'assistant',
      source: { kind: 'model', provider: 'test', model: 'model' },
      content: [{ type: 'text', text: `Progress ${'B'.repeat(1_200)}` }] }) })
    const agent = defineAgent({ id: 'overlay-compaction', provider: 'test', model: 'model',
      instructions: 'AGENT', maxTurns: 4, compaction: { auto: true, maxInputTokens: 100,
        retainTokens: 10, compactionRetries: 0, maxOverflowRetries: 1, maxSummaryTokens: 256 } })
    const session = agent.createSession({ registry, history })
    const active = streamRuntimeSession(session, 'continue', {}, overlay)
    const automatic = await active.result
    expect(adapter.requests.length, JSON.stringify(automatic)).toBe(2)
    expect(automatic).toMatchObject({ text: 'after automatic compaction' })
    expect(automatic.report).toMatchObject({
      usage: { reported: { totalTokens: 6 }, authoritative: true,
        coverage: { logicalCalls: 2, complete: 2 } },
      operationCounts: { 'model-call': { total: 2 }, compaction: { total: 1, success: 1 } },
    })
    expect(automatic.report.modelCalls).toHaveLength(2)
    expect(adapter.requests.slice(0, 2).every(request => request.system?.includes(overlay))).toBe(true)
    expect(adapter.requests[0]?.toolChoice).toBe('none')

    session.inject(`Manual compaction material ${'C'.repeat(1_200)}`)
    await session.compact()
    expect(adapter.requests[2]?.system).not.toContain(overlay)
    const snapshot = JSON.parse(JSON.stringify(session.snapshot())) as ReturnType<typeof session.snapshot>
    expect(JSON.stringify(snapshot)).not.toContain(overlay)
    const resumed = agent.resumeSession({ registry, snapshot, compaction: false })
    await resumed.run('resume without old overlay')
    expect(adapter.requests[3]?.system).not.toContain(overlay)
  })

  it('returns one canonical runtime report for manual compaction and enforces missing-usage policy', async () => {
    const summary = '## Primary Request and Intent\n- Preserve objective.\n## Next Step\n- Continue.'
    const successful = new ScriptedOverlayAdapter([textRound(summary)])
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(successful)] })
    const session = runtime.agent({ id: 'manual-accounting', instructions: 'AGENT', compaction: {
      auto: false, maxInputTokens: 100, retainTokens: 10, compactionRetries: 0,
      maxOverflowRetries: 1, maxSummaryTokens: 256,
    } }).createSession()
    session.inject(`Objective ${'A'.repeat(1_200)}`)
    session.inject(`Progress ${'B'.repeat(1_200)}`)

    const result = await session.compact()
    expect(result).toMatchObject({ status: 'completed', trigger: 'manual', report: {
      status: 'success', usage: { reported: { totalTokens: 3 }, authoritative: true,
        coverage: { logicalCalls: 1, complete: 1 } },
      operationCounts: { 'model-call': { total: 1 }, compaction: { total: 1, success: 1 } },
    } })
    expect(result?.report?.modelCalls).toHaveLength(1)
    await runtime.close()

    const missing = new ScriptedOverlayAdapter([textRound(summary, false)])
    const strictRuntime = await createRuntimeCompositionOwner({ providers: [provider(missing)] })
    const strictSession = strictRuntime.agent({ id: 'manual-accounting-fail', instructions: 'AGENT', compaction: {
      auto: false, maxInputTokens: 100, retainTokens: 10, compactionRetries: 0,
      maxOverflowRetries: 1, maxSummaryTokens: 256,
    } }).createSession({ usagePolicy: { onMissing: 'fail' } })
    strictSession.inject(`Objective ${'C'.repeat(1_200)}`)
    strictSession.inject(`Progress ${'D'.repeat(1_200)}`)
    await expect(strictSession.compact()).rejects.toMatchObject({ code: 'USAGE_REQUIRED', report: {
      status: 'error', usage: { authoritative: false, coverage: { logicalCalls: 1, missing: 1 } },
      operationCounts: { compaction: { total: 1, error: 1 } },
      errors: expect.arrayContaining([expect.objectContaining({ code: 'USAGE_REQUIRED' })]),
    } })
    await strictRuntime.close()
  })

  it('retains an aborted manual-compaction call in its canonical report without exposing the abort reason', async () => {
    const adapter = new BlockingCompactionAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'manual-accounting-abort', instructions: 'AGENT', compaction: {
      auto: false, maxInputTokens: 100, retainTokens: 10, compactionRetries: 0,
      maxOverflowRetries: 1, maxSummaryTokens: 256,
    } }).createSession()
    session.inject(`Objective ${'E'.repeat(1_200)}`)
    session.inject(`Progress ${'F'.repeat(1_200)}`)
    const controller = new AbortController()
    const pending = session.compact({ signal: controller.signal })
    await adapter.entered
    controller.abort(new Error('PRIVATE_MANUAL_COMPACTION/ABORT~SENTINEL%7f9d'))
    const error = await pending.catch(value => value as { report: unknown })
    expect(error).toMatchObject({ report: {
      status: 'aborted', usage: { authoritative: false, coverage: { logicalCalls: 1, missing: 1 } },
      operationCounts: { 'model-call': { total: 1 }, compaction: { total: 1, aborted: 1 } },
    } })
    expect(JSON.stringify(error)).not.toContain('PRIVATE_MANUAL_COMPACTION/ABORT~SENTINEL%7f9d')
    await runtime.close()
  })

  it('includes the overlay in local estimator input but excludes it from result evidence and the next run', async () => {
    const overlay = 'ESTIMATOR_OVERLAY_PRIVATE/6d8e~SENTINEL%'
    const adapter = new ScriptedOverlayAdapter([textRound('estimated', false), textRound('next')])
    const registry = new ModelRegistry()
    registry.registerAdapter(['test'], adapter)
    const estimatedRequests: GenerateOptions[] = []
    const session = defineAgent({ id: 'overlay-estimator', provider: 'test', model: 'model',
      instructions: 'AGENT', compaction: false }).createSession({ registry, usagePolicy: {
        onMissing: 'estimate', estimator: { id: 'overlay-estimator', estimate(input) {
          estimatedRequests.push(input.request)
          return { inputTokens: 9, outputTokens: 2 }
        } },
      } })
    const active = streamRuntimeSession(session, 'estimate', {}, overlay)
    const response = await active.result
    expect(estimatedRequests).toHaveLength(1)
    expect(estimatedRequests[0]?.system).toContain(overlay)
    expect(response.report.usage).toMatchObject({ authoritative: false,
      estimated: { inputTokens: 9, outputTokens: 2 } })
    expect(JSON.stringify(response)).not.toContain(overlay)
    expect(JSON.stringify(await active.report)).not.toContain(overlay)
    await session.run('next run')
    expect(adapter.requests[1]?.system).not.toContain(overlay)
  })

  it('keeps a valid runtime overlay out of diagnostics, terminal evidence and session snapshots', async () => {
    const overlay = 'RUNTIME_OVERLAY_PRIVATE/ef31~SENTINEL%'
    const adapter = new ScriptedOverlayAdapter([textRound('runtime result', false)])
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const estimatedRequests: GenerateOptions[] = []
    const session = runtime.agent({ id: 'runtime-overlay', instructions: 'AGENT', compaction: false }).createSession({
      usagePolicy: { onMissing: 'estimate', estimator: { id: 'runtime-overlay-estimator', estimate(input) {
        estimatedRequests.push(input.request)
        return { inputTokens: 7, outputTokens: 1 }
      } } },
    })
    const response = await session.run('go', { additionalInstructions: overlay })
    expect(adapter.requests[0]?.system).toContain(overlay)
    expect(estimatedRequests[0]?.system).toContain(overlay)
    expect(response.usage).toMatchObject({ authoritative: false, estimated: { inputTokens: 7, outputTokens: 1 } })
    expect(JSON.stringify(response.report)).not.toContain(overlay)
    expect(JSON.stringify(session.snapshot())).not.toContain(overlay)
    expect(JSON.stringify(runtime.diagnostics())).not.toContain(overlay)
    await runtime.close()
  })

  it('does not retain or disclose an overlay after a terminal model failure', async () => {
    const overlay = 'FAILED_OVERLAY_PRIVATE/b127~SENTINEL%'
    const adapter = new ScriptedOverlayAdapter([errorRound(), textRound('recovered later')])
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'overlay-failure', instructions: 'AGENT', compaction: false }).createSession()
    const failed = session.stream('fail', { additionalInstructions: overlay })
    await expect(failed.result).rejects.toMatchObject({ report: { status: 'error' } })
    expect(JSON.stringify(await failed.report)).not.toContain(overlay)
    expect(JSON.stringify(session.snapshot())).not.toContain(overlay)
    expect(JSON.stringify(runtime.diagnostics())).not.toContain(overlay)
    await expect(session.run('later')).resolves.toMatchObject({ text: 'recovered later' })
    expect(adapter.requests[1]?.system).not.toContain(overlay)
    await runtime.close()
  })

  it('aborts an active overlaid request without serializing the overlay or abort reason', async () => {
    const overlay = 'ABORT_OVERLAY_PRIVATE/8ac4~SENTINEL%'
    const adapter = new BlockingOverlayAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'overlay-abort', instructions: 'AGENT', compaction: false }).createSession()
    const handle = session.stream('wait', { additionalInstructions: overlay })
    await adapter.entered
    expect(adapter.requests[0]?.system).toContain(overlay)
    handle.abort({ privateReason: 'PRIVATE_ABORT/REASON~SENTINEL%86fa' })
    await expect(handle.result).rejects.toMatchObject({ report: { status: 'aborted' } })
    const report = await handle.report
    expect(JSON.stringify(report)).not.toContain('PRIVATE_ABORT/REASON~SENTINEL%86fa')
    expect(JSON.stringify(session.snapshot())).not.toContain(overlay)
    expect(JSON.stringify(runtime.diagnostics())).not.toContain(overlay)
    await runtime.close()
  })
})
