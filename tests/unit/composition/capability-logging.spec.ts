import { describe, expect, it, vi } from 'vitest'
import { ModelAdapter } from '../../../packages/core/src/contract/adapter.ts'
import type { GenerateOptions } from '../../../packages/core/src/contract/generate-options.ts'
import type { StreamChunk } from '../../../packages/core/src/stream/chunk.ts'
import { AgentMemory } from '../../../packages/core/src/agent/memory/memory.ts'
import { defineCredentialSource, defineCredentialStore } from '../../../packages/core/src/composition/credential/definition.ts'
import { defineMemoryStore, captureMemoryBinding } from '../../../packages/core/src/composition/memory/definition.ts'
import { createRuntimeMemoryPersistence } from '../../../packages/core/src/composition/memory/run.ts'
import { defineSkillProviderPlugin } from '../../../packages/core/src/composition/skill-provider/definition.ts'
import { defineToolSource } from '../../../packages/core/src/composition/tool-source/definition.ts'
import { snapshotToolSources } from '../../../packages/core/src/composition/tool-source/snapshot.ts'
import { createRuntimeCompositionOwner } from '../../../packages/core/src/composition/runtime/owner.ts'
import type { ModelProviderRegistrar } from '../../../packages/core/src/plugin/provider-plugin.ts'
import { CORE_CAPABILITY_OPERATIONS } from '../../../packages/core/src/composition/logging/capability.ts'
import {
  beginCoreCapabilityOperation, runCoreCapabilityMaybeAsync,
} from '../../../packages/core/src/composition/logging/capability.ts'
import { createRuntimeLogger } from '../../../packages/core/src/composition/logging/logger.ts'
import type { RuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import type { IntegrationOperationEvidenceFields } from '../../../packages/core/src/observability/types.ts'
import { RecordingLogger, integrationOperations } from '../fixtures/integration-logger.ts'

class EmptyAdapter extends ModelAdapter {
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('core-owned capability operation logging', () => {
  it('uses the runtime-bound platform and rejects invalid family/operation pairs before enqueue', () => {
    let clock = 0
    const randomHex = vi.fn((bytes: number) => 'a'.repeat(bytes * 2))
    const platform: RuntimePlatform = {
      monotonicNow: () => clock++, wallNow: () => 0, randomHex,
      controller: () => new AbortController(), after: () => () => undefined,
    }
    const capture = vi.fn(() => ({ status: 'accepted' as const }))
    const logger = createRuntimeLogger({
      resource: {} as never, platform, content: 'none', minimumLevel: 'info', redactors: [],
      includeErrorStacks: false, isClosed: () => false, capture, integration: () => undefined,
    })
    const baseline = randomHex.mock.calls.length
    beginCoreCapabilityOperation(logger, 'core-provider', 'setup').success()
    expect(randomHex.mock.calls.slice(baseline)).toEqual(Array.from({ length: 6 }, () => [16]))
    expect(capture).toHaveBeenCalledTimes(4)

    const recording = new RecordingLogger()
    expect(() => beginCoreCapabilityOperation(recording, 'core-provider', 'read' as never))
      .toThrow('Invalid core capability operation')
    expect(recording.entries).toHaveLength(0)
  })

  it('captures a foreign thenable once and balances its terminal evidence', async () => {
    const logger = new RecordingLogger()
    let reads = 0, calls = 0
    const foreign = Object.defineProperty({}, 'then', { get() {
      reads++
      return (resolve: (value: string) => void) => { calls++; resolve('resolved') }
    } })
    const result = runCoreCapabilityMaybeAsync(logger, 'core-credential', 'resolve', undefined,
      () => foreign as never) as Promise<string>
    await expect(result).resolves.toBe('resolved')
    expect({ reads, calls }).toEqual({ reads: 1, calls: 1 })
    expect(logger.entries.map(entry => entry.fields.kind)).toEqual([
      'logical-start', 'attempt-start', 'attempt-terminal', 'logical-terminal',
    ])
  })

  it('freezes the expected safe capability families and records provider setup without plugin logs', async () => {
    expect(CORE_CAPABILITY_OPERATIONS).toEqual({
      'core-provider': ['setup'],
      'core-credential': ['resolve', 'read', 'commit'],
      'core-tool-source': ['snapshot'],
      'core-skill-provider': ['list', 'load', 'read-resource'],
      'core-memory-store': ['load', 'commit'],
    })
    const runtime = await createRuntimeCompositionOwner({ providers: [{
      kind: 'model-provider-plugin', apiVersion: 1, id: 'silent-provider', family: 'silent',
      displayName: 'Silent', routes: ['silent'], defaultModel: { provider: 'silent', id: 'model' },
      setup(registrar: ModelProviderRegistrar) { registrar.registerAdapter(['silent'], new EmptyAdapter()) },
    }] })
    const rows = runtime.diagnostics().events
      .map(event => event.data.fields as IntegrationOperationEvidenceFields | undefined)
      .filter((fields): fields is IntegrationOperationEvidenceFields =>
        fields?.integrationFamily === 'core-provider')
    expect(rows.map(fields => fields.kind)).toEqual([
      'logical-start', 'attempt-start', 'attempt-terminal', 'logical-terminal',
    ])
    await runtime.close()
  })

  it('wraps credential, tool-source and skill-provider calls even when implementations emit nothing', async () => {
    const logger = new RecordingLogger(), signal = new AbortController().signal
    const source = defineCredentialSource({ id: 'credential', resolve: () => 'secret-value' })
    expect(source.resolve({ signal, logger })).toBe('secret-value')
    const store = defineCredentialStore<string>({
      id: 'credential-store', label: 'Credential Store',
      read: async () => ({ value: 'stored', revision: 'r1' }),
      commit: async () => ({ revision: 'r2' }),
    })
    await store.read({ signal, logger })
    await store.commit({ value: 'next', expectedRevision: 'r1' }, { signal, logger })

    const toolSource = defineToolSource({ id: 'tools', snapshot: () => ({ revision: 'r1', tools: [] }) })
    expect(snapshotToolSources([toolSource], signal, logger)).toMatchObject({ references: [{ revision: 'r1' }] })

    const skills = defineSkillProviderPlugin({
      id: 'skills', list: async () => ({ revision: 'r1', candidates: [] }),
      load: async () => undefined, readResource: async () => undefined,
    })
    const options = { signal, logger }
    await skills.list(options)
    const reference = { id: 'skill', source: 'fixture', provider: 'skills', catalogRevision: 'r1' }
    await skills.load(reference, options)
    await skills.readResource?.(reference, 'notes.md', options)

    expect(integrationOperations(logger)).toEqual([
      'resolve', 'read', 'commit', 'snapshot', 'list', 'load', 'read-resource',
    ])
    expect(logger.entries.filter(entry => entry.fields.kind === 'logical-terminal')
      .every(entry => entry.fields.status === 'success')).toBe(true)
  })

  it('records memory operations and support-safe failures without changing primary errors', async () => {
    const logger = new RecordingLogger(), signal = new AbortController().signal
    const load = vi.fn(async () => undefined)
    const commit = vi.fn(async () => ({ revision: 'r2' }))
    const binding = captureMemoryBinding({
      store: defineMemoryStore({ id: 'memory', load, commit }), bindingId: 'binding',
      scope: { kind: 'conversation', namespace: 'tenant' }, requirement: 'required',
    })
    const persistence = createRuntimeMemoryPersistence(binding, 'agent')
    await persistence.load('conversation', signal, logger)
    await persistence.commit('conversation', new AgentMemory().snapshot(), null, signal, logger)
    expect(integrationOperations(logger)).toEqual(['load', 'commit'])

    const privateFailure = 'PRIVATE_CAPABILITY/BODY~SENTINEL%'
    const failed = defineCredentialSource({ id: 'failed', resolve: () => { throw new Error(privateFailure) } })
    expect(() => failed.resolve({ signal, logger })).toThrow(privateFailure)
    const terminal = logger.entries.at(-1)!
    expect(terminal).toMatchObject({ level: 'error', fields: {
      integrationFamily: 'core-credential', integrationOperation: 'resolve', status: 'error',
      errorCode: 'CAPABILITY_OPERATION_FAILED',
    } })
    expect(JSON.stringify(terminal)).not.toContain(privateFailure)
  })
})
