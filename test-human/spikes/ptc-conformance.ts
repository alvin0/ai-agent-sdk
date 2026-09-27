/** SP-01 architecture-gate conformance: real AgentRuntime sessions, the scheduler-granted
 * nested port, and the QuickJS worker executor. Deterministic scripted model; no provider calls. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, RuntimeAgentRunEvent, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { createApprovalBroker, defineTool } from '@alvin0/ai-agent-sdk-core/agent'
import type { ToolDefinition, ToolInterceptor } from '@alvin0/ai-agent-sdk-core/agent'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { createProgramTool, DEFAULT_PROGRAM_LIMITS, RESEARCH_QUICKJS_ENTRY, type ProgramExecutorLimits } from '../../samples/programmatic-tools/program-tool.ts'

const SENTINEL = 'PTC/CONFORMANCE/SENTINEL'
const EXECUTOR = process.argv.includes('--executor') ? process.argv[process.argv.indexOf('--executor') + 1] as 'sync' | 'async' : 'sync'
if (EXECUTOR !== 'sync' && EXECUTOR !== 'async') throw new Error('--executor must be sync or async')

/** The same case programs, written for the async executor: every host call is awaited. */
function forExecutor(code: string): string {
  // Code already written for the async executor opts out with this marker.
  if (EXECUTOR === 'sync' || code.startsWith('/*native*/')) return code
  let out = ''
  for (let index = 0; index < code.length;) {
    const match = /^(callToolResult|callTool|loadResult)\(/.exec(code.slice(index))
    const previous = code[index - 1]
    if (match === null || (previous !== undefined && /[\w.]/.test(previous))) { out += code[index]; index++; continue }
    let depth = 0, end = index + match[1]!.length
    for (; end < code.length; end++) { if (code[end] === '(') depth++; if (code[end] === ')' && --depth === 0) break }
    const name = match[1]!
    out += `(await ${name}(${forExecutor(code.slice(index + name.length + 1, end))}))`
    index = end + 1
  }
  return out
}
const ROW_SCHEMA = { type: 'object', properties: { id: { type: 'string' }, total: { type: 'integer' } }, required: ['id', 'total'] }

interface Case {
  readonly id: string
  readonly title: string
  readonly run: () => Promise<{ passed: boolean; observed: Record<string, unknown> }>
}

type Script = string | ((request: GenerateOptions) => string)

interface Harness {
  code: Script | Script[]
  maxToolCalls?: number
  maxCalls?: number
  exempt?: boolean
  grant?: boolean
  interceptors?: ToolInterceptor[]
  approvals?: ReturnType<typeof createApprovalBroker>
  limits?: Partial<ProgramExecutorLimits>
  quickjsEntry?: string
  sibling?: boolean
  schema?: 'match' | 'mismatch'
  readDelayMs?: number
  onStarted?: (abort: () => void) => void
}

async function harness(options: Harness) {
  const codes = Array.isArray(options.code) ? options.code : [options.code]
  const requests: GenerateOptions[] = []
  let round = 0
  class Scripted extends ModelAdapter {
    override async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, context: { contextWindow: 64_000 } }
    }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(request)
      const script = codes[round]
      const raw = typeof script === 'function' ? script(request) : script
      const code = raw === undefined ? undefined : forExecutor(raw)
      round++
      if (code !== undefined) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`program-${String(round)}`), name: 'execute_program', arguments: JSON.stringify({ code }) } }
        if (options.sibling === true && round === 1) {
          yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('sibling'), name: 'read_rows', arguments: '{"page":99}' } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const plugin = defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'PTC conformance', setup(registrar) { registrar.registerAdapter(new Scripted()) } })
  const runtime = await createAgentRuntime({ providers: [plugin] })
  const counts = { read: 0, write: 0, workersStarted: 0, workersExited: 0 }
  const events: RuntimeAgentRunEvent[] = []
  const programResults: unknown[] = []
  let failure: string | undefined
  let text = ''
  const controller = new AbortController()
  try {
    const read: ToolDefinition = defineTool({
      name: 'read_rows', description: 'Read one page of rows.', parameters: { type: 'object' },
      ...options.exempt === true ? { budgetExempt: true as const } : {},
      ...options.schema === undefined ? {} : { experimentalOutputSchema: ROW_SCHEMA },
      isConcurrencySafe: () => true,
      async execute(args: unknown) {
        counts.read++
        if (options.readDelayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.readDelayMs))
        const page = typeof args === 'object' && args !== null ? Number(Reflect.get(args, 'page')) : 0
        return options.schema === 'mismatch' ? { id: `row-${String(page)}`, total: 'many' } : { id: `row-${String(page)}`, total: page, private: SENTINEL }
      },
      meta: () => ({ note: SENTINEL }),
    })
    const write = defineTool({ name: 'write_row', description: 'Mutation; never granted.', parameters: { type: 'object' }, execute() { counts.write++; return { written: true } } })
    const program = createProgramTool({
      ...options.limits === undefined ? {} : { limits: options.limits },
      quickjsEntry: options.quickjsEntry ?? RESEARCH_QUICKJS_ENTRY,
      executor: EXECUTOR,
      observer: { workerStarted: () => { counts.workersStarted++; options.onStarted?.(() => controller.abort()) }, workerExited: () => { counts.workersExited++ } },
    })
    const agent = runtime.agent({ id: 'ptc', instructions: 'Use programs.', model: { provider: 'fixture', id: 'scripted' },
      tools: [program, read, write], maxToolCalls: options.maxToolCalls ?? 24, maxTurns: 8, compaction: false })
    const session = agent.createSession({
      ...options.interceptors === undefined ? {} : { interceptors: options.interceptors },
      ...options.approvals === undefined ? {} : { approvals: options.approvals },
      ...options.grant === false ? {} : { experimentalPrograms: [{ tool: 'execute_program', allow: ['read_rows'], maxCalls: options.maxCalls ?? 20 }] },
    })
    const started = Date.now()
    try {
      const result = await session.run('Run the program.', { includeTraceEvents: true, signal: controller.signal, onEvent(event) {
        events.push(event)
        if (event.type === 'tool-result' && String(event.callId).startsWith('program-')) programResults.push(event.output)
      } })
      text = result.text
    } catch (error) {
      const report = typeof error === 'object' && error !== null ? Reflect.get(error, 'report') as { errors?: { code?: string; message?: string }[] } | undefined : undefined
      const codes = report?.errors?.map(entry => `${String(entry.code)}(${String(entry.message).slice(0, 80)})`) ?? []
      failure = `${error instanceof Error ? error.message : String(error)} :: ${codes.join(' | ')}`.slice(0, 400)
    }
    return { counts, events, programResults, failure, text, requests, elapsedMs: Date.now() - started }
  } finally {
    await runtime.close()
  }
}

const outputOf = (run: Awaited<ReturnType<typeof harness>>, index = 0) => run.programResults[index] as { isError?: boolean; value?: { result?: unknown }; error?: { code?: string } } | undefined
const leaks = (run: Awaited<ReturnType<typeof harness>>) =>
  JSON.stringify(run.events).includes(SENTINEL) || JSON.stringify(run.requests.map(request => request.messages)).includes(SENTINEL)
const workersClosed = (run: Awaited<ReturnType<typeof harness>>) => run.counts.workersStarted === run.counts.workersExited

const LOOP10 = `const out = []; for (let page = 0; page < 10; page++) { try { out.push(callTool('read_rows', { page }).id) } catch (e) { out.push(String(e.message).split(':')[0]) } } return out`

const cases: Case[] = [
  { id: 'PTC-A17', title: 'final projection rejects non-JSON fields before the VM dump can coerce them', run: async () => {
    const run = await harness({ code: `return { missing: undefined, invalid: NaN };` })
    return { passed: outputOf(run)?.isError === true && workersClosed(run),
      observed: { output: outputOf(run) } }
  } },
  { id: 'PTC-A16', title: 'guest arguments reject lossy values without invoking accessors or toJSON', run: async () => {
    const run = await harness({ code: `let invoked = 0; let refused = 0;
      const values = [{ page: undefined }, { page: NaN }, new Date(0), [, 1],
        { get page() { invoked++; return 1 } }, { toJSON() { invoked++; return { page: 1 } } }];
      for (const value of values) { try { callTool('read_rows', value) } catch (e) { refused++ } }
      return { invoked, refused };` })
    const value = outputOf(run)?.value?.result
    return { passed: JSON.stringify(value) === '{"invoked":0,"refused":6}' && run.counts.read === 0 && workersClosed(run),
      observed: { value, reads: run.counts.read } }
  } },
  { id: 'PTC-A01', title: 'ungranted tool refused inside the guest', run: async () => {
    const run = await harness({ code: `try { callTool('write_row', {}); return 'ran' } catch (e) { return String(e.message).split(':')[0] }` })
    const out = outputOf(run)
    return { passed: run.counts.write === 0 && out?.value?.result === 'PROGRAM_TOOL_NOT_ALLOWED' && workersClosed(run), observed: { result: out?.value?.result, writes: run.counts.write } }
  } },
  { id: 'PTC-A02', title: 'root limit 3: outer + exactly two child bodies', run: async () => {
    const run = await harness({ code: LOOP10, maxToolCalls: 3 })
    const result = outputOf(run)?.value?.result as string[] | undefined
    return { passed: run.counts.read === 2 && result?.slice(2).every(code => code === 'PROGRAM_BUDGET_EXHAUSTED') === true, observed: { reads: run.counts.read, result } }
  } },
  { id: 'PTC-A03', title: 'budget-exempt loop stopped by the program cap', run: async () => {
    const run = await harness({ code: LOOP10, maxToolCalls: 3, exempt: true, maxCalls: 3 })
    const result = outputOf(run)?.value?.result as string[] | undefined
    return { passed: run.counts.read === 3 && result?.slice(3).every(code => code === 'PROGRAM_CALL_CAP') === true, observed: { reads: run.counts.read, result } }
  } },
  { id: 'PTC-A04', title: 'post-policy value/meta/context removal never leaks', run: async () => {
    const redact: ToolInterceptor = { name: 'redact', async after(call) { return call.toolName === 'read_rows' ? { kind: 'replace', content: [{ type: 'text', text: 'redacted' }] } : { kind: 'accept' } } }
    const redacted = await harness({ code: `try { callTool('read_rows', { page: 1 }); return 'ok' } catch (e) { return String(e.message).split(':')[0] }`, interceptors: [redact] })
    const accepted = await harness({ code: `return callTool('read_rows', { page: 1 }).id` })
    return { passed: outputOf(redacted)?.value?.result === 'STRUCTURED_OUTPUT_UNAVAILABLE' && outputOf(accepted)?.value?.result === 'row-1' && !leaks(redacted) && !leaks(accepted),
      observed: { redacted: outputOf(redacted)?.value?.result, accepted: outputOf(accepted)?.value?.result, leak: leaks(redacted) || leaks(accepted) } }
  } },
  { id: 'PTC-A05', title: 'exclusive program beside a parallel sibling', run: async () => {
    const run = await harness({ code: `return callTool('read_rows', { page: 1 }).id`, sibling: true })
    return { passed: run.failure === undefined && run.counts.read === 2 && outputOf(run)?.value?.result === 'row-1', observed: { reads: run.counts.read, failure: run.failure } }
  } },
  { id: 'PTC-A06', title: 'child admission failure fails the turn and terminates the worker', run: async () => {
    let admissions = 0
    const failing: ToolInterceptor = { name: 'claim', async before(call) { if (call.toolName === 'read_rows') { admissions++; throw new Error('claim store unavailable') } return { kind: 'allow' } } }
    const run = await harness({ code: `try { callTool('read_rows', { page: 0 }) } catch (e) {} ; try { callTool('read_rows', { page: 1 }); return 'reopened' } catch (e) { return 'closed' }`, interceptors: [failing] })
    // Reports are support-safe: the message is redacted, the code and counts are the evidence.
    return { passed: run.failure?.includes('TOOL_FAILED') === true && admissions === 1 && run.counts.read === 0 && workersClosed(run),
      observed: { failure: run.failure, admissions, reads: run.counts.read, workers: run.counts } }
  } },
  { id: 'PTC-A07', title: 'cancel while a child waits for approval', run: async () => {
    const approvals = createApprovalBroker()
    const ask: ToolInterceptor = { name: 'ask', async before(call) { return call.toolName === 'read_rows' ? { kind: 'ask' } : { kind: 'allow' } } }
    let abort: (() => void) | undefined
    const pending = harness({ code: `return callTool('read_rows', { page: 0 }).id`, interceptors: [ask], approvals, onStarted: fn => { abort = fn } })
    for (let wait = 0; wait < 200 && approvals.pending().length === 0; wait++) await new Promise(r => setTimeout(r, 10))
    const waiting = approvals.pending()
    abort?.()
    const run = await pending
    const lateAllowed = waiting[0] === undefined ? false : approvals.resolve(waiting[0].approvalRequestId, 'allow')
    await new Promise(r => setTimeout(r, 50))
    return { passed: waiting.length === 1 && approvals.pending().length === 0 && run.counts.read === 0 && workersClosed(run),
      observed: { waited: waiting.length, lateAllowed, reads: run.counts.read, failure: run.failure, workers: run.counts } }
  } },
  { id: 'PTC-A08', title: 'missing executor and failed startup fail closed', run: async () => {
    const missing = await harness({ code: `callTool('read_rows', {})`, quickjsEntry: '/nonexistent/quickjs/index.mjs' })
    const broken = await harness({ code: `callTool('read_rows', {})`, limits: { cpuMs: 0 } })
    const codeOf = (run: Awaited<ReturnType<typeof harness>>) => outputOf(run)?.error?.code
    return { passed: codeOf(missing) === 'EXECUTOR_UNAVAILABLE' && ['EXECUTOR_FAILED', 'EXECUTOR_EXITED'].includes(String(codeOf(broken))) && missing.counts.read + broken.counts.read === 0 && workersClosed(broken),
      observed: { missing: codeOf(missing), broken: codeOf(broken), reads: missing.counts.read + broken.counts.read } }
  } },
  { id: 'PTC-A09', title: 'CPU loop, pending promise, output spam, memory stress; host loop stays live', run: async () => {
    let ticks = 0
    const ticker = setInterval(() => { ticks++ }, 10)
    const cpu = await harness({ code: `while (true) {}`, limits: { cpuMs: 300 } })
    clearInterval(ticker)
    const pendingPromise = await harness({ code: `return new Promise(() => {})` })
    const asyncCode = await harness({ code: `/*native*/const r = await callTool('read_rows', { page: 1 }); return r.id` })
    const spam = await harness({ code: `return 'x'.repeat(100000)` })
    const memory = await harness({ code: `const a = []; while (true) a.push('y'.repeat(100000))`, limits: { cpuMs: 5000 } })
    // Host tool time is not guest CPU: a slow child must not exhaust the CPU budget.
    const slowChild = await harness({ code: `const r = callTool('read_rows', { page: 1 }); let x = 0; for (let i = 0; i < 300000; i++) x += i % 7; return x >= 0 ? r.id : 'never'`, limits: { cpuMs: 300 }, readDelayMs: 400 })
    const code = (run: Awaited<ReturnType<typeof harness>>) => outputOf(run)?.error?.code
    const all = [cpu, pendingPromise, spam, memory, slowChild]
    return { passed: code(cpu) === 'PROGRAM_FAILED' && cpu.elapsedMs < 3_000 && ticks >= 10 && code(pendingPromise) === 'PROGRAM_PENDING'
      && (EXECUTOR === 'sync' ? code(asyncCode) === 'PROGRAM_ASYNC_UNSUPPORTED' : outputOf(asyncCode)?.value?.result === 'row-1') && outputOf(slowChild)?.value?.result === 'row-1' && code(spam) === 'PROGRAM_PROJECTION_TOO_LARGE' && code(memory) !== undefined && all.every(workersClosed),
      observed: { cpu: code(cpu), cpuElapsedMs: cpu.elapsedMs, hostTicksDuringCpuLoop: ticks, pending: code(pendingPromise), async: code(asyncCode), slowChild: outputOf(slowChild)?.value?.result ?? code(slowChild), spam: code(spam), memory: code(memory) } }
  } },
  { id: 'PTC-A10', title: 'declared schema validated; mismatch refused, not guessed', run: async () => {
    const match = await harness({ code: `const r = callToolResult('read_rows', { page: 2 }); return [r.schema, r.value.total]`, schema: 'match' })
    const mismatch = await harness({ code: `try { callTool('read_rows', { page: 2 }); return 'ok' } catch (e) { return String(e.message).split(':')[0] }`, schema: 'mismatch' })
    const untyped = await harness({ code: `return callToolResult('read_rows', { page: 2 }).schema` })
    return { passed: JSON.stringify(outputOf(match)?.value?.result) === '["validated",2]' && outputOf(mismatch)?.value?.result === 'PROGRAM_OUTPUT_SCHEMA_MISMATCH' && outputOf(untyped)?.value?.result === 'unchecked',
      observed: { match: outputOf(match)?.value?.result, mismatch: outputOf(mismatch)?.value?.result, untyped: outputOf(untyped)?.value?.result } }
  } },
  { id: 'PTC-A11', title: 'guest catches a fatal child and cannot continue', run: async () => {
    const fatal: ToolInterceptor = { name: 'unknown-outcome', async around(call, next) { if (call.toolName === 'read_rows') { const { ToolError } = await import('@alvin0/ai-agent-sdk-core/agent'); throw ToolError.fatal('outcome unknown', 'OUTCOME_UNKNOWN') } return await next() } }
    const run = await harness({ code: `try { callTool('read_rows', { page: 0 }) } catch (e) {} ; try { callTool('read_rows', { page: 1 }); return 'reopened' } catch (e) { return 'refused' }`, interceptors: [fatal] })
    return { passed: run.failure?.includes('OUTCOME_UNKNOWN') === true && run.counts.read === 0 && workersClosed(run), observed: { failure: run.failure, reads: run.counts.read } }
  } },
  { id: 'PTC-A12', title: 'retained result reused by a later program in the same turn', run: async () => {
    const run = await harness({ code: [
      `return callToolResult('read_rows', { page: 5 }, { retain: true }).handle`,
      // The model reads the handle from the first program's result, as a real model would.
      request => {
        const handle = /ph_[0-9a-f]+/.exec(JSON.stringify(request.messages))?.[0] ?? 'missing'
        return `const loaded = loadResult('${handle}'); return [loaded.id, TOOLS.map(t => t.name).join(',')]`
      },
    ] })
    const handle = outputOf(run, 0)?.value?.result
    const second = outputOf(run, 1)?.value?.result
    return { passed: String(handle).startsWith('ph_') && JSON.stringify(second) === '["row-5","read_rows"]' && run.counts.read === 1,
      observed: { handle: typeof handle, second, reads: run.counts.read } }
  } },
  ...EXECUTOR === 'async' ? [{ id: 'PTC-Q2-A', title: 'async executor: Promise.all and async IIFE, children serialized', run: async () => {
    const all = await harness({ code: `/*native*/const rows = await Promise.all([0, 1, 2].map(page => callTool('read_rows', { page }))); return rows.map(row => row.id)` })
    const iife = await harness({ code: `/*native*/return await (async () => { const r = await callTool('read_rows', { page: 4 }); return r.id })()` })
    const caught = await harness({ code: `/*native*/try { await callTool('write_row', {}); return 'ran' } catch (e) { return String(e.message).split(':')[0] }` })
    return { passed: JSON.stringify(outputOf(all)?.value?.result) === '["row-0","row-1","row-2"]' && all.counts.read === 3
      && outputOf(iife)?.value?.result === 'row-4' && outputOf(caught)?.value?.result === 'PROGRAM_TOOL_NOT_ALLOWED' && [all, iife, caught].every(workersClosed),
      observed: { all: outputOf(all)?.value?.result, iife: outputOf(iife)?.value?.result, caught: outputOf(caught)?.value?.result } }
  } } as Case] : [],
  { id: 'PTC-A14', title: 'program tool without a grant does nothing', run: async () => {
    const run = await harness({ code: `callTool('read_rows', {})`, grant: false })
    return { passed: outputOf(run)?.error?.code === 'PROGRAM_NOT_GRANTED' && run.counts.workersStarted === 0 && run.counts.read === 0, observed: { code: outputOf(run)?.error?.code } }
  } },
]

const results = []
for (const entry of cases) {
  try {
    const outcome = await entry.run()
    results.push({ id: entry.id, title: entry.title, status: outcome.passed ? 'passed' : 'failed', observed: outcome.observed })
  } catch (error) {
    results.push({ id: entry.id, title: entry.title, status: 'failed', observed: { harnessError: error instanceof Error ? error.message : String(error) } })
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
// Run from the workspace root, like every other spike harness.
const directory = resolve('artifacts/spikes', `ptc-conformance-${stamp}`)
await mkdir(resolve('artifacts/spikes'), { recursive: true })
await mkdir(directory)
const sources = ['test-human/spikes/ptc-conformance.ts', 'samples/programmatic-tools/program-tool.ts', 'samples/programmatic-tools/guest-json.mjs', 'samples/programmatic-tools/program-worker.mjs', 'samples/programmatic-tools/program-worker-async.mjs']
const hashes = Object.fromEntries(await Promise.all(sources.map(async name => [name, createHash('sha256').update(await readFile(resolve(name))).digest('hex')])))
const summary = {
  spike: 'SP-01', harness: 'ptc-conformance', executor: `quickjs-emscripten@0.32.0 in node:worker_threads (${EXECUTOR})`,
  node: process.version, limits: DEFAULT_PROGRAM_LIMITS, sourceHashes: hashes,
  passed: results.every(result => result.status === 'passed'), cases: results,
  notCoveredHere: { 'PTC-A13': 'tests/unit/nested-tool-admission.spec.ts (catalog swap during approval)', 'PTC-A15': 'tests/unit/nested-tool-output-contract.spec.ts (capture, provider wire, MCP bridge)' },
}
await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ directory, passed: summary.passed, cases: results.map(result => `${result.id}:${result.status}`) }))
if (!summary.passed) process.exitCode = 1
