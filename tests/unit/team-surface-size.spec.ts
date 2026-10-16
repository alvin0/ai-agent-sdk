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
    batch: JSON.stringify(view.tools.filter(tool => tool.name === 'spawn_agents')).length - 2,
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
            "batch": 1118,
            "instructions": 1962,
            "tools": 3758,
            "total": 5720,
          },
          {
            "batch": 0,
            "instructions": 1132,
            "tools": 371,
            "total": 1503,
          },
        ],
        "before": [
          {
            "batch": 1118,
            "instructions": 2257,
            "tools": 6112,
            "total": 8369,
          },
          {
            "batch": 0,
            "instructions": 1384,
            "tools": 1255,
            "total": 2639,
          },
        ],
      }
    `)
    // Both surfaces now include the same batch catalog. Preserve the lean reduction guard
    // for their original controls, and record the full added overhead in the snapshot.
    expect(after[0]!.total - after[0]!.batch).toBeLessThan((before[0]!.total - before[0]!.batch) * 0.65)
    expect(after[0]!.total).toBeLessThan(before[0]!.total * 0.7)
    expect(after[0]!.batch).toBeLessThanOrEqual(1200)
    expect(after[1]!.total).toBeLessThan(before[1]!.total * 0.6)
  })
})
