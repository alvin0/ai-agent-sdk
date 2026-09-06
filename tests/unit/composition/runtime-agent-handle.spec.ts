import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { ToolCallId } from '../../../packages/core/src/primitives/brand.ts'
import { defineTool } from '../../../packages/core/src/agent/tool/definition.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { ObservationExporterPlugin } from '../../../packages/core/src/composition/exporter/types.ts'

class BlockingAdapter extends ModelAdapter {
  readonly entered: Promise<void>
  private enter!: () => void
  aborts = 0

  constructor() {
    super()
    this.entered = new Promise(resolve => { this.enter = resolve })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.enter()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => { this.aborts++; reject(options.signal?.reason) }, { once: true })
    })
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class UncooperativeAdapter extends ModelAdapter {
  readonly entered: Promise<void>
  private enter!: () => void
  private readonly blocked: Promise<void>
  private resume!: () => void
  continued = false

  constructor() {
    super()
    this.entered = new Promise(resolve => { this.enter = resolve })
    this.blocked = new Promise(resolve => { this.resume = resolve })
  }

  release(): void { this.resume() }

  async * stream(): AsyncIterable<StreamChunk> {
    this.enter()
    await this.blocked
    this.continued = true
    yield { type: 'text-delta', index: 0, text: 'PRIVATE_LATE/RESULT~SENTINEL%' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PRIVATE_LATE/RESULT~SENTINEL%' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class EarlyReturnAdapter extends ModelAdapter {
  readonly blocked: Promise<void>
  private block!: () => void
  aborts = 0

  constructor() {
    super()
    this.blocked = new Promise(resolve => { this.block = resolve })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'first' }
    this.block()
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { this.aborts++; reject(options.signal.reason); return }
      options.signal?.addEventListener('abort', () => { this.aborts++; reject(options.signal?.reason) }, { once: true })
    })
  }
}

class CompleteAdapter extends ModelAdapter {
  lateAborts = 0
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.addEventListener('abort', () => { this.lateAborts++ })
    yield { type: 'text-delta', index: 0, text: 'complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FailingAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: {
      code: 'PROVIDER_SCRIPT_FAILED', message: 'scripted safe failure',
    } } }
  }
}

class OversizedEventAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 'x'.repeat(16 * 1024 * 1024 + 1) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ToolCallAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: {
      type: 'tool-call', id: ToolCallId('parked-tool-call'), name: 'park', arguments: '{}',
    } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'handle-provider', displayName: 'Handle Provider',
    family: 'scripted-family',
    routes: ['handle'], defaultModel: { provider: 'handle', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['handle'], adapter) },
  }
}

describe('runtime agent run handle', () => {
  it('keeps one generation active through terminal observation checkpointing', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let terminalEntered!: () => void
    const terminalStarted = new Promise<void>(resolve => { terminalEntered = resolve })
    const sink: ObservationExporterPlugin = {
      kind: 'observation-exporter', apiVersion: 1, id: 'park-terminal',
      supportedBoundaries: ['local-durable'],
      export: async batch => {
        if (batch.runRecords.length > 0) { terminalEntered(); await gate }
        return { batchId: batch.id, acceptedEventIds: batch.events.map(event => event.eventId),
          acceptedRunIds: batch.runRecords.map(record => record.runId) }
      },
    }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new CompleteAdapter())],
      observability: { mode: 'reliable', exporters: [{
        exporter: sink, ownership: 'borrowed', requirement: 'required', boundary: 'local-durable',
      }] } })
    const session = runtime.agent({ id: 'generation-guard', instructions: 'Complete', compaction: false }).createSession()
    const first = session.stream('first')
    await terminalStarted
    expect(session.isRunning).toBe(true)
    expect(() => session.stream('second')).toThrow(/runtime session is active/)
    expect(() => session.compact()).toThrow(/runtime session is active/)
    let idle = false
    const waiting = session.whenIdle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    release()
    await expect(first.result).resolves.toMatchObject({ text: 'complete' })
    await waiting
    expect(session.isRunning).toBe(false)
    await expect(session.run('second')).resolves.toMatchObject({ text: 'complete' })
    await runtime.close()
  })

  it('exposes manual compaction as an active session operation through its terminal checkpoint', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let terminalEntered!: () => void
    const terminalStarted = new Promise<void>(resolve => { terminalEntered = resolve })
    const sink: ObservationExporterPlugin = {
      kind: 'observation-exporter', apiVersion: 1, id: 'park-compaction-terminal',
      supportedBoundaries: ['local-durable'],
      export: async batch => {
        if (batch.runRecords.length > 0) { terminalEntered(); await gate }
        return { batchId: batch.id, acceptedEventIds: batch.events.map(event => event.eventId),
          acceptedRunIds: batch.runRecords.map(record => record.runId) }
      },
    }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new CompleteAdapter())],
      observability: { mode: 'reliable', exporters: [{
        exporter: sink, ownership: 'borrowed', requirement: 'required', boundary: 'local-durable',
      }] } })
    const session = runtime.agent({ id: 'compaction-guard', instructions: 'Complete', compaction: false }).createSession()
    const compacting = session.compact()
    await terminalStarted
    expect(session.isRunning).toBe(true)
    expect(() => session.stream('during compaction')).toThrow(/runtime session is active/)
    let idle = false
    const waiting = session.whenIdle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    release()
    await expect(compacting).resolves.toBeNull()
    await waiting
    expect(session.isRunning).toBe(false)
    await runtime.close()
  })

  it('settles public run artifacts when close seals an uncooperative generation', async () => {
    const adapter = new UncooperativeAdapter()
    const runtime = await createRuntimeCompositionOwner({ closeTimeoutMs: 5, providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'sealed-run', instructions: 'Wait', compaction: false }).createSession()
    const handle = session.stream('start')
    await adapter.entered
    let settled = false
    const publicArtifacts = Promise.allSettled([handle.result, handle.report]).then(() => { settled = true })
    const closing = await runtime.close()
    expect(closing.operations.find(row => row.kind === 'agent-run')).toMatchObject({
      activeAtClose: 1, aborted: 1, unsettled: 1,
    })
    try {
      await Promise.race([publicArtifacts, new Promise(resolve => setTimeout(resolve, 20))])
      expect(settled).toBe(true)
    } finally {
      adapter.release()
      await publicArtifacts
    }
    const report = await handle.report
    expect(report).toMatchObject({ status: 'unknown', errors: expect.arrayContaining([
      expect.objectContaining({ code: 'RUNTIME_OPERATION_ABORTED' }),
    ]) })
    await expect(handle.result).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED', report })
    await session.whenIdle()
    await vi.waitFor(() => expect(adapter.continued).toBe(true))
    expect(JSON.stringify(runtime.diagnostics())).not.toContain('PRIVATE_LATE/RESULT~SENTINEL%')
  })

  it('starts eagerly and aborts before iteration while preserving one canonical report', async () => {
    const adapter = new BlockingAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'eager', instructions: 'Wait', compaction: false }).createSession()
    const handle = session.stream('start')
    await adapter.entered
    expect(session.isRunning).toBe(true)
    handle.abort({ private: 'PRIVATE_ABORT/FIRST~SENTINEL%' })
    handle.abort(new Error('PRIVATE_ABORT/SECOND~SENTINEL%'))
    const report = await handle.report
    await expect(handle.result).rejects.toMatchObject({ report })
    expect(report.status).toBe('aborted')
    expect(JSON.stringify(report)).not.toContain('PRIVATE_ABORT/FIRST~SENTINEL%')
    expect(JSON.stringify(report)).not.toContain('PRIVATE_ABORT/SECOND~SENTINEL%')
    await session.whenIdle()
    expect(session.isRunning).toBe(false)
    expect(adapter.aborts).toBe(1)
    await runtime.close()
  })

  it('aborts and boundedly settles when the event consumer returns early', async () => {
    const adapter = new EarlyReturnAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'early-return', instructions: 'Stream', compaction: false }).createSession()
    const handle = session.stream('start')
    for await (const event of handle) {
      expect(event).toMatchObject({ type: 'assistant-delta', text: 'first', runId: handle.runId })
      break
    }
    await adapter.blocked
    const report = await handle.report
    await expect(handle.result).rejects.toMatchObject({ report })
    expect(report.status).toBe('aborted')
    expect(adapter.aborts).toBe(1)
    await session.whenIdle()
    await runtime.close()
  })

  it('makes repeated and late abort a no-op after terminal settlement', async () => {
    const adapter = new CompleteAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const handle = runtime.agent({ id: 'late-abort', instructions: 'Complete', compaction: false }).stream('go')
    const response = await handle.result
    const report = await handle.report
    const abortsAtTerminal = adapter.lateAborts
    handle.abort(new Error('late'))
    handle.abort(new Error('later'))
    expect(response.report).toBe(report)
    expect(report.status).toBe('success')
    expect(adapter.lateAborts).toBe(abortsAtTerminal)
    await runtime.close()
  })

  it('allows only one public event consumer', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new CompleteAdapter())] })
    const handle = runtime.agent({ id: 'single-consumer', instructions: 'Complete', compaction: false }).stream('go')
    const first = handle[Symbol.asyncIterator]()
    const second = handle[Symbol.asyncIterator]()
    await expect(second.next()).rejects.toThrow(/only be iterated once/)
    while (!(await first.next()).done) { /* drain */ }
    await expect(handle.result).resolves.toMatchObject({ text: 'complete' })
    await runtime.close()
  })

  it('does not invoke an observer more than once per event and preserves callback order', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new CompleteAdapter())] })
    const observed: number[] = []
    const response = await runtime.agent({ id: 'observer-order', instructions: 'Complete', compaction: false }).generate('go', {
      onEvent: async event => { await Promise.resolve(); observed.push(event.sequence) },
    })
    expect(observed).toEqual([1, 2])
    expect(response.report.status).toBe('success')
    await runtime.close()
  })

  it.each(['reject', 'timeout'] as const)(
    'aborts active work on observer %s and retains a support-safe canonical report',
    async mode => {
      const adapter = new EarlyReturnAdapter()
      const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
      const session = runtime.agent({ id: `observer-${mode}`, instructions: 'Observe', compaction: false })
        .createSession({ runtimeLimits: { observerTimeoutMs: 5 } })
      let rejected: unknown
      try {
        await session.run('go', { onEvent: mode === 'reject'
          ? () => Promise.reject(new Error('OBSERVER_PRIVATE/DETAIL~SENTINEL%'))
          : () => new Promise<void>(() => undefined) })
      } catch (error) { rejected = error }
      expect(rejected).toMatchObject({ code: 'RUN_EVENT_OBSERVER_FAILED', report: { status: 'aborted' } })
      const report = (rejected as { report: unknown }).report
      expect(JSON.stringify(report)).not.toContain('OBSERVER_PRIVATE/DETAIL~SENTINEL%')
      expect(adapter.aborts).toBe(1)
      await session.whenIdle()
      await runtime.close()
    },
  )

  it('keeps an underlying run failure distinct and emits one terminal error with the same report', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new FailingAdapter())] })
    const session = runtime.agent({ id: 'underlying-failure', instructions: 'Fail', compaction: false }).createSession()
    const observed: Array<{ readonly type: string; readonly report?: unknown }> = []
    const handle = session.stream('go')
    for await (const event of handle) observed.push(event)
    const report = await handle.report
    let rejected: unknown
    try { await handle.result } catch (error) { rejected = error }
    expect(rejected).toMatchObject({ code: 'PROVIDER_SCRIPT_FAILED', report })
    const terminal = observed.filter(event => event.type === 'error')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.report).toBe(report)
    expect(observed.filter(event => event.type === 'usage')).toHaveLength(0)
    await runtime.close()
  })

  it('preserves the provider failure when strict usage accounting also reports missing usage', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new FailingAdapter())] })
    const session = runtime.agent({ id: 'primary-provider-failure', instructions: 'Fail', compaction: false })
      .createSession({ usagePolicy: { onMissing: 'fail' } })
    const handle = session.stream('start')
    const report = await handle.report
    await expect(handle.result).rejects.toMatchObject({ code: 'PROVIDER_SCRIPT_FAILED', report })
    expect(report).toMatchObject({ status: 'error', usage: {
      authoritative: false, coverage: { logicalCalls: 1, missing: 1,
        possiblyBilledAttemptsWithoutUsage: 1 },
    } })
    expect(report.modelCalls[0]?.dispatchState).toBe('unknown')
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'USAGE_REQUIRED' }),
      expect.objectContaining({
        code: 'PROVIDER_SCRIPT_FAILED', stage: 'model-call', provider: 'scripted-family',
        route: 'handle', dispatchState: 'unknown', retryable: false,
      }),
    ]))
    await runtime.close()
  })

  it('contains an oversized public-event enqueue failure and still publishes one canonical terminal event', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new OversizedEventAdapter())] })
    const session = runtime.agent({ id: 'enqueue-failure', instructions: 'Bound events', compaction: false }).createSession()
    const handle = session.stream('go')
    const events = []
    for await (const event of handle) events.push(event)
    const report = await handle.report
    let rejected: unknown
    try { await handle.result } catch (error) { rejected = error }
    expect(report.status).toBe('error')
    expect(rejected).toMatchObject({ report })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', report })
    await session.whenIdle()
    await runtime.close()
  })

  it('settles a successful eager run even when its event iterator is never acquired', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new CompleteAdapter())] })
    const session = runtime.agent({ id: 'dropped-iteration', instructions: 'Complete', compaction: false }).createSession()
    const handle = session.stream('go')
    const [response, report] = await Promise.all([handle.result, handle.report])
    expect(response.report).toBe(report)
    await session.whenIdle()
    expect(session.isRunning).toBe(false)
    await runtime.close()
  })

  it('uses onEvent only for run/generate and emits no run events from manual compaction', async () => {
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new CompleteAdapter())] })
    const agent = runtime.agent({ id: 'observer-boundary', instructions: 'Complete', compaction: false })
    const directObserver = vi.fn()
    const handle = agent.stream('go', { onEvent: directObserver })
    for await (const _event of handle) { /* direct stream consumption */ }
    await handle.result
    expect(directObserver).not.toHaveBeenCalled()
    const compactObserver = vi.fn()
    await expect(agent.createSession().compact({ onEvent: compactObserver })).resolves.toBeNull()
    expect(compactObserver).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('aborts and idles while a host tool is parked on the run signal', async () => {
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new ToolCallAdapter())] })
    const session = runtime.agent({ id: 'abort-tool', instructions: 'Use park', compaction: false,
      tools: [defineTool({ name: 'park', description: 'Park until cancelled.', parameters: { type: 'object' },
        execute: async (_args, context) => {
          enter()
          await new Promise<void>(resolve => {
            if (context.signal.aborted) { resolve(); return }
            context.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          throw new Error('PRIVATE_TOOL/CANCELLATION~SENTINEL%')
        } })] }).createSession()
    const handle = session.stream('go')
    await entered
    handle.abort('PRIVATE_CALLER/REASON~SENTINEL%')
    await expect(handle.result).rejects.toMatchObject({ report: { status: 'aborted' } })
    expect(JSON.stringify(await handle.report)).not.toContain('PRIVATE_TOOL/CANCELLATION~SENTINEL%')
    expect(JSON.stringify(await handle.report)).not.toContain('PRIVATE_CALLER/REASON~SENTINEL%')
    await session.whenIdle()
    expect(session.isRunning).toBe(false)
    await runtime.close()
  })

  it('aborts and idles while a turn hook is parked on the run signal', async () => {
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(new CompleteAdapter())] })
    const session = runtime.agent({ id: 'abort-hook', instructions: 'Wait in hook', compaction: false })
      .createSession({ hooks: { beforeStep: async context => {
        enter()
        await new Promise<void>(resolve => {
          if (context.signal.aborted) { resolve(); return }
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { kind: 'proceed' }
      } } })
    const handle = session.stream('go')
    await entered
    handle.abort({ private: 'PRIVATE_HOOK/ABORT~SENTINEL%' })
    await expect(handle.result).rejects.toMatchObject({ report: { status: 'aborted' } })
    expect(JSON.stringify(await handle.report)).not.toContain('PRIVATE_HOOK/ABORT~SENTINEL%')
    await session.whenIdle()
    expect(session.isRunning).toBe(false)
    await runtime.close()
  })
})
