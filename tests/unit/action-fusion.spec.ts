import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, RuntimeAgentRunEvent, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineActionFusion, defineTool, ToolError } from '@alvin0/ai-agent-sdk-core/tools'
import type { ToolInterceptor } from '@alvin0/ai-agent-sdk-core/tools'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'
import { createMemorySpillStore } from '@alvin0/ai-agent-sdk-core/tools'

class EditModel extends ModelAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly fused: boolean, private readonly auto: boolean) { super() }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32000 } } }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const round = this.requests.length
    const name = round === 1 ? (this.fused ? this.auto ? 'edit' : 'edit_and_test' : 'apply_edit') : !this.fused && round === 2 ? 'run_test' : undefined
    yield { type: 'block-end', index: 0, block: name === undefined ? { type: 'text', text: 'done' }
      : { type: 'tool-call', id: ToolCallId(`call-${round}`), name, arguments: '{}' } }
    yield { type: 'finish', reason: { kind: name === undefined ? 'stop' : 'tool-calls' } }
  }
}
async function run(options: { fused?: boolean; auto?: boolean; deny?: string; badEdit?: boolean; limit?: number; grant?: boolean; rejectTest?: boolean; mappingFailure?: boolean; predicate?: 'throw' | 'truthy' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-fusion-'))
  const path = join(directory, 'subject.cjs')
  await writeFile(path, 'module.exports = 1\n')
  const model = new EditModel(options.fused ?? true, options.auto ?? false)
  const runtime = await createAgentRuntime({ providers: [defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'Fixture', setup(registrar) { registrar.registerAdapter(model) } })] })
  const bodies = { edit: 0, test: 0 }, events: RuntimeAgentRunEvent[] = [], checkpoints: unknown[] = []
  const interceptor: ToolInterceptor = { name: 'host-policy', before: async call => call.toolName === options.deny ? { kind: 'deny', reason: 'host denied' } : { kind: 'allow' } }
  try {
    const edit = defineTool({ name: 'apply_edit', description: 'Edit', parameters: { type: 'object' }, async execute(_args, context) {
      bodies.edit++
      if (options.badEdit) throw ToolError.respondToModel('edit conflict', 'EDIT_CONFLICT')
      await writeFile(path, 'module.exports = 2\n', { signal: context.signal })
      return { edited: true }
    } })
    const test = defineTool({ name: 'run_test', description: 'Test', parameters: { type: 'object' }, async execute(_args, context) {
      bodies.test++
      const result = await promisify(execFile)(process.execPath, ['-e', 'require("node:assert/strict").equal(require(process.argv[1]), 2); process.stdout.write("PASS actual file test")', path], { signal: context.signal })
      return { exitCode: options.rejectTest ? 1 : 0, stdout: result.stdout }
    } })
    const fusion = defineActionFusion({ name: options.auto ? 'edit' : 'edit_and_test', description: 'Edit and automatically test', parameters: { type: 'object' }, steps: [
      { tool: 'apply_edit', arguments: () => ({}) },
      { tool: 'run_test', arguments: (_args, previous) => {
        if (options.mappingFailure) throw new Error('host mapping failed')
        return { edited: previous[0] ?? null }
      }, accept: value => {
        if (options.predicate === 'throw') throw new Error('host predicate failed')
        if (options.predicate === 'truthy') return 1 as unknown as boolean
        return typeof value === 'object' && value !== null && Reflect.get(value, 'exitCode') === 0
      } },
    ] })
    const optimizer = createContextOptimizer({ store: createMemorySpillStore() })
    const agent = runtime.agent({ id: 'editor', instructions: 'Edit and test.', model: { provider: 'fixture', id: 'scripted' }, tools: [edit, test, fusion.tool, optimizer.retrievalTool], compaction: false, maxToolCalls: options.limit ?? 12 })
    const session = agent.createSession({ interceptors: [interceptor],
      hooks: optimizer.wrapHooks({ checkpoint: context => { checkpoints.push(context) } }),
      ...options.grant === false ? {} : { experimentalPrograms: [fusion.grant] },
    })
    const response = await session.run('Change the value to 2 and test.', { includeTraceEvents: true, onEvent: event => { events.push(event) } })
    return { model, bodies, events, checkpoints, response, file: await readFile(path, 'utf8') }
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }) }
}
describe('action fusion through application runtime', () => {
  it('edits an actual file and runs a real subprocess test in one observation, saving one model round', async () => {
    const atomic = await run({ fused: false }), fused = await run()
    expect(atomic.bodies).toEqual({ edit: 1, test: 1 })
    expect(fused.bodies).toEqual(atomic.bodies)
    expect(fused.file).toBe('module.exports = 2\n')
    expect(atomic.model.requests).toHaveLength(3)
    expect(fused.model.requests).toHaveLength(2)
    const results = fused.events.filter(event => event.type === 'tool-result')
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results)).toContain('PASS actual file test')
    expect(JSON.stringify(results)).toContain('completedSteps')
    expect(fused.checkpoints.filter(ctx => typeof ctx === 'object' && ctx !== null && Reflect.get(ctx, 'kind') === 'before-tool-dispatch')).toHaveLength(3)
  })
  it('auto-triggers validation when the host exposes the fused tool under its edit API', async () => {
    const result = await run({ auto: true })
    expect(result.bodies).toEqual({ edit: 1, test: 1 })
    expect(result.model.requests).toHaveLength(2)
    expect(JSON.stringify(result.events)).toContain('PASS actual file test')
  })
  it.each(['denied-edit', 'failed-edit', 'budget', 'missing-grant'] as const)('does not execute validation after %s', async kind => {
    const result = await run({ ...kind === 'denied-edit' ? { deny: 'apply_edit' } : {},
      ...kind === 'failed-edit' ? { badEdit: true } : {}, ...kind === 'budget' ? { limit: 2 } : {},
      ...kind === 'missing-grant' ? { grant: false } : {} })
    expect(result.bodies.test).toBe(0)
    expect(result.bodies.edit).toBe(kind === 'budget' || kind === 'failed-edit' ? 1 : 0)
    expect(JSON.stringify(result.events)).not.toContain('PASS actual file test')
  })
  it('retains the completed edit receipt after validation is denied or reports failure', async () => {
    for (const options of [{ deny: 'run_test' }, { rejectTest: true }]) {
      const result = await run(options)
      expect(result.file).toBe('module.exports = 2\n')
      expect(result.bodies.edit).toBe(1)
      expect(JSON.stringify(result.events)).toContain('edited')
      expect(JSON.stringify(result.events)).toContain('failedTool')
    }
  })
  it('validates host pipeline configuration', () => {
    expect(() => defineActionFusion({ name: 'edit', description: 'Edit', parameters: {}, steps: [] })).toThrow()
    expect(() => defineActionFusion({ name: 'edit', description: 'Edit', parameters: {}, steps: [{ tool: 'edit', arguments: () => ({}) }] })).toThrow()
  })
  it.each(['mapping', 'throw', 'truthy'] as const)('retains edit receipts and stops on a %s host callback failure', async kind => {
    const result = await run(kind === 'mapping' ? { mappingFailure: true } : { predicate: kind })
    expect(result.file).toBe('module.exports = 2\n')
    expect(result.bodies).toEqual({ edit: 1, test: kind === 'mapping' ? 0 : 1 })
    const observation = JSON.stringify(result.events.filter(event => event.type === 'tool-result'))
    expect(observation).toContain('edited')
    expect(observation).toContain(kind === 'mapping' ? 'FUSION_ARGUMENTS_FAILED' : 'FUSION_STEP_REJECTED')
  })
})
