import { describe, expect, it, vi } from 'vitest'
import { AgentMemory } from '../../../packages/core/src/agent/memory/memory.ts'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import { defineMemoryStore } from '../../../packages/core/src/composition/memory/definition.ts'
import { memoryStoreKey } from '../../../packages/core/src/composition/memory/key.ts'
import { createRuntimeMemoryPersistence } from '../../../packages/core/src/composition/memory/run.ts'
import type {
  MemoryBinding, MemoryCommitInput, MemoryLoadResult, MemoryStore, MemoryStoreOptions,
} from '../../../packages/core/src/composition/memory/types.ts'
import type { SdkLogger } from '../../../packages/core/src/observability/types.ts'

class MemoryAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'memory-provider', displayName: 'Memory Provider',
    routes: ['memory'], defaultModel: { provider: 'memory', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['memory'], adapter) },
  }
}

function binding(store: MemoryStore, overrides: Partial<MemoryBinding> = {}): MemoryBinding {
  return {
    store, bindingId: 'safe-binding', scope: { kind: 'conversation', namespace: 'tenant' },
    requirement: 'required', ...overrides,
  }
}

function persistentSnapshot(content = 'persisted fact') {
  return new AgentMemory([{ kind: 'fact', content }]).snapshot()
}

describe('runtime memory store authoring and binding', () => {
  it.each(['load', 'commit'] as const)('observes queued %s rejection when logging cancels before the race is installed', async stage => {
    const load = vi.fn(async () => undefined)
    const commit = vi.fn(async () => ({ revision: 'r1' }))
    const persistence = createRuntimeMemoryPersistence(binding(defineMemoryStore({ id: 'cancel-logging', load, commit })), 'agent')
    const caller = new AbortController()
    const logger = { ...options().logger, info: (message: string) => {
      if (message === `Memory ${stage} started`) caller.abort()
    } }
    const pending = stage === 'load'
      ? persistence.load('conversation', caller.signal, logger)
      : persistence.commit('conversation', persistentSnapshot(), null, caller.signal, logger)
    await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(load).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it.each(['load', 'commit'] as const)('does not dispatch %s after cancellation before its queued callback', async stage => {
    const load = vi.fn(async () => undefined)
    const commit = vi.fn(async () => ({ revision: 'r1' }))
    const persistence = createRuntimeMemoryPersistence(binding(defineMemoryStore({ id: 'cancel-queued', load, commit })), 'agent')
    const caller = new AbortController()
    const logger = options().logger
    const pending = stage === 'load'
      ? persistence.load('conversation', caller.signal, logger)
      : persistence.commit('conversation', persistentSnapshot(), null, caller.signal, logger)
    caller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    expect(load).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('captures methods once with their receiver without I/O or freezing caller state', async () => {
    const calls: string[] = []
    const originalLoad = vi.fn(function (this: { state: string }) {
      calls.push(this.state)
      return Promise.resolve(undefined)
    })
    const replacement = vi.fn(() => Promise.resolve(undefined))
    const originalCommit = vi.fn(function (this: { state: string }) {
      return Promise.resolve({ revision: `committed-${this.state}` })
    })
    const replacementCommit = vi.fn(() => Promise.resolve({ revision: 'replacement' }))
    const source = {
      id: 'borrowed-memory', state: 'live', load: originalLoad,
      commit: originalCommit,
    }
    const store = defineMemoryStore(source)
    expect(calls).toEqual([])
    expect(Object.isFrozen(store)).toBe(true)
    expect(Object.isFrozen(source)).toBe(false)
    source.load = replacement
    source.commit = replacementCommit
    source.state = 'updated'
    await store.load('key', options())
    await expect(store.commit({ key: 'key', snapshot: persistentSnapshot(), expectedRevision: null }, options()))
      .resolves.toEqual({ revision: 'committed-updated' })
    expect(originalLoad).toHaveBeenCalledOnce()
    expect(originalCommit).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(replacementCommit).not.toHaveBeenCalled()
    expect(calls).toEqual(['updated'])
  })

  it.each(['load', 'commit'])('contains a throwing %s lookup without retaining trap output', key => {
    const secret = 'PRIVATE_MEMORY_METHOD_GETTER/2F84~SENTINEL%'
    const get = vi.fn(() => { throw new Error(secret) })
    const source = { id: 'hostile-memory', load: async () => undefined,
      commit: async () => ({ revision: 'r1' }) }
    Object.defineProperty(source, key, { get })
    let error: unknown
    try { defineMemoryStore(source) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'MEMORY_STORE_INVALID' })
    expect(String(error)).not.toContain(secret)
    expect((error as Error).cause).toBeUndefined()
    expect(get).toHaveBeenCalledOnce()
  })

  it('rejects wrong markers, accessor metadata and implicit fixed sharing before store I/O', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const load = vi.fn(() => Promise.resolve(undefined))
    const store = { kind: 'not-memory', apiVersion: 1, id: 'bad', load,
      commit: () => Promise.resolve({ revision: 'r1' }) }
    expect(() => runtime.agent({ id: 'wrong-kind', instructions: 'No', memory: binding(store as never) }))
      .toThrow(expect.objectContaining({ code: 'MEMORY_STORE_KIND_MISMATCH' }))
    const read = vi.fn(() => store)
    const accessor = { bindingId: 'safe', scope: { kind: 'conversation', namespace: 'safe' }, requirement: 'required' }
    Object.defineProperty(accessor, 'store', { enumerable: true, get: read })
    expect(() => runtime.agent({ id: 'accessor', instructions: 'No', memory: accessor as never }))
      .toThrow(expect.objectContaining({ code: 'MEMORY_BINDING_INVALID' }))
    expect(read).not.toHaveBeenCalled()
    const valid = defineMemoryStore({ id: 'valid', load, commit: () => Promise.resolve({ revision: 'r1' }) })
    expect(() => runtime.agent({ id: 'fixed', instructions: 'No', memory: binding(valid, {
      scope: { kind: 'fixed', key: 'shared', sharedAcrossSessions: false } as never,
    }) })).toThrow(expect.objectContaining({ code: 'MEMORY_INVALID_SCOPE' }))
    expect(load).not.toHaveBeenCalled()
    expect(adapter.requests).toHaveLength(0)
    await runtime.close()
  })
})

describe('runtime memory persistence', () => {
  it('loads before the model, commits with the loaded revision, and snapshots only binding identity', async () => {
    const adapter = new MemoryAdapter(), operations: string[] = [], commits: MemoryCommitInput[] = []
    const namespace = 'TENANT_NAMESPACE_UNIQUE_92AA'
    const store = defineMemoryStore({
      id: 'ordered-store',
      load: async (_key, received) => {
        operations.push('load')
        expect(received.signal).toBeInstanceOf(AbortSignal)
        expect(received.logger).toBeDefined()
        return { snapshot: persistentSnapshot(), revision: 'r1' }
      },
      commit: async input => { operations.push('commit'); commits.push(input); return { revision: 'r2' } },
    })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'remembering', instructions: 'Use memory', compaction: false,
      memory: binding(store, { scope: { kind: 'conversation', namespace } }) }).createSession({ conversationId: 'conversation-a' })
    const response = await session.run('new objective')
    expect(operations).toEqual(['load', 'commit'])
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('persisted fact')
    expect(commits[0]).toMatchObject({ expectedRevision: 'r1', snapshot: { version: 1 } })
    expect(commits[0]?.snapshot.items.map(item => item.content)).toContain('new objective')
    expect(session.snapshot()).toMatchObject({ memoryBindingId: 'safe-binding' })
    const publicData = JSON.stringify({ snapshot: session.snapshot(), report: response.report, diagnostics: runtime.diagnostics() })
    expect(publicData).not.toContain(namespace)
    expect(publicData).not.toContain(commits[0]!.key)
    expect(response.report.operationCounts.memory).toMatchObject({ total: 4, success: 4, error: 0 })
    await runtime.close()
  })

  it('keeps conversation tuple keys collision-free and allows explicit fixed sharing', async () => {
    const store = defineMemoryStore({ id: 'key-store', load: async () => undefined,
      commit: async () => ({ revision: 'r1' }) })
    const first = binding(store, { scope: { kind: 'conversation', namespace: 'a|b' } })
    const second = binding(store, { scope: { kind: 'conversation', namespace: 'a' } })
    expect(memoryStoreKey(first, 'agent', 'c')).not.toBe(memoryStoreKey(second, 'agent', 'b|c'))
    expect(memoryStoreKey(binding(store, {
      scope: { kind: 'fixed', key: 'FIXED_PRIVATE_KEY_41BB', sharedAcrossSessions: true },
    }), 'agent', 'ignored')).toBe('FIXED_PRIVATE_KEY_41BB')
  })

  it('isolates tenant conversations while an explicit fixed scope shares across sessions', async () => {
    type Stored = { snapshot: ReturnType<AgentMemory['snapshot']>; revision: string }
    const adapter = new MemoryAdapter(), records = new Map<string, Stored>()
    const store = defineMemoryStore({ id: 'scoped-store',
      load: async key => records.get(key),
      commit: async input => {
        const previous = records.get(input.key)
        if ((previous?.revision ?? null) !== input.expectedRevision) throw new Error('revision conflict')
        const revision = `r${records.size + 1}-${input.snapshot.items.length}`
        records.set(input.key, { snapshot: input.snapshot, revision })
        return { revision }
      } })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const agent = runtime.agent({ id: 'scoped-agent', instructions: 'Memory', compaction: false })
    const tenantA = agent.createSession({ conversationId: 'same-conversation', memory: binding(store, {
      bindingId: 'tenant-a-binding', scope: { kind: 'conversation', namespace: 'tenant-a' },
    }) })
    const tenantB = agent.createSession({ conversationId: 'same-conversation', memory: binding(store, {
      bindingId: 'tenant-b-binding', scope: { kind: 'conversation', namespace: 'tenant-b' },
    }) })
    await tenantA.run('tenant A objective')
    await tenantB.run('tenant B objective')
    expect(records).toHaveProperty('size', 2)
    const contents = [...records.values()].map(record => record.snapshot.items.map(item => item.content))
    expect(contents).toContainEqual(['tenant A objective'])
    expect(contents).toContainEqual(['tenant B objective'])

    const shared = binding(store, { bindingId: 'shared-binding',
      scope: { kind: 'fixed', key: 'shared-conversation', sharedAcrossSessions: true } })
    await agent.createSession({ memory: shared }).run('shared first objective')
    await agent.createSession({ memory: shared }).run('shared second request')
    expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('shared first objective')
    expect(records).toHaveProperty('size', 3)
    await runtime.close()
  })

  it('applies session binding and false before the agent default', async () => {
    const adapter = new MemoryAdapter(), defaultLoad = vi.fn(async () => undefined), sessionKeys: string[] = []
    const defaultStore = defineMemoryStore({ id: 'default-store', load: defaultLoad,
      commit: async () => ({ revision: 'r1' }) })
    const sessionStore = defineMemoryStore({ id: 'session-store', load: async key => { sessionKeys.push(key); return undefined },
      commit: async () => ({ revision: 'r1' }) })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const agent = runtime.agent({ id: 'precedence', instructions: 'Memory', compaction: false, memory: binding(defaultStore) })
    const disabled = agent.createSession({ memory: false })
    await disabled.run('without persistence')
    expect(disabled.snapshot()).not.toHaveProperty('memoryBindingId')
    const overridden = agent.createSession({ memory: binding(sessionStore, {
      bindingId: 'session-binding', scope: { kind: 'fixed', key: 'shared-key', sharedAcrossSessions: true },
    }) })
    await overridden.run('with override')
    expect(defaultLoad).not.toHaveBeenCalled()
    expect(sessionKeys).toEqual(['shared-key'])
    expect(overridden.snapshot()).toMatchObject({ memoryBindingId: 'session-binding' })
    await runtime.close()
  })

  it('validates resume binding identity before any store call', async () => {
    const adapter = new MemoryAdapter(), load = vi.fn(async () => undefined)
    const store = defineMemoryStore({ id: 'resume-store', load, commit: async () => ({ revision: 'r1' }) })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const bound = runtime.agent({ id: 'resumable', instructions: 'Memory', compaction: false, memory: binding(store) })
    const source = bound.createSession({ conversationId: 'resume-conversation' })
    const snapshot = source.snapshot()
    expect(snapshot.memoryBindingId).toBe('safe-binding')
    expect(() => runtime.agent({ id: 'resumable', instructions: 'Memory', compaction: false })
      .resumeSession(snapshot)).toThrow(expect.objectContaining({ code: 'MEMORY_BINDING_REQUIRED' }))
    expect(() => bound.resumeSession(snapshot, { memory: binding(store, { bindingId: 'other-binding' }) }))
      .toThrow(expect.objectContaining({ code: 'MEMORY_BINDING_MISMATCH' }))
    expect(load).not.toHaveBeenCalled()
    const resumed = bound.resumeSession(JSON.parse(JSON.stringify(snapshot)))
    await resumed.run('continue')
    expect(load).toHaveBeenCalledOnce()
    await runtime.close()
  })

  it('fails required load before model and never converts a failed load into create', async () => {
    const adapter = new MemoryAdapter(), commit = vi.fn(async () => ({ revision: 'never' }))
    const store = defineMemoryStore({ id: 'required-load',
      load: async () => { throw new Error('PRIVATE_LOAD/BODY~SENTINEL%7BC1') }, commit })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const handle = runtime.agent({ id: 'required-load-agent', instructions: 'Memory', compaction: false,
      memory: binding(store) }).stream('do not dispatch')
    await expect(handle.result).rejects.toMatchObject({ code: 'MEMORY_LOAD_FAILED', report: {
      status: 'error', usage: { coverage: { attempts: 0 } }, errors: [expect.objectContaining({ code: 'MEMORY_LOAD_FAILED' })],
    } })
    expect(adapter.requests).toHaveLength(0)
    expect(commit).not.toHaveBeenCalled()
    expect(JSON.stringify(await handle.report)).not.toContain('PRIVATE_LOAD/BODY~SENTINEL%7BC1')
    await runtime.close()
  })

  it('degrades a best-effort load failure, skips commit, and preserves successful usage', async () => {
    const adapter = new MemoryAdapter(), commit = vi.fn(async () => ({ revision: 'never' }))
    const store = defineMemoryStore({ id: 'optional-load',
      load: async () => { throw new Error('PRIVATE_OPTIONAL/LOAD~SENTINEL%') }, commit })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const response = await runtime.agent({ id: 'optional-load-agent', instructions: 'Memory', compaction: false,
      memory: binding(store, { requirement: 'best-effort' }) }).generate('continue locally')
    expect(response.report).toMatchObject({ status: 'success', usage: { reported: { totalTokens: 5 }, authoritative: true },
      operationCounts: { memory: { error: 1 } }, errors: [expect.objectContaining({ code: 'MEMORY_LOAD_FAILED' })] })
    expect(adapter.requests).toHaveLength(1)
    expect(commit).not.toHaveBeenCalled()
    expect(JSON.stringify(response.report)).not.toContain('PRIVATE_OPTIONAL/LOAD~SENTINEL%')
    await runtime.close()
  })

  it('preserves billed usage when a required CAS commit fails and degrades best-effort commit', async () => {
    for (const requirement of ['required', 'best-effort'] as const) {
      const adapter = new MemoryAdapter(), expected: Array<string | null> = []
      const store = defineMemoryStore({ id: `commit-${requirement}`,
        load: async () => ({ snapshot: persistentSnapshot(), revision: 'loaded-r7' }),
        commit: async input => {
          expected.push(input.expectedRevision)
          throw new Error('PRIVATE_REVISION/CONFLICT~SENTINEL%')
        } })
      const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
      const handle = runtime.agent({ id: `commit-agent-${requirement}`, instructions: 'Memory', compaction: false,
        memory: binding(store, { requirement }) }).stream('run')
      if (requirement === 'required') {
        await expect(handle.result).rejects.toMatchObject({ code: 'MEMORY_COMMIT_FAILED', report: {
          status: 'error', usage: { reported: { totalTokens: 5 }, coverage: {
            logicalCalls: 1, attempts: 0, complete: 1,
          } },
        } })
      } else {
        await expect(handle.result).resolves.toMatchObject({ report: { status: 'success',
          usage: { reported: { totalTokens: 5 } }, operationCounts: { memory: { error: 1 } } } })
      }
      expect(expected).toEqual(['loaded-r7'])
      expect(JSON.stringify(await handle.report)).not.toContain('PRIVATE_REVISION/CONFLICT~SENTINEL%')
      await runtime.close()
    }
  })

  it('uses create-only revision after not-found and keeps fixed keys out of public surfaces', async () => {
    const adapter = new MemoryAdapter(), inputs: MemoryCommitInput[] = []
    const fixedKey = 'FIXED_PRIVATE_KEY/3E91C8~SENTINEL%'
    const store = defineMemoryStore({ id: 'create-only-store', load: async () => undefined,
      commit: async input => { inputs.push(input); return { revision: 'created-r1' } } })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'fixed-agent', instructions: 'Memory', compaction: false,
      memory: binding(store, { scope: { kind: 'fixed', key: fixedKey, sharedAcrossSessions: true } }) }).createSession()
    const response = await session.run('create memory')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({ key: fixedKey, expectedRevision: null })
    expect(Object.isFrozen(inputs[0])).toBe(true)
    expect(Object.isFrozen(inputs[0]?.snapshot)).toBe(true)
    expect(JSON.stringify({ snapshot: session.snapshot(), report: response.report, diagnostics: runtime.diagnostics() }))
      .not.toContain(fixedKey)
    await runtime.close()
  })

  it('captures a direct store method table at binding while allowing operational state changes', async () => {
    const adapter = new MemoryAdapter(), original = vi.fn(function (this: { revision: string }) {
      return Promise.resolve<MemoryLoadResult>({ snapshot: persistentSnapshot(), revision: this.revision })
    }), replacement = vi.fn(async () => ({ snapshot: persistentSnapshot('replacement'), revision: 'replacement' }))
    const direct = { kind: 'memory-store' as const, apiVersion: 1 as const, id: 'direct-store', revision: 'original',
      load: original, commit: async (input: MemoryCommitInput) => ({ revision: `${input.expectedRevision}:next` }) }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const agent = runtime.agent({ id: 'captured-store', instructions: 'Memory', compaction: false,
      memory: binding(direct) })
    direct.load = replacement
    direct.revision = 'mutated-state'
    await agent.generate('run')
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('keeps the borrowed store caller-owned and aborts its active call during runtime close', async () => {
    const adapter = new MemoryAdapter(), closeStore = vi.fn()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const source = { id: 'borrowed-store', close: closeStore,
      load: (_key: string, { signal }: MemoryStoreOptions) => new Promise<undefined>((_resolve, reject) => {
        entered()
        signal.addEventListener('abort', () => reject(new Error('PRIVATE_CLOSE_ABORT')), { once: true })
      }),
      commit: async () => ({ revision: 'never' }),
    }
    const store = defineMemoryStore(source)
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const handle = runtime.agent({ id: 'borrowed-agent', instructions: 'Memory', compaction: false,
      memory: binding(store) }).stream('wait')
    await started
    const closing = runtime.close()
    await expect(handle.result).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    await expect(closing).resolves.toMatchObject({ state: 'closed', operations: expect.anything() })
    expect(closeStore).not.toHaveBeenCalled()
    closeStore()
    expect(closeStore).toHaveBeenCalledOnce()
  })

  it('propagates run cancellation into an active store operation without model dispatch', async () => {
    const adapter = new MemoryAdapter()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const store = defineMemoryStore({ id: 'abort-store', load: (_key, { signal }) => new Promise((_resolve, reject) => {
      entered()
      signal.addEventListener('abort', () => reject(new Error('PRIVATE_STORE_ABORT/REASON~SENTINEL%')), { once: true })
    }), commit: async () => ({ revision: 'never' }) })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const handle = runtime.agent({ id: 'abort-memory', instructions: 'Memory', compaction: false,
      memory: binding(store) }).stream('wait')
    await started
    handle.abort('PRIVATE_CALLER_ABORT/REASON~SENTINEL%')
    await expect(handle.result).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED', report: { status: 'aborted' } })
    expect(adapter.requests).toHaveLength(0)
    const serialized = JSON.stringify(await handle.report)
    expect(serialized).not.toContain('PRIVATE_STORE_ABORT/REASON~SENTINEL%')
    expect(serialized).not.toContain('PRIVATE_CALLER_ABORT/REASON~SENTINEL%')
    await runtime.close()
  })

  it('bounds uncooperative load and reports an unacknowledged commit as outcome unknown', async () => {
    const loadAdapter = new MemoryAdapter()
    let finishLoad!: (value: undefined) => void
    const load = vi.fn(() => new Promise<undefined>(resolve => { finishLoad = resolve }))
    const neverLoad = defineMemoryStore({ id: 'never-load', load,
      commit: async () => ({ revision: 'unused' }) })
    const loadRuntime = await createRuntimeCompositionOwner({ providers: [provider(loadAdapter)] })
    const loadSession = loadRuntime.agent({ id: 'load-timeout', instructions: 'Memory', compaction: false,
      memory: binding(neverLoad) }).createSession({ runtimeLimits: { memoryOperationTimeoutMs: 10 } })
    const loadHandle = loadSession.stream('wait')
    await expect(loadHandle.result).rejects.toMatchObject({ code: 'MEMORY_LOAD_TIMEOUT' })
    const loadReport = JSON.stringify(await loadHandle.report)
    finishLoad(undefined)
    await Promise.resolve()
    expect(loadAdapter.requests).toHaveLength(0)
    expect(load).toHaveBeenCalledOnce()
    expect(JSON.stringify(await loadHandle.report)).toBe(loadReport)
    await loadRuntime.close()

    const commitAdapter = new MemoryAdapter()
    let commitEntered!: () => void
    let finishCommit!: (value: { revision: string }) => void
    const entered = new Promise<void>(resolve => { commitEntered = resolve })
    const neverCommit = defineMemoryStore({ id: 'never-commit', load: async () => undefined,
      commit: () => { commitEntered(); return new Promise(resolve => { finishCommit = resolve }) } })
    const commitRuntime = await createRuntimeCompositionOwner({ providers: [provider(commitAdapter)] })
    const commitSession = commitRuntime.agent({ id: 'commit-timeout', instructions: 'Memory', compaction: false,
      memory: binding(neverCommit) }).createSession({ runtimeLimits: { memoryOperationTimeoutMs: 10 } })
    const commitHandle = commitSession.stream('wait')
    await entered
    await expect(commitHandle.result).rejects.toMatchObject({ code: 'MEMORY_COMMIT_OUTCOME_UNKNOWN' })
    const commitReport = JSON.stringify(await commitHandle.report)
    finishCommit({ revision: 'late-r1' })
    await Promise.resolve()
    expect(commitAdapter.requests).toHaveLength(1)
    expect(JSON.stringify(await commitHandle.report)).toBe(commitReport)
    await commitRuntime.close()
  })

  it('settles promptly when an uncooperative commit is aborted after dispatch', async () => {
    const adapter = new MemoryAdapter(), commit = vi.fn()
    let entered!: () => void, finish!: (value: { revision: string }) => void
    const started = new Promise<void>(resolve => { entered = resolve })
    commit.mockImplementation(() => {
      entered()
      return new Promise(resolve => { finish = resolve })
    })
    const store = defineMemoryStore({ id: 'abort-after-dispatch', load: async () => undefined, commit })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'abort-commit', instructions: 'Memory', compaction: false,
      memory: binding(store) }).createSession()
    const handle = session.stream('wait')
    await started
    handle.abort()
    await expect(handle.result).rejects.toMatchObject({ code: 'MEMORY_COMMIT_OUTCOME_UNKNOWN' })
    const report = JSON.stringify(await handle.report)
    finish({ revision: 'late-r1' })
    await Promise.resolve()
    expect(commit).toHaveBeenCalledOnce()
    expect(JSON.stringify(await handle.report)).toBe(report)
    await runtime.close()
  })
})

function options(): MemoryStoreOptions {
  const noop = () => undefined
  const logger: SdkLogger = { child: () => logger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop }
  return { signal: new AbortController().signal, logger }
}
