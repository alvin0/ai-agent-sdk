import { vi } from 'vitest'
import { createManagedAgentTeam, defineAgent, defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { ManagedAgentTeamOptions, ManagedAgentSpawnRequest } from '@alvin0/ai-agent-sdk-core/agent'
import { ModelAdapter, ModelRegistry, ReasoningEffortId, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '@alvin0/ai-agent-sdk-core'

class Capture extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  attemptTool: string | undefined

  override resolveModel(provider: string, id: string): Promise<ResolvedModelInfo> {
    const medium = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id, name: id,
      reasoning: { efforts: [{ id: medium, name: 'medium' }], defaultEffort: medium } })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.attemptTool !== undefined && this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('attempt'),
        name: this.attemptTool, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'verified report' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'verified report' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const read = defineTool({ name: 'read_file', description: 'Read a file.',
  parameters: { type: 'object' }, execute: () => 'contents' })
export const writeExecute = vi.fn(() => 'written')
export const write = defineTool({ name: 'write_file', description: 'Write a file.',
  parameters: { type: 'object' }, execute: writeExecute })

export function setup(overrides: Partial<Omit<ManagedAgentTeamOptions, 'registry'>> = {}) {
  const adapter = new Capture()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const lead = defineAgent({ id: 'lead', provider: 'test', model: 'scripted',
    instructions: 'Solve the caller task.', tools: [read], compaction: false })
  const managed = createManagedAgentTeam({ modelToolSurface: 'legacy', registry, lead, ...overrides })
  return { adapter, managed }
}

export async function workerRequest(
  overrides: Partial<Omit<ManagedAgentTeamOptions, 'registry'>> = {},
  request: ManagedAgentSpawnRequest = { task: 'Inspect the fixture; return evidence.' },
) {
  const { adapter, managed } = setup(overrides)
  try {
    const worker = await managed.spawn(request)
    await managed.awaitWorker(worker.name)
    return { request: adapter.requests[0]!, worker }
  } finally { await managed.dispose() }
}

export const names = (request: GenerateOptions) => (request.tools ?? []).map(tool => tool.name)
