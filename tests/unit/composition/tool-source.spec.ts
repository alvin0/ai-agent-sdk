import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { ToolCallId } from '../../../packages/core/src/primitives/brand.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import { defineToolSource } from '../../../packages/core/src/composition/tool-source/definition.ts'
import type { ToolCatalogSnapshot, ToolSource } from '../../../packages/core/src/composition/tool-source/types.ts'

class SourceAdapter extends ModelAdapter {
  calls = 0
  afterFirstRequest?: () => void
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    if (this.calls % 2 === 1) {
      this.afterFirstRequest?.()
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId(`source-${this.calls}`), name: 'remote', arguments: '{}',
      } }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    expect(options.messages.some(message => message.source.kind === 'tool')).toBe(true)
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class FinishAdapter extends ModelAdapter {
  calls = 0
  async * stream(): AsyncIterable<StreamChunk> {
    this.calls++
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function provider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return {
    kind: 'model-provider-plugin', apiVersion: 1, id: 'source-provider', displayName: 'Source Provider',
    routes: ['source'], defaultModel: { provider: 'source', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['source'], adapter) },
  }
}

describe('tool source composition', () => {
  it('uses the tool-name namespace for definition and session-local collisions', async () => {
    const adapter = new SourceAdapter()
    const collisionName = 'CREDENTIAL_PATH/tools/private-key.json~SENTINEL%'
    const duplicate = { name: collisionName, description: 'Tool', parameters: { type: 'object' }, execute: () => null }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    let definitionError: unknown
    try {
      runtime.agent({ id: 'definition-tools', instructions: 'No run', tools: [duplicate, duplicate], compaction: false })
    } catch (error) { definitionError = error }
    expect(definitionError).toMatchObject({
      code: 'TOOL_NAME_CONFLICT',
      conflict: { namespace: 'tool-name', key: '[redacted]', firstIndex: 0, secondIndex: 1 },
    })
    expect(JSON.stringify(definitionError)).not.toContain(collisionName)
    expect(Object.isFrozen((definitionError as { conflict: unknown }).conflict)).toBe(true)
    const agent = runtime.agent({ id: 'session-tools', instructions: 'No run', tools: [duplicate], compaction: false })
    expect(() => agent.createSession({ tools: [duplicate] })).toThrow(expect.objectContaining({
      code: 'TOOL_NAME_CONFLICT',
      conflict: { namespace: 'tool-name', key: '[redacted]', firstIndex: 0, secondIndex: 1 },
    }))
    expect(adapter.calls).toBe(0)
    await runtime.close()
  })

  it('defines a frozen wrapper without I/O, mutation or receiver loss', () => {
    const snapshot = vi.fn(function (this: { revision: string }) {
      return { revision: this.revision, tools: [] }
    })
    const definition = { id: 'remote-source', revision: 'r1', snapshot }
    const source = defineToolSource(definition)
    expect(source).not.toBe(definition)
    expect(Object.isFrozen(source)).toBe(true)
    expect(Object.isFrozen(definition)).toBe(false)
    expect(snapshot).not.toHaveBeenCalled()
    definition.revision = 'r2'
    definition.snapshot = vi.fn(() => ({ revision: 'replaced', tools: [] }))
    Reflect.deleteProperty(definition, 'snapshot')
    expect(source.snapshot({ signal: new AbortController().signal, logger: loggerStub() })).toMatchObject({ revision: 'r2' })
    expect(snapshot).toHaveBeenCalledOnce()
  })

  it('contains a throwing snapshot lookup without retaining private trap output', () => {
    const secret = 'PRIVATE_TOOL_SOURCE_GETTER/9A4E~SENTINEL%'
    const get = vi.fn(() => { throw new Error(secret) })
    const source = { id: 'hostile-source' }
    Object.defineProperty(source, 'snapshot', { get })
    let error: unknown
    try { defineToolSource(source as never) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'TOOL_SOURCE_SNAPSHOT_INVALID' })
    expect(String(error)).not.toContain(secret)
    expect((error as Error).cause).toBeUndefined()
    expect(get).toHaveBeenCalledOnce()
  })

  it('captures a direct marked source once while leaving its operational state live', async () => {
    const adapter = new FinishAdapter()
    const original = vi.fn(function (this: { revision: string }) {
      return { revision: this.revision, tools: [] }
    })
    const replacement = vi.fn(() => ({ revision: 'replacement', tools: [] }))
    const source = { kind: 'tool-source' as const, apiVersion: 1 as const,
      id: 'direct-source', revision: 'r1', snapshot: original }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const agent = runtime.agent({ id: 'direct-source-agent', instructions: 'Run',
      toolSources: [source], compaction: false })
    source.id = 'mutated-source'
    source.revision = 'r2'
    source.snapshot = replacement
    Reflect.deleteProperty(source, 'snapshot')
    await expect(agent.generate('go')).resolves.toMatchObject({ report: {
      toolSourceSnapshots: [{ sourceId: 'direct-source', revision: 'r2' }],
    } })
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(Object.isFrozen(source)).toBe(false)
    await runtime.close()
  })

  it('snapshots once per run, preserves that generation and records only source identity', async () => {
    const adapter = new SourceAdapter()
    const first = vi.fn(() => ({ value: 'PRIVATE_TOOL_RESULT/FIRST~SENTINEL%' }))
    const second = vi.fn(() => ({ value: 'PRIVATE_TOOL_RESULT/SECOND~SENTINEL%' }))
    let revision = 'revision-1', execute = first
    const seenLoggers: unknown[] = []
    const source = defineToolSource({ id: 'remote-source', snapshot({ logger }) {
      seenLoggers.push(logger)
      return { revision, tools: [{ name: 'remote', description: revision, parameters: { type: 'object' }, execute }] }
    } })
    adapter.afterFirstRequest = () => { revision = 'revision-mutated-during-run'; execute = second }
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'source-agent', instructions: 'Use remote', toolSources: [source], compaction: false }).createSession()
    const firstResponse = await session.run('first')
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(firstResponse.report.toolSourceSnapshots).toEqual([{ sourceId: 'remote-source', revision: 'revision-1' }])
    expect(JSON.stringify(firstResponse.report)).not.toContain('PRIVATE_TOOL_RESULT/FIRST~SENTINEL%')

    adapter.afterFirstRequest = () => undefined
    revision = 'revision-2'
    const secondResponse = await session.run('second')
    expect(second).toHaveBeenCalledOnce()
    expect(secondResponse.report.toolSourceSnapshots).toEqual([{ sourceId: 'remote-source', revision: 'revision-2' }])
    expect(seenLoggers).toHaveLength(2)
    expect(seenLoggers.every(value => value !== undefined)).toBe(true)
    await runtime.close()
  })

  it('keeps a completed snapshot immutable when the next refresh collides, then recovers', async () => {
    const adapter = new FinishAdapter()
    let revision = 'valid-r1'
    let tools: ToolCatalogSnapshot['tools'] = []
    const source = defineToolSource({ id: 'refresh-source', snapshot: () => ({ revision, tools }) })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'refresh-agent', instructions: 'No dispatch on collision',
      toolSources: [source], compaction: false }).createSession()
    const first = await session.run('valid')
    expect(first.report.toolSourceSnapshots).toEqual([{ sourceId: 'refresh-source', revision: 'valid-r1' }])
    revision = 'colliding-r2'
    tools = [
      { name: 'collision', description: 'PRIVATE_TOOL_CONTENT/FIRST~SENTINEL%', parameters: {}, execute: () => null },
      { name: 'collision', description: 'PRIVATE_TOOL_CONTENT/SECOND~SENTINEL%', parameters: {}, execute: () => null },
    ]
    const before = session.snapshot()
    const collision = await session.run('must not persist').catch((error: unknown) => error)
    expect(collision).toMatchObject({ code: 'TOOL_NAME_CONFLICT', conflict: {
      namespace: 'tool-name', key: '[redacted]', firstIndex: 0, secondIndex: 1,
    } })
    expect(JSON.stringify(collision)).not.toContain('PRIVATE_TOOL_CONTENT/FIRST~SENTINEL%')
    expect(session.snapshot()).toEqual(before)
    expect(first.report.toolSourceSnapshots).toEqual([{ sourceId: 'refresh-source', revision: 'valid-r1' }])
    expect(adapter.calls).toBe(1)
    revision = 'valid-r3'; tools = []
    await expect(session.run('recovered')).resolves.toMatchObject({
      report: { toolSourceSnapshots: [{ sourceId: 'refresh-source', revision: 'valid-r3' }] },
    })
    expect(adapter.calls).toBe(2)
    await runtime.close()
  })

  it('fails a snapshot without stale fallback, model dispatch or history mutation', async () => {
    const adapter = new SourceAdapter(), snapshot = vi.fn(() => { throw new Error('private snapshot detail') })
    const source = defineToolSource({ id: 'failing-source', snapshot })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const session = runtime.agent({ id: 'failing-agent', instructions: 'No dispatch', toolSources: [source], compaction: false }).createSession()
    const before = session.snapshot()
    await expect(session.run('do not retain')).rejects.toMatchObject({ code: 'TOOL_SOURCE_SNAPSHOT_FAILED' })
    expect(adapter.calls).toBe(0)
    expect(session.snapshot()).toEqual(before)
    snapshot.mockImplementation(() => ({ revision: 'recovered', tools: [] }) as never)
    await session.run('now run')
    expect(adapter.calls).toBe(1)
    await runtime.close()
  })

  it('rejects source/local and source/source tool collisions before model dispatch', async () => {
    const adapter = new SourceAdapter()
    const source = (id: string): ToolSource => defineToolSource({ id, snapshot: () => ({ revision: 'r1', tools: [
      { name: 'remote', description: 'Remote', parameters: { type: 'object' }, execute: () => null },
    ] }) })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    const localCollision = runtime.agent({ id: 'local-collision', instructions: 'No dispatch', tools: [
      { name: 'remote', description: 'Local', parameters: { type: 'object' }, execute: () => null },
    ], toolSources: [source('one')], compaction: false })
    await expect(localCollision.generate('go')).rejects.toMatchObject({
      code: 'TOOL_NAME_CONFLICT',
      conflict: { namespace: 'tool-name', key: '[redacted]', firstIndex: 0, secondIndex: 1 },
      report: { status: 'error' },
    })
    expect(adapter.calls).toBe(0)

    const sourceCollision = runtime.agent({ id: 'source-collision', instructions: 'No dispatch',
      toolSources: [source('two'), source('three')], compaction: false })
    await expect(sourceCollision.generate('go')).rejects.toMatchObject({
      code: 'TOOL_NAME_CONFLICT',
      conflict: { namespace: 'tool-name', key: '[redacted]', firstIndex: 0, secondIndex: 1 },
      report: { status: 'error' },
    })
    expect(adapter.calls).toBe(0)
    await runtime.close()
  })

  it('rejects identity conflicts, malformed generations and pre-aborted runs before source access', async () => {
    const adapter = new SourceAdapter(), snapshot = vi.fn(() => ({ revision: '', tools: [] }))
    const source = defineToolSource({ id: 'same', snapshot })
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    expect(() => runtime.agent({ id: 'duplicate-source', instructions: 'No run', toolSources: [source, source] }))
      .toThrow(expect.objectContaining({ code: 'TOOL_SOURCE_ID_CONFLICT', conflict: {
        namespace: 'tool-source-id', key: '[redacted]', firstIndex: 0, secondIndex: 1,
      } }))
    const agent = runtime.agent({ id: 'invalid-generation', instructions: 'No dispatch', toolSources: [source], compaction: false })
    await expect(agent.generate('go')).rejects.toMatchObject({ code: 'TOOL_SOURCE_SNAPSHOT_INVALID' })
    expect(adapter.calls).toBe(0)
    const controller = new AbortController(); controller.abort()
    expect(() => agent.stream('aborted', { signal: controller.signal })).toThrow(expect.objectContaining({ code: 'RUNTIME_OPERATION_ABORTED' }))
    expect(snapshot).toHaveBeenCalledOnce()
    await runtime.close()
  })

  it('rejects async snapshots and bounded revision/count/byte violations before model dispatch', async () => {
    const adapter = new SourceAdapter()
    const cases: readonly { id: string; source: ToolSource; code: string }[] = [
      { id: 'async', code: 'TOOL_SOURCE_SNAPSHOT_INVALID', source: defineToolSource({
        id: 'async-source', snapshot: (async () => { throw new Error('async private rejection') }) as never,
      }) },
      { id: 'revision', code: 'TOOL_SOURCE_SNAPSHOT_INVALID', source: defineToolSource({
        id: 'revision-source', snapshot: () => ({ revision: 'r'.repeat(257), tools: [] }),
      }) },
      { id: 'count', code: 'TOOL_SOURCE_SNAPSHOT_INVALID', source: defineToolSource({
        id: 'count-source', snapshot: () => ({ revision: 'r1', tools: Array.from({ length: 1_025 }, (_, index) => ({
          name: `tool-${index}`, description: 'Tool', parameters: { type: 'object' }, execute: () => null,
        })) }),
      }) },
      { id: 'bytes', code: 'TOOL_SOURCE_SNAPSHOT_INVALID', source: defineToolSource({
        id: 'bytes-source', snapshot: () => ({ revision: 'r1', tools: Array.from({ length: 1_024 }, (_, index) => ({
          name: `tool-${index}`, description: 'd'.repeat(16 * 1024), parameters: { type: 'object' }, execute: () => null,
        })) }),
      }) },
    ]
    const runtime = await createRuntimeCompositionOwner({ providers: [provider(adapter)] })
    for (const entry of cases) {
      const session = runtime.agent({ id: `bounded-${entry.id}`, instructions: 'No dispatch',
        toolSources: [entry.source], compaction: false }).createSession()
      const before = session.snapshot()
      await expect(session.run('go')).rejects.toMatchObject({ code: entry.code })
      expect(session.snapshot()).toEqual(before)
    }
    await Promise.resolve()
    expect(adapter.calls).toBe(0)
    await runtime.close()
  })
})

function loggerStub() {
  const logger = {
    child: () => logger,
    trace: () => undefined, debug: () => undefined, info: () => undefined,
    warn: () => undefined, error: () => undefined, fatal: () => undefined,
  }
  return logger
}
