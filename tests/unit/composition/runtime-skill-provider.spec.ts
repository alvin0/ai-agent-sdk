import { describe, expect, it, vi } from 'vitest'
import { SkillCatalog } from '../../../packages/core/src/agent/skill/catalog.ts'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { ToolCallId } from '../../../packages/core/src/primitives/brand.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import type { ComposableModelProviderPlugin } from '../../../packages/core/src/composition/provider/types.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import { defineSkillProviderPlugin } from '../../../packages/core/src/composition/skill-provider/definition.ts'
import { defineSkill } from '../../../packages/core/src/agent/skill/definition.ts'
import type {
  RuntimeSkillCandidate, RuntimeSkillLookupOptions, SkillProviderPlugin, SkillReference,
} from '../../../packages/core/src/composition/skill-provider/types.ts'

class SkillAdapter extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  private requestedSkill = false
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (!this.requestedSkill) {
      this.requestedSkill = true
      yield { type: 'block-end', index: 0, block: { type: 'tool-call',
        id: ToolCallId('load-skill-1'), name: 'load_skill', arguments: '{"skillId":"deep-research"}' } }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function modelProvider(adapter: ModelAdapter): ComposableModelProviderPlugin {
  return { kind: 'model-provider-plugin', apiVersion: 1, id: 'skill-model', displayName: 'Skill Model',
    routes: ['skill-model'], defaultModel: { provider: 'skill-model', id: 'model' },
    setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['skill-model'], adapter) } }
}

function candidate(locator: unknown = { generation: 1, token: 'PRIVATE_LOCATOR/8D19~SENTINEL%' }): RuntimeSkillCandidate {
  return { id: 'deep-research', name: 'Deep Research', description: 'Research with audits.',
    whenToUse: 'Use for multi-source reports.', source: 'remote-catalog', provider: 'research-skills',
    locator: locator as never }
}

function skillProvider(overrides: Partial<SkillProviderPlugin> = {}) {
  let revision = 'catalog-r1'
  let candidates: readonly RuntimeSkillCandidate[] = [candidate()]
  const list = vi.fn(async (_options: RuntimeSkillLookupOptions) => ({ revision, candidates }))
  const load = vi.fn(async (reference: SkillReference, _options: RuntimeSkillLookupOptions) =>
    reference.catalogRevision === revision && candidates.some(item => item.id === reference.id)
      ? { id: reference.id, name: 'Deep Research', description: 'Research with audits.',
        instructions: 'PRIVATE_LOADED_INSTRUCTIONS/7F31~SENTINEL%', source: reference.source,
        resourceManifest: [{ path: 'guide/report.md', sizeChars: 20 }],
        resourceBase: { kind: 'opaque' as const, value: 'bundle-v1' } }
      : undefined)
  const readResource = vi.fn(async (
    _reference: SkillReference, path: string, _options: RuntimeSkillLookupOptions,
  ) =>
    path === 'guide/report.md' ? 'PRIVATE_RESOURCE_CONTENT/4A82~SENTINEL%' : undefined)
  const plugin = defineSkillProviderPlugin({ id: 'research-skills', list, load, readResource, ...overrides })
  return { plugin, list, load, readResource,
    setRevision(value: string) { revision = value },
    setCandidates(value: readonly RuntimeSkillCandidate[]) { candidates = value } }
}

describe('versioned skill provider authoring and catalog', () => {
  it('uses the skill-id namespace for duplicate inline definitions', () => {
    const skill = defineSkill({ id: 'duplicate-skill', name: 'Duplicate', description: 'Duplicate.',
      instructions: 'Use it.', source: 'inline' })
    expect(() => new SkillCatalog([skill, skill])).toThrow(expect.objectContaining({
      code: 'SKILL_ID_CONFLICT',
      conflict: { namespace: 'skill-id', key: '[redacted]', firstIndex: 0, secondIndex: 1 },
    }))
  })

  it('preflights duplicate inline skills in runtime definition and session scopes', async () => {
    const skill = defineSkill({ id: 'runtime-duplicate', name: 'Duplicate', description: 'Duplicate.',
      instructions: 'Use it.', source: 'inline' })
    const runtime = await createRuntimeCompositionOwner({ providers: [modelProvider(new SkillAdapter())] })
    expect(() => runtime.agent({ id: 'duplicate-definition-skill', instructions: 'No run',
      skills: [skill, skill], compaction: false })).toThrow(expect.objectContaining({
      code: 'SKILL_ID_CONFLICT',
      conflict: { namespace: 'skill-id', key: '[redacted]', firstIndex: 0, secondIndex: 1 },
    }))
    const agent = runtime.agent({ id: 'duplicate-session-skill', instructions: 'No run',
      skills: [skill], compaction: false })
    expect(() => agent.createSession({ skills: [skill] })).toThrow(expect.objectContaining({
      code: 'SKILL_ID_CONFLICT',
      conflict: { namespace: 'skill-id', key: '[redacted]', firstIndex: 0, secondIndex: 1 },
    }))
    await runtime.close()
  })

  it('captures methods once, keeps caller state mutable, and performs no provider I/O', async () => {
    const calls: string[] = []
    const source = { id: 'stateful-skills', state: 'initial',
      list: vi.fn(function (this: { state: string }) {
        calls.push(this.state)
        return Promise.resolve({ revision: 'r1', candidates: [] })
      }),
      load: vi.fn(function (this: { state: string }) { calls.push(`load:${this.state}`); return Promise.resolve(undefined) }),
      readResource: vi.fn(function (this: { state: string }) { calls.push(`resource:${this.state}`); return Promise.resolve(undefined) }) }
    const original = source.list, originalLoad = source.load, originalResource = source.readResource
    const plugin = defineSkillProviderPlugin(source)
    expect(calls).toEqual([])
    expect(Object.isFrozen(plugin)).toBe(true)
    expect(Object.isFrozen(source)).toBe(false)
    source.state = 'mutated-state'
    source.list = vi.fn(async () => ({ revision: 'replacement', candidates: [] })) as typeof source.list
    source.load = vi.fn(async () => undefined) as typeof source.load
    source.readResource = vi.fn(async () => undefined) as typeof source.readResource
    await new SkillCatalog([plugin]).discover()
    const options = { signal: new AbortController().signal, logger: {} } as RuntimeSkillLookupOptions
    const reference = { id: 'unused', source: 'unit', provider: 'stateful-skills', catalogRevision: 'r1' }
    await plugin.load(reference, options)
    await plugin.readResource?.(reference, 'guide.md', options)
    expect(original).toHaveBeenCalledOnce()
    expect(originalLoad).toHaveBeenCalledOnce()
    expect(originalResource).toHaveBeenCalledOnce()
    expect(source.list).not.toHaveBeenCalled()
    expect(source.load).not.toHaveBeenCalled()
    expect(source.readResource).not.toHaveBeenCalled()
    expect(calls).toEqual(['mutated-state', 'load:mutated-state', 'resource:mutated-state'])
  })

  it.each(['list', 'load', 'readResource'])('contains a throwing %s lookup without retaining trap output', key => {
    const secret = 'PRIVATE_SKILL_METHOD_GETTER/3B71~SENTINEL%'
    const get = vi.fn(() => { throw new Error(secret) })
    const source = { id: 'hostile-skills', list: async () => ({ revision: 'r1', candidates: [] }),
      load: async () => undefined, readResource: async () => undefined }
    Object.defineProperty(source, key, { get })
    let error: unknown
    try { defineSkillProviderPlugin(source) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'SKILL_PROVIDER_INVALID' })
    expect(String(error)).not.toContain(secret)
    expect((error as Error).cause).toBeUndefined()
    expect(get).toHaveBeenCalledOnce()
  })

  it('captures a direct marked provider once while leaving its operational state live', async () => {
    const calls: string[] = []
    const original = vi.fn(function (this: { revision: string }) {
      calls.push(this.revision)
      return Promise.resolve({ revision: this.revision, candidates: [] })
    })
    const replacement = vi.fn(async () => ({ revision: 'replacement', candidates: [] }))
    const source = { kind: 'skill-provider' as const, apiVersion: 1 as const,
      id: 'direct-skills', revision: 'r1', list: original, load: async () => undefined }
    const catalog = new SkillCatalog([source])
    source.id = 'mutated-skills'
    source.revision = 'r2'
    source.list = replacement
    Reflect.deleteProperty(source, 'list')
    await expect(catalog.discover()).resolves.toEqual([])
    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(calls).toEqual(['r2'])
    expect(Object.isFrozen(source)).toBe(false)
  })

  it('stamps one detached reference, passes signal/logger, reads only advertised safe paths, and refreshes revision', async () => {
    const fixture = skillProvider(), catalog = new SkillCatalog([fixture.plugin])
    const summaries = await catalog.discover()
    expect(summaries).toMatchObject([{ id: 'deep-research', provider: 'research-skills' }])
    const listOptions = fixture.list.mock.calls[0]?.[0]
    expect(listOptions?.signal).toBeInstanceOf(AbortSignal)
    expect(listOptions?.logger).toBeDefined()
    const loaded = await catalog.activate('deep-research')
    expect(loaded?.instructions).toBe('PRIVATE_LOADED_INSTRUCTIONS/7F31~SENTINEL%')
    const reference = catalog.activatedSkillReferences()[0]
    expect(reference).toEqual({ id: 'deep-research', source: 'remote-catalog', provider: 'research-skills',
      catalogRevision: 'catalog-r1', locator: { generation: 1, token: 'PRIVATE_LOCATOR/8D19~SENTINEL%' },
      resourceBase: { kind: 'opaque', value: 'bundle-v1' } })
    expect(Object.isFrozen(reference?.locator)).toBe(true)
    expect(fixture.load.mock.calls[0]?.[0]).toEqual({ id: 'deep-research', source: 'remote-catalog',
      provider: 'research-skills', catalogRevision: 'catalog-r1',
      locator: { generation: 1, token: 'PRIVATE_LOCATOR/8D19~SENTINEL%' } })
    await expect(catalog.readResource('deep-research', '../private')).rejects.toThrow(/normalized relative path/)
    expect(fixture.readResource).not.toHaveBeenCalled()
    await expect(catalog.readResource('deep-research', 'guide/report.md'))
      .resolves.toBe('PRIVATE_RESOURCE_CONTENT/4A82~SENTINEL%')
    expect(fixture.readResource.mock.calls[0]?.[0]).toEqual(fixture.load.mock.calls[0]?.[0])
    expect(fixture.readResource.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal)
    expect(fixture.readResource.mock.calls[0]?.[2].logger).toBeDefined()
    fixture.setRevision('catalog-r2')
    fixture.setCandidates([candidate({ generation: 2 })])
    await catalog.discover()
    expect(catalog.isActivated('deep-research')).toBe(false)
    expect(catalog.activatedSkillReferences()).toEqual([])
  })

  it('rejects provider ownership, malformed locator and duplicate candidates atomically', async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const [candidates, code] of [
      [[{ ...candidate(), provider: 'forged-provider' }], 'SKILL_CATALOG_INVALID'],
      [[candidate(cycle)], 'SKILL_CATALOG_INVALID'],
      [[candidate(() => undefined)], 'SKILL_CATALOG_INVALID'],
      [[candidate('x'.repeat(64 * 1024 + 1))], 'SKILL_CATALOG_INVALID'],
      [[candidate(), candidate({ generation: 2 })], 'SKILL_ID_CONFLICT'],
    ] as const) {
      const load = vi.fn(async () => undefined)
      const plugin = defineSkillProviderPlugin({ id: 'research-skills',
        list: async () => ({ revision: 'r1', candidates: candidates as never }), load })
      const catalog = new SkillCatalog([plugin])
      await expect(catalog.discover()).rejects.toMatchObject({ code })
      expect(catalog.summaries()).toEqual([])
      expect(load).not.toHaveBeenCalled()
    }
  })

  it('reports skill-id collisions support-safely and preserves the last valid refresh', async () => {
    const fixture = skillProvider(), catalog = new SkillCatalog([fixture.plugin])
    const valid = await catalog.discover()
    fixture.setRevision('catalog-r2')
    fixture.setCandidates([candidate({ generation: 2 }), candidate({ generation: 3 })])
    const collision = await catalog.discover().catch((error: unknown) => error)
    expect(collision).toMatchObject({ code: 'SKILL_ID_CONFLICT', conflict: {
      namespace: 'skill-id', key: '[redacted]', firstIndex: 0, secondIndex: 1,
    } })
    expect(JSON.stringify(collision)).not.toContain('PRIVATE_LOCATOR/8D19~SENTINEL%')
    expect(catalog.summaries()).toBe(valid)
    expect(catalog.summaries()).toMatchObject([{ id: 'deep-research', provider: 'research-skills' }])
  })

  it('honors allowlists and rejects duplicate provider IDs before list access', async () => {
    const first = skillProvider(), second = skillProvider()
    expect(() => new SkillCatalog([first.plugin, second.plugin]))
      .toThrow(expect.objectContaining({ code: 'SKILL_PROVIDER_ID_CONFLICT', conflict: {
        namespace: 'skill-provider-id', key: '[redacted]', firstIndex: 0, secondIndex: 1,
      } }))
    expect(first.list).not.toHaveBeenCalled()
    expect(second.list).not.toHaveBeenCalled()
    const catalog = new SkillCatalog([first.plugin], { allowedSkillIds: ['deep-research'] })
    await catalog.discover()
    expect(first.list.mock.calls[0]?.[0]).toMatchObject({ allowedSkillIds: ['deep-research'] })
  })
})

describe('runtime skill references and cancellation', () => {
  it('persists only the exact reference and rehydrates it with the same provider method table', async () => {
    const fixture = skillProvider(), adapter = new SkillAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [modelProvider(adapter)] })
    const agent = runtime.agent({ id: 'research-agent', instructions: 'Use skills', skills: [fixture.plugin], compaction: false })
    const session = agent.createSession({ conversationId: 'research-conversation' })
    const response = await session.run('research this')
    const snapshot = session.snapshot()
    expect(snapshot.skills?.activated).toEqual([{ id: 'deep-research', source: 'remote-catalog',
      provider: 'research-skills', catalogRevision: 'catalog-r1',
      locator: { generation: 1, token: 'PRIVATE_LOCATOR/8D19~SENTINEL%' },
      resourceBase: { kind: 'opaque', value: 'bundle-v1' } }])
    const serializedSkills = JSON.stringify(snapshot.skills)
    expect(serializedSkills).not.toContain('PRIVATE_LOADED_INSTRUCTIONS/7F31~SENTINEL%')
    expect(serializedSkills).not.toContain('PRIVATE_RESOURCE_CONTENT/4A82~SENTINEL%')
    const diagnostics = JSON.stringify(runtime.diagnostics())
    expect(diagnostics).not.toContain('PRIVATE_LOCATOR/8D19~SENTINEL%')
    expect(diagnostics).not.toContain('PRIVATE_LOADED_INSTRUCTIONS/7F31~SENTINEL%')
    expect(diagnostics).not.toContain('PRIVATE_RESOURCE_CONTENT/4A82~SENTINEL%')
    expect(fixture.list.mock.calls[0]?.[0].logger).toBe(fixture.load.mock.calls[0]?.[1].logger)
    expect(fixture.list.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    expect(fixture.load.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    const loadCount = fixture.load.mock.calls.length
    const resumed = agent.resumeSession(JSON.parse(JSON.stringify(snapshot)))
    await resumed.run('continue')
    expect(fixture.load.mock.calls).toHaveLength(loadCount + 1)
    expect(fixture.load.mock.calls.at(-1)?.[0]).toEqual(fixture.load.mock.calls[0]?.[0])
    expect(response.report.status).toBe('success')
    await runtime.close()
  })

  it('fails stale and removed references before the next model request', async () => {
    for (const mode of ['stale', 'removed'] as const) {
      const fixture = skillProvider(), adapter = new SkillAdapter()
      const runtime = await createRuntimeCompositionOwner({ providers: [modelProvider(adapter)] })
      const agent = runtime.agent({ id: `stale-${mode}`, instructions: 'Use skills', skills: [fixture.plugin], compaction: false })
      const session = agent.createSession()
      await session.run('activate')
      const snapshot = session.snapshot(), requestsBefore = adapter.requests.length
      if (mode === 'stale') fixture.setRevision('catalog-r2')
      else fixture.setCandidates([])
      const handle = agent.resumeSession(snapshot).stream('continue')
      await expect(handle.result).rejects.toMatchObject({ code: 'SKILL_REFERENCE_UNAVAILABLE', report: { status: 'error' } })
      expect(adapter.requests).toHaveLength(requestsBefore)
      await runtime.close()
    }
  })

  it('rejects forged or malformed resume references before provider code', async () => {
    const fixture = skillProvider(), adapter = new SkillAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [modelProvider(adapter)] })
    const agent = runtime.agent({ id: 'forgery-agent', instructions: 'Use skills', skills: [fixture.plugin], compaction: false })
    const base = agent.createSession().snapshot()
    const forged = { ...base, skills: { activated: [{ id: 'deep-research', source: 'remote-catalog',
      provider: 'forged-provider', catalogRevision: 'r1', locator: { safe: true } }] } }
    expect(() => agent.resumeSession(forged)).toThrow(expect.objectContaining({ code: 'SKILL_REFERENCE_INVALID' }))
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    const malformed = { ...base, skills: { activated: [{ id: 'deep-research', source: 'remote-catalog',
      provider: 'research-skills', catalogRevision: 'r1', locator: cycle }] } }
    expect(() => agent.resumeSession(malformed as never)).toThrow(expect.objectContaining({ code: 'SKILL_REFERENCE_INVALID' }))
    expect(fixture.list).not.toHaveBeenCalled()
    expect(fixture.load).not.toHaveBeenCalled()
    await runtime.close()
  })

  it('aborts before list access, during provider I/O, and during runtime close', async () => {
    const preList = vi.fn(async () => ({ revision: 'r1', candidates: [] }))
    const pre = defineSkillProviderPlugin({ id: 'pre-abort', list: preList, load: async () => undefined })
    const aborted = new AbortController(); aborted.abort('PRIVATE_PRE_ABORT')
    await expect(new SkillCatalog([pre]).discover({ signal: aborted.signal })).rejects.toBe('PRIVATE_PRE_ABORT')
    expect(preList).not.toHaveBeenCalled()

    let loadEntered!: () => void
    const loading = new Promise<void>(resolve => { loadEntered = resolve })
    const loadPlugin = defineSkillProviderPlugin({ id: 'load-abort',
      list: async () => ({ revision: 'r1', candidates: [{ ...candidate(), provider: 'load-abort' }] }),
      load: (_reference, options) => new Promise((_resolve, reject) => {
        loadEntered()
        options.signal.addEventListener('abort', () => reject(new Error('PRIVATE_LOAD_ABORT')), { once: true })
      }) })
    const loadCatalog = new SkillCatalog([loadPlugin])
    await loadCatalog.discover()
    const loadAbort = new AbortController()
    const activation = loadCatalog.activate('deep-research', { signal: loadAbort.signal })
    await loading
    loadAbort.abort('PRIVATE_CALLER_ABORT')
    await expect(activation).rejects.toBe('PRIVATE_CALLER_ABORT')

    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const closeSkillProvider = { id: 'close-skills', close: vi.fn(),
      list: (options: RuntimeSkillLookupOptions) => new Promise<never>((_resolve, reject) => {
        entered()
        options.signal.addEventListener('abort', () => reject(new Error('PRIVATE_CLOSE/REASON~SENTINEL%')), { once: true })
      }), load: async () => undefined }
    const closeProvider = defineSkillProviderPlugin(closeSkillProvider)
    const adapter = new SkillAdapter()
    const runtime = await createRuntimeCompositionOwner({ providers: [modelProvider(adapter)] })
    const handle = runtime.agent({ id: 'close-agent', instructions: 'Skills', skills: [closeProvider], compaction: false }).stream('wait')
    await started
    const closing = runtime.close()
    await expect(handle.result).rejects.toMatchObject({ report: { status: 'aborted' } })
    await expect(closing).resolves.toMatchObject({ state: 'closed' })
    expect(adapter.requests).toHaveLength(0)
    expect(closeSkillProvider.close).not.toHaveBeenCalled()
    closeSkillProvider.close()
    expect(closeSkillProvider.close).toHaveBeenCalledOnce()
    expect(JSON.stringify(await handle.report)).not.toContain('PRIVATE_CLOSE/REASON~SENTINEL%')
  })
})
