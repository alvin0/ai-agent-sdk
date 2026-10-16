import { describe, expect, it } from 'vitest'
import { createManagedAgentTeam, defineAgent } from '../../packages/core/src/agent/index.ts'
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

async function capture(modelToolSurface: 'lean' | 'legacy') {
  const adapter = new Capture()
  const registry = new ModelRegistry()
  registry.registerAdapter(['test'], adapter)
  const team = createManagedAgentTeam({ registry, modelToolSurface, team: { id: 'surface-size' },
    lead: defineAgent({ id: 'lead', provider: 'test', model: 'scripted', instructions: 'Solve the task.' }),
  })
  await team.run('work')
  await team.spawn({ name: 'worker_1', task: 'work' })
  await team.awaitWorker('worker_1')
  const views = adapter.requests.slice(0, 2).map(request => ({
    instructions: request.system ?? '', tools: request.tools ?? [],
  }))
  expect(views).toHaveLength(2)
  await team.dispose()
  return views.map(view => ({ instructions: view.instructions.length,
    tools: JSON.stringify(view.tools).length,
    total: view.instructions.length + JSON.stringify(view.tools).length }))
}

describe('managed model surface size', () => {
  it('reduces both lead and worker instructions plus serialized tool definitions', async () => {
    const before = await capture('legacy')
    const after = await capture('lean')
    expect({ before, after }).toMatchInlineSnapshot(`
      {
        "after": [
          {
            "instructions": 1867,
            "tools": 2619,
            "total": 4486,
          },
          {
            "instructions": 1105,
            "tools": 371,
            "total": 1476,
          },
        ],
        "before": [
          {
            "instructions": 2202,
            "tools": 4976,
            "total": 7178,
          },
          {
            "instructions": 1384,
            "tools": 1255,
            "total": 2639,
          },
        ],
      }
    `)
    expect(after[0]!.total).toBeLessThan(before[0]!.total * 0.65)
    expect(after[1]!.total).toBeLessThan(before[1]!.total * 0.6)
  })
})
