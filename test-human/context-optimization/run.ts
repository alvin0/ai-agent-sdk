/** Runnable SDK consumer: local workflow plus optional real Codex fusion/reduction smoke. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { AgentRuntime, GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { defineActionFusion, defineTool, createMemorySpillStore, createModelEvidenceReducer,
  diagnosticLineNumbers, reduceEvidence } from '@alvin0/ai-agent-sdk-core/tools'
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'

const outputIndex = process.argv.indexOf('--output')
const output = resolve(outputIndex < 0 ? 'docs/evaluations/context-optimization-2026-09-27' : process.argv[outputIndex + 1]!)
const live = process.argv.includes('--live')
await mkdir(output, { recursive: true })
const log = 'Compiling ordinary module\n'.repeat(250) + 'FAIL auth.spec.ts:37\nExpected true\nReceived false\n  at auth.ts:19:2\nTests 1 failed, 3 passed\nexit code 1\n'
const big = 'inventory row\n'.repeat(1800)

class Workflow extends ModelAdapter {
  requests: GenerateOptions[] = []
  fused: boolean
  constructor(fused: boolean) { super(); this.fused = fused }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 32000 } } }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const step = this.requests.length
    const name = step === 1 ? this.fused ? 'edit_and_test' : 'apply_edit' : !this.fused && step === 2 ? 'run_test' : undefined
    yield { type: 'block-end', index: 0, block: name === undefined ? { type: 'text', text: 'done' }
      : { type: 'tool-call', id: ToolCallId(`c-${step}`), name, arguments: '{}' } }
    yield { type: 'finish', reason: { kind: name === undefined ? 'stop' : 'tool-calls' } }
  }
}
async function workflow(fused: boolean, runtime: AgentRuntime, provider: string, model: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-optimization-'))
  const path = join(directory, 'subject.cjs'), bodies = { edit: 0, test: 0 }
  const requests: { bytes: number; packed: boolean }[] = []
  const events: unknown[] = []
  try {
    await writeFile(path, 'module.exports = 1\n')
    const edit = defineTool({ name: 'apply_edit', description: 'Set fixture value to 2.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, context) { bodies.edit++; await writeFile(path, 'module.exports = 2\n', { signal: context.signal }); return { edited: true } } })
    const test = defineTool({ name: 'run_test', description: 'Assert edited fixture value is 2.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, context) { bodies.test++; const result = await promisify(execFile)(process.execPath,
        ['-e', 'require("node:assert/strict").equal(require(process.argv[1]),2);process.stdout.write("PASS actual subprocess test")', path], { signal: context.signal });
        return { exitCode: 0, stdout: result.stdout } } })
    const fusion = defineActionFusion({ name: 'edit_and_test', description: 'Edit fixture then automatically test it.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ tool: edit.name, arguments: () => ({}) }, { tool: test.name, arguments: () => ({}), accept: value => typeof value === 'object' && value !== null && Reflect.get(value, 'exitCode') === 0 }] })
    const optimizer = createContextOptimizer({ store: createMemorySpillStore(),
      archive: async (snapshot, milestone) => { await writeFile(join(output, `${provider}-${fused ? 'fused' : 'atomic'}-${milestone.id}-raw.json`), JSON.stringify(snapshot, null, 2)) } })
    const tools = fused ? [fusion.tool, edit, test, optimizer.retrievalTool] : [edit, test, optimizer.retrievalTool]
    const agent = runtime.agent({ id: `editor-${fused ? 'fused' : 'atomic'}`, model: { provider, id: model }, instructions: fused
      ? 'Call edit_and_test exactly once with {}. Then report the verified tool result; never call the individual children.'
      : 'Call apply_edit exactly once with {}. Wait for its result. In the next model round call run_test exactly once with {}. Then report the verified result.',
      tools, compaction: false, maxTurns: 6, maxToolCalls: 8 })
    const session = agent.createSession({ hooks: optimizer.wrapHooks({ checkpoint: context => {
      if (context.kind === 'before-model-request') requests.push({ bytes: Buffer.byteLength(JSON.stringify(context.request.messages)), packed: JSON.stringify(context.request.messages).includes('Observation stored') })
    } }), ...fused ? { experimentalPrograms: [fusion.grant] } : {} })
    const result = await session.run('Change fixture value to 2 and verify it using the tool.', { signal: AbortSignal.timeout(120000), onEvent: event => { if (event.type === 'tool-result') events.push(event) } })
    assert.deepEqual(bodies, { edit: 1, test: 1 })
    assert.equal(await readFile(path, 'utf8'), 'module.exports = 2\n')
    assert.match(JSON.stringify(events), /PASS actual subprocess test/)
    return { provider, model, fused, bodies, modelRequests: requests.length, requestBytes: requests.map(request => request.bytes), observations: events.length,
      completed: result.completed, usage: result.usage, stopReason: result.stopReason }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

const localRows = []
for (const fused of [false, true]) {
  const adapter = new Workflow(fused)
  const runtime = await createAgentRuntime({ providers: [defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'Fixture', setup(registrar) { registrar.registerAdapter(adapter) } })] })
  try { localRows.push(await workflow(fused, runtime, 'fixture', 'scripted')) } finally { await runtime.close() }
}
assert.deepEqual(localRows.map(row => row.modelRequests), [3, 2])

const { History } = await import('@alvin0/ai-agent-sdk-core/agent')
const { createMessage, createTextMessage } = await import('@alvin0/ai-agent-sdk-core')
const history = new History(), callId = ToolCallId('inventory')
history.append({ kind: 'user', message: createTextMessage('Preserve this user constraint.') })
history.append({ kind: 'assistant', message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'scripted' }, content: [{ type: 'tool-call', id: callId, name: 'inventory', arguments: '{}' }] }) })
history.append({ kind: 'tool-call', callId, name: 'inventory', rawArguments: '{}' })
const content = [{ type: 'text' as const, text: big }]
history.append({ kind: 'tool-result', callId, result: { isError: false, value: big, content }, message: createMessage({ role: 'user', source: { kind: 'tool', name: 'inventory', callId }, content: [{ type: 'tool-result', toolCallId: callId, content }] }) })
const store = createMemorySpillStore()
const optimizer = createContextOptimizer({ store, archive: async snapshot => { await writeFile(join(output, 'milestone-raw.json'), JSON.stringify(snapshot, null, 2)) } })
const signal = new AbortController().signal, projectedBytes = []
for (let request = 0; request < 4; request++) {
  const decision = await optimizer.hooks.beforeStep!({ turn: 0, step: request, messages: history.messages(), snapshot: history.snapshot(), signal, emit: async () => {} })
  assert.equal(decision.kind, 'proceed')
  const messages = decision.kind === 'proceed' ? decision.messages! : []
  projectedBytes.push(Buffer.byteLength(JSON.stringify(messages)))
  await optimizer.hooks.checkpoint!({ kind: 'before-model-request', request: { provider: 'fixture', model: 'm', messages }, snapshot: history.snapshot() })
}
assert.equal(projectedBytes[0], projectedBytes[1])
assert(projectedBytes[2]! < projectedBytes[1]! / 10)
assert.equal((await store.read('spill:inventory:1', { offset: 0, limit: 100000 }))?.text, big)
optimizer.completeMilestone({ id: 'inventory-read', throughSeq: 4, summary: 'Read inventory; preserve the initial constraint.', remainingTurns: 3, compactionCost: 0 })
await optimizer.hooks.beforeStep!({ turn: 0, step: 4, messages: history.messages(), snapshot: history.snapshot(), signal, emit: async () => {} })
assert.equal(optimizer.metrics().compactedMilestones, 1)
assert.equal(JSON.parse(await readFile(join(output, 'milestone-raw.json'), 'utf8')).entries.length, 4)
const deterministic = await reduceEvidence({ text: log, status: 'fail', signal }, { async reduce(input) {
  const lines = input.text.split('\n'); return { status: input.status, lines: diagnosticLineNumbers(input.text).map(line => ({ line, text: lines[line - 1]! })) }
} })
assert(deterministic.accepted)

const report: Record<string, unknown> = { schemaVersion: 1, localRows, observations: { rawBytes: Buffer.byteLength(big), projectedBytes, metrics: optimizer.metrics() },
  reducer: { rawBytes: Buffer.byteLength(log), reducedBytes: Buffer.byteLength(deterministic.text), accepted: deterministic.accepted }, live: null }
if (live) {
  const { codexNodeProviderPlugin } = await import('@alvin0/ai-agent-sdk-auth-node/codex')
  const runtime = await createAgentRuntime({ providers: [codexNodeProviderPlugin()] })
  try {
    const rows = []
    for (const fused of [false, true]) rows.push(await workflow(fused, runtime, 'codex', 'gpt-6-luna'))
    const reducerAgent = runtime.agent({ id: 'cheap-extractor', model: { provider: 'codex', id: 'gpt-6-luna' },
      instructions: 'Return only the requested JSON. Copy source lines exactly.', tools: [], compaction: false, maxTurns: 1,
      outputFormat: { type: 'json_schema', name: 'evidence', schema: { type: 'object', properties: {
        status: { type: 'string', enum: ['pass', 'fail', 'unknown'] }, lines: { type: 'array', items: { type: 'object', properties: { line: { type: 'integer' }, text: { type: 'string' } }, required: ['line', 'text'], additionalProperties: false } },
      }, required: ['status', 'lines'], additionalProperties: false } } })
    let usage: unknown
    const reducer = createModelEvidenceReducer({ async generate(request) {
      const result = await reducerAgent.createSession().run(request.system + '\n' + request.prompt, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(120000)]) })
      usage = result.usage
      return result.text
    } })
    const reduced = await reduceEvidence({ text: log, status: 'fail', signal }, reducer)
    await writeFile(join(output, 'live-reduced-log.txt'), reduced.text)
    report.live = { rows, reducer: { accepted: reduced.accepted, reason: reduced.reason, rawBytes: Buffer.byteLength(log), reducedBytes: Buffer.byteLength(reduced.text), usage } }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    assert.equal(reduced.accepted, true, `live reducer fallback: ${reduced.reason}`)
  } finally { await runtime.close() }
}
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
