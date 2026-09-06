import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ResolvedModelInfo } from '../../../packages/core/src/contract/model-info.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { ReasoningEffortId } from '../../../packages/core/src/primitives/brand.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import type { LinkedAgentResult } from '../../../packages/core/src/agent/team/types.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class LateCompactionAdapter extends ModelAdapter {
  readonly entered = deferred<void>()
  readonly blocked = deferred<void>()
  continued = false

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.entered.resolve()
    await this.blocked.promise
    this.continued = true
    const summary = '## Primary Request and Intent\n- Preserve objective.\n## Next Step\n- Continue.'
    yield { type: 'text-delta', index: 0, text: summary }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summary } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id, name: id, context: { contextWindow: 2_000 },
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }
}

class TeamAdapter extends ModelAdapter {
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'close-provider', displayName: 'Close Provider',
    routes: ['close'], defaultModel: { provider: 'close', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['close'], adapter) },
  }
}

describe('runtime concrete continuation sealing', () => {
  it('seals manual compaction result and observation publication before a late model return', async () => {
    const adapter = new LateCompactionAdapter()
    const runtime = await createRuntimeCompositionOwner({ closeTimeoutMs: 5, providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'late-compaction', instructions: 'Compact.', compaction: {
      auto: false, maxInputTokens: 100, retainTokens: 10, compactionRetries: 0,
      maxOverflowRetries: 1, maxSummaryTokens: 256,
    } }).createSession()
    session.inject(`Objective ${'A'.repeat(1_200)}`)
    session.inject(`Progress ${'B'.repeat(1_200)}`)
    const compaction = session.compact()
    await adapter.entered.promise
    const closing = await runtime.close()
    await expect(compaction).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    expect(closing.operations.find(row => row.kind === 'manual-compaction')).toMatchObject({
      activeAtClose: 1, aborted: 1, unsettled: 1,
    })
    const afterClose = runtime.diagnostics()
    adapter.blocked.resolve()
    await vi.waitFor(() => expect(adapter.continued).toBe(true))
    await Promise.resolve()
    expect(runtime.diagnostics()).toEqual(afterClose)
  })

  it('does not publish a linked-team result after its sealed send returns late', async () => {
    const runtime = await createRuntimeCompositionOwner({ closeTimeoutMs: 20,
      providers: [provider(new TeamAdapter())] })
    const local = runtime.agent({ id: 'late-team-agent', instructions: 'Lead.', compaction: false })
    const events: unknown[] = []
    const remote = deferred<LinkedAgentResult>()
    let physicalSettled = false
    const team = runtime.team({ id: 'late-team', onEvent: event => events.push(event),
      members: [{ name: 'lead', agent: local }] })
    team.linkAgent({ name: 'remote', transport: { protocol: 'test', agentId: 'remote',
      send: async () => { const result = await remote.promise; physicalSettled = true; return result } } })
    const sending = team.sendMessage({ from: 'lead', target: 'remote', message: 'wait', delivery: 'wakeup' })
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'member-run-start', member: 'remote' }))
    const closing = await runtime.close()
    await expect(sending).rejects.toBeDefined()
    expect(closing.operations.find(row => row.kind === 'team-operation')).toMatchObject({
      activeAtClose: 2, aborted: 2, settled: 1, unsettled: 1,
    })
    const sealedEvents = structuredClone(events)
    remote.resolve({ kind: 'message', succeeded: true, text: 'PRIVATE_LATE/TEAM~SENTINEL%',
      contextId: 'late-context' })
    await vi.waitFor(() => expect(physicalSettled).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(sealedEvents)
    expect(JSON.stringify(runtime.diagnostics())).not.toContain('PRIVATE_LATE/TEAM~SENTINEL%')
  })
})
