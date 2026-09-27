/** SP-01 feasibility probe: standalone executor proof and a rejected fresh-session bridge. */
import { Worker } from 'node:worker_threads'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createAgentRuntime, defineTool, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'

async function guest(code: string, bridge: (args: { page: number }) => Promise<unknown> = async () => [{ id: 'allowed-row' }], wallMs = 2000, hardCap = 3, staleReply = false) {
  const started = performance.now()
  const worker = new Worker(new URL('./ptc-worker.mjs', import.meta.url), { workerData: { code, cpuMs: 200, hardCap }, env: {}, resourceLimits: { maxOldGenerationSizeMb: 32 } })
  let dispatches = 0, outcome: { type: string; value?: unknown; error?: string } | undefined
  let deadline = false
  const result = await new Promise<{ type: string; value?: unknown; error?: string }>((done, fail) => {
    const timer = setTimeout(() => { deadline = true; done({ type: 'timeout' }); void worker.terminate() }, wallMs)
    worker.on('message', async event => {
      if (event.type === 'call') {
        dispatches++
        if (staleReply) worker.postMessage({ requestId: -1, data: [{ id: 'wrong-row' }] })
        try { worker.postMessage({ requestId: event.requestId, data: await bridge(event.args) }) }
        catch { worker.postMessage({ requestId: event.requestId, error: 'BRIDGE_FAILURE' }) }
      } else { clearTimeout(timer); outcome = event; done(event) }
    })
    worker.on('error', error => { clearTimeout(timer); fail(error) })
    worker.on('exit', code => { if (!outcome && !deadline) { clearTimeout(timer); done({ type: 'worker-exit', error: String(code) }) } })
  })
  const terminationCode = await worker.terminate()
  return { ...result, dispatches, deadline, terminationCode, elapsedMs: performance.now() - started }
}
class Scripted extends ModelAdapter {
  round = 0
  readonly name: string
  constructor(name: string) { super(); this.name = name }
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 16000 } } }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (++this.round === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: this.name, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else { yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
}
// Counterexample is deliberately not offered as a PTC implementation. Both paths use
// actual sessions; this demonstrates why giving the bridge a fresh child run is rejected.
async function rejectedBridge() {
  let bodies = 0, checkpoints = 0, policies = 0
  let nextAdapter = 0
  const adapters = Array.from({ length: 11 }, (_, i) => new Scripted(i === 0 ? 'execute_program' : 'read_rows'))
  class Router extends Scripted {
    override stream(options: GenerateOptions) { return adapters[nextAdapter]!.stream(options) }
  }
  const provider = defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'PTC counterexample', setup(registrar) { registrar.registerAdapter(new Router('router')) } })
  const runtime = await createAgentRuntime({ providers: [provider] })
  try {
    const read = defineTool({ name: 'read_rows', description: 'Read local rows', parameters: { type: 'object' }, execute() { bodies++; return { id: 'allowed-row' } } })
    const parent = runtime.agent({ id: 'parent', instructions: 'Execute program.', model: { provider: 'fixture', id: 'scripted' }, maxToolCalls: 3, maxTurns: 3, compaction: false,
      tools: [defineTool({ name: 'execute_program', description: 'Rejected bridge candidate', parameters: { type: 'object' }, async execute() {
        const execution = await guest(`for(let page=0;page<10;page++) callTool('read_rows', JSON.stringify({page})); 'done'`, async ({page}) => {
          nextAdapter = page + 1
          const child = runtime.agent({ id: `child-${page}`, instructions: 'Read one row.', model: { provider: 'fixture', id: 'scripted' }, tools: [read], maxToolCalls: 3, maxTurns: 3, compaction: false })
          await child.createSession({ hooks: { async checkpoint() { checkpoints++ } }, interceptors: [{ name: 'policy', async before() { policies++; return { kind: 'allow' } } }] }).run('Read rows.')
          return { id: 'allowed-row' }
        }, 10000, 20)
        if (execution.type !== 'result' || execution.dispatches !== 10) throw new Error('Counterexample guest did not complete')
        nextAdapter = 0
        return { status: 'done' }
      } })] })
    const result = await parent.createSession().run('Run the program.')
    return { rootLimit: 3, childBodies: bodies, childCheckpoints: checkpoints, childPolicies: policies, parentStatus: result.report.status,
      architectureGatePassed: bodies <= 3, counterexampleReproduced: bodies === 10 && checkpoints >= 10 && policies === 10 }
  } finally { await runtime.close() }
}
const root = resolve('artifacts/spikes', `ptc-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`)
await mkdir(root, { recursive: true })
const cases: { id: string; passed: boolean; evidence: unknown }[] = []
const record = (id: string, passed: boolean, evidence: unknown) => cases.push({ id, passed, evidence })
for (const name of ['process', 'require', 'fetch', 'WebSocket']) {
  const r = await guest(`typeof ${name}`)
  record(`EXEC-NO-${name}`, r.type === 'result' && r.value === 'undefined', r)
}
const ok = await guest(`JSON.parse(callTool('read_rows', JSON.stringify({page:0})))[0].id`)
record('EXEC-JSON-BRIDGE', ok.value === 'allowed-row' && ok.dispatches === 1, ok)
const correlated = await guest(`JSON.parse(callTool('read_rows', '{"page":0}'))[0].id`, undefined, 2000, 3, true)
record('EXEC-STALE-REPLY-IGNORED', correlated.type === 'result' && correlated.value === 'allowed-row' && correlated.dispatches === 1, correlated)
for (const [name, value] of [['undefined', undefined], ['nonfinite', { value: Infinity }]] as const) {
  const r = await guest(`try{callTool('read_rows', '{"page":0}')}catch{}; 'false-success'`, async () => value)
  record(`EXEC-LOSSLESS-JSON-${name}`, r.type === 'error' && r.error === 'NON_JSON_VALUE' && r.dispatches === 1, r)
}
const forbidden = await guest(`callTool('mutate', '{}')`)
record('EXEC-ALLOWLIST', forbidden.type === 'error' && forbidden.dispatches === 0, forbidden)
const badArgs = await guest(`callTool('read_rows', '{"page":"0"}')`)
record('EXEC-ARGS', badArgs.type === 'error' && badArgs.dispatches === 0, badArgs)
const cap = await guest(`for(let i=0;i<10;i++){try{callTool('read_rows', JSON.stringify({page:i}))}catch{}}; 'done'`)
record('EXEC-HARD-CAP-CATCH', cap.dispatches === 3 && cap.type === 'error' && cap.error === 'PROGRAM_CALL_CAP', cap)
const fatal = await guest(`for(let i=0;i<3;i++){try{callTool('read_rows', JSON.stringify({page:i}))}catch{}}; 'false-success'`, async () => { throw new Error('unknown host outcome') })
record('EXEC-FATAL-LATCH-CATCH', fatal.dispatches === 1 && fatal.type === 'error' && fatal.error === 'BRIDGE_FAILURE', fatal)
const cpu = await guest('while(true){}')
record('EXEC-CPU', cpu.type === 'error' && cpu.elapsedMs < 2000, cpu)
const memory = await guest(`let x=[]; while(true) x.push('x'.repeat(1048576));`)
record('EXEC-MEMORY-TERMINATION', ['error', 'timeout', 'worker-exit'].includes(memory.type) && memory.elapsedMs < 2500, memory)
const projection = await guest(`'x'.repeat(10000)`)
record('EXEC-PROJECTION', projection.type === 'error', projection)
const resultCap = await guest(`callTool('read_rows', '{"page":0}')`, async () => ({ value: 'x'.repeat(70000) }))
record('EXEC-RESULT-CAP', resultCap.type === 'error' && resultCap.dispatches === 1, resultCap)
const stalled = await guest(`callTool('read_rows', '{"page":0}')`, async () => await new Promise(() => {}), 400)
record('EXEC-PENDING-TERMINATED', stalled.type === 'timeout' && stalled.dispatches === 1, stalled)
const rejected = await rejectedBridge()
record('ROOT-COUNTEREXAMPLE', rejected.counterexampleReproduced && !rejected.architectureGatePassed, rejected)
const sources = ['ptc-probe.ts', 'ptc-worker.mjs']
const hashes: Record<string, string> = {}
for (const file of sources) { const data = await readFile(resolve('test-human/spikes', file)); hashes[file] = createHash('sha256').update(data).digest('hex'); await writeFile(resolve(root, file), data, { flag: 'wx' }) }
const summary = { spike: 'SP-01', status: 'completed', decision: 'no-go', candidate: 'Fresh child-session bridge',
  executor: { package: 'quickjs-emscripten', version: '0.32.0', license: 'MIT', isolationScope: 'QuickJS WASM in Node worker; no ambient host APIs, not kernel confinement', heapLimitBytes: 8388608 },
  cases, harnessPassed: cases.every(c => c.passed), architectureGatePassed: false, liveBenchmarkAllowed: false,
  sourceHashes: hashes, limitations: ['Standalone executor cases are not integrated PTC-A01…15 conformance', 'Fresh child runs bypass root admission/accounting despite their own policy/checkpoints', 'No MCP output-contract capture/refresh implementation', 'No cost or live utility conclusion', 'Heap cap is configured, but this probe proves bounded worker termination rather than a total RSS bound'],
  nextAction: 'Design and test a scheduler-owned nested admission port before another PTC candidate; no direct tool.execute bridge or production export.' }
await writeFile(resolve(root, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' })
console.log(JSON.stringify({ root, harnessPassed: summary.harnessPassed, cases: cases.length, decision: summary.decision }))
if (!summary.harnessPassed) process.exitCode = 1
