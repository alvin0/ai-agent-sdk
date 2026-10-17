import { createManagedAgentTeam, defineAgent } from '../../packages/core/src/agent/index.ts'
import type { ManagedAgentTeamOptions } from '../../packages/core/src/agent/index.ts'
import { ModelAdapter, ModelRegistry, ReasoningEffortId } from '../../packages/core/src/index.ts'
import type { GenerateOptions, ResolvedModelInfo, StreamChunk } from '../../packages/core/src/index.ts'

class Capture extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<ResolvedModelInfo> {
    const effort = ReasoningEffortId('medium')
    return Promise.resolve({ provider, id: model, name: model,
      reasoning: { efforts: [{ id: effort, name: effort }] } })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Matched non-team control for incremental prompt/schema overhead. */
export async function captureSingleSurface() {
  const adapter = new Capture()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const agent = defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve the task.' })
  await agent.createSession({ registry }).run('work')
  return adapter.requests.map(request => ({ system: request.system ?? '', tools: request.tools ?? [] }))
}

/** Exact per-request text/catalog capture; no provider calls or tokenizer claims. */
export async function captureSurface(options: Partial<ManagedAgentTeamOptions> = {}) {
  const adapter = new Capture()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const team = createManagedAgentTeam({ registry, team: { id: 'surface-size' },
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve the task.' }),
    ...options,
  })
  try {
    await team.run('work')
    await team.spawn({ name: 'worker_1', task: 'work' })
    await team.awaitWorker('worker_1')
    await team.run('continue')
    return adapter.requests.slice(0, 3).map(request => ({ system: request.system ?? '', tools: request.tools ?? [] }))
  } finally { await team.dispose(); await team.team.dispose() }
}
