/** SP-02 harness, now driving the host sample in samples/durable-operations. Node-local SQLite, disposable services. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAgentRuntime, defineTool, ModelAdapter, ToolCallId, createApprovalBroker, withApprovalPersistence } from '@alvin0/ai-agent-sdk-core'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import { createToolExecutionInterceptor } from '@alvin0/ai-agent-sdk-core/agent'
import type { GenerateOptions, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { ToolExecutionStore } from '@alvin0/ai-agent-sdk-core/agent'
import { openOperationJournal } from '../../samples/durable-operations/journal.ts'

const output = (data: unknown) => console.log(JSON.stringify(data))
const sentinel = 'PRIVATE_DURABLE_SENTINEL'
const identity = { tenant: 'fixture-tenant', session: 'persisted-intent-session' }
// The sample owns schema, claim/complete CAS and reconciliation. The harness
// only adds failpoints through the journal's instrumentation hooks.
function instrumented(path: string, point: (name: string) => Promise<void>, fault = 'none') {
  const journal = openOperationJournal(path, { hooks: {
    afterClaim: () => point('after-claim'),
    async beforeCommit(_operation, database) {
      await point('before-commit')
      if (fault === 'commit-failure') throw new Error('Injected result commit failure')
      if (fault === 'disk-full') {
        const count = Number(database.prepare('PRAGMA page_count').get()!.page_count)
        database.exec(`PRAGMA max_page_count=${count}`)
      }
    },
    afterComplete: () => point('after-complete'),
  } })
  const store: ToolExecutionStore = {
    claim: (operation, signal) => journal.store.claim(operation, signal),
    async complete(operation, result, signal) {
      try { await journal.store.complete(operation, result, signal) }
      catch (error) {
        const code = error instanceof Error ? Reflect.get(error, 'errcode') : undefined
        if (fault === 'disk-full') { output({ type: 'point', name: `sqlite-error-${String(code)}` }); if (code !== 13) throw new Error('Expected SQLITE_FULL') }
        throw error
      }
    },
  }
  return { journal, store }
}
class Scripted extends ModelAdapter {
  amount: number
  toolName: string
  constructor(amount: number, toolName: string) { super(); this.amount = amount; this.toolName = toolName }
  round = 0
  leaked = false
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, context: { contextWindow: 16000 } } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.leaked ||= JSON.stringify(options.messages).includes(sentinel)
    if (++this.round === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name: this.toolName, arguments: JSON.stringify({ amount: this.amount }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
async function worker() {
  const [path, port, fault = 'none', variant = 'same'] = process.argv.slice(3)
  if (!path || !port) throw new Error('Worker requires database and port')
  const controller = new AbortController()
  const point = async (name: string) => {
    if (fault === 'abort-after-claim' && name === 'after-claim') controller.abort(new Error('Host revoked run after claim'))
    output({ type: 'point', name })
    if (fault === name) await new Promise<void>(() => { setInterval(() => {}, 1000) })
    if ((fault === 'hold-claim' && name === 'after-claim') || (fault === 'hold-commit' && name === 'before-commit')) await new Promise<void>(r => process.stdin.once('data', () => r()))
  }
  const { journal, store } = instrumented(path, point, fault)
  const db = journal.database
  const intent = journal.pendingIntent('pending') as { operationId: string; args: { amount: number } }
  await point('after-checkpoint')
  const toolName = variant === 'tool-conflict' ? 'other_record' : 'create_record'
  const adapter = new Scripted(variant === 'conflict' ? intent.args.amount + 1 : intent.args.amount, toolName)
  const provider = defineModelProviderPlugin({ id: 'fixture', routes: ['fixture'], displayName: 'Durable spike fixture',
    setup(registrar) { registrar.registerAdapter(adapter) } })
  const runtime = await createAgentRuntime({ providers: [provider] })
  let bodies = 0
  const agent = runtime.agent({ id: 'durable-spike', instructions: 'Execute only the persisted host intent; never retry an unknown outcome.', model: { provider: 'fixture', id: 'scripted' }, maxTurns: 3, compaction: false,
    tools: [defineTool({ name: toolName, description: 'Create the persisted host intent.', parameters: { type: 'object' },
      parse(raw) { const amount = raw && typeof raw === 'object' ? Reflect.get(raw, 'amount') : undefined; if (!Number.isSafeInteger(amount)) throw new Error('Invalid amount'); return { amount: amount as number } },
      async execute(_args, context) {
        bodies++
        await point('before-effect')
        const response = await fetch(`http://127.0.0.1:${port}/effect`, { method: 'POST', signal: context.signal })
        const receipt = await response.json() as { receipt: string }
        await point('after-effect')
        // disk-full: a result larger than the capped database can hold, so the commit itself fails.
        return { status: 'completed', receipt: receipt.receipt, private: sentinel, ...fault === 'disk-full' ? { padding: 'x'.repeat(1048576) } : {} }
      } })] })
  const broker = createApprovalBroker()
  const approvalMode = fault === 'approval-pending' || variant === 'approval-resume'
  let staleRejected = true
  const approvals = withApprovalPersistence(broker, {
    async savePending(request) {
      journal.approvals.savePending(request)
      if (fault === 'approval-pending') await point('approval-pending')
      else {
        const old = db.prepare('SELECT id FROM approvals WHERE id<>?').all(request.approvalRequestId)
        staleRejected = old.length > 0 && old.every(row => !broker.resolve(String(row.id), 'allow'))
        broker.resolve(request.approvalRequestId, 'deny')
      }
    },
    async saveDecision(request, decision) { journal.approvals.saveDecision(request, decision) },
  })
  const session = agent.createSession({ ...(approvalMode ? { approvals } : {}), interceptors: [
    ...(approvalMode ? [{ name: 'require-fresh-approval', async before() { return { kind: 'ask' as const, reason: 'Host requires current approval' } } }] : []),
 createToolExecutionInterceptor({ identity: variant === 'principal-conflict' ? { ...identity, tenant: 'other-tenant' } : identity,
    operationId: () => intent.operationId, store }),
  { name: 'projection-policy', async after(_call, result) { if (result.isError) return { kind: 'accept' }; return { kind: 'replace', content: [{ type: 'text', text: '{"status":"completed"}' }] } } }] })
  let publicLeak = false
  const events: { type: string; status?: string; callId?: string }[] = []
  try {
    const response = await session.run('Execute the persisted intent once.', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), includeTraceEvents: true,
      onEvent(event) { publicLeak ||= JSON.stringify(event).includes(sentinel); events.push({ type: event.type,
        ...('status' in event ? { status: event.status } : {}), ...('callId' in event ? { callId: event.callId } : {}) }) } })
    if (fault === 'delivery-disconnect' || variant === 'delivery-resume') {
      db.prepare('INSERT INTO deliveries(id,attempts) VALUES (?,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1').run(intent.operationId)
      try {
        const ack = await fetch(`http://127.0.0.1:${port}/deliver?id=${encodeURIComponent(intent.operationId)}`, { method: 'POST' })
        if (!ack.ok) throw new Error('Delivery not acknowledged')
      } catch { await point('delivery-disconnect'); throw new Error('Delivery disconnected') }
      await point('delivery-disconnect')
      db.prepare('UPDATE deliveries SET acknowledged=1 WHERE id=?').run(intent.operationId)
    }
    await point('after-publication')
    output({ type: 'result', status: response.report.status, bodies, leaked: adapter.leaked || publicLeak, staleRejected, events, codes: response.report.errors.map(e => e.code) })
  } catch (error) {
    const report = error instanceof Error ? Reflect.get(error, 'report') as { errors?: { code: string }[] } | undefined : undefined
    output({ type: 'result', status: 'error', bodies, leaked: adapter.leaked || publicLeak, staleRejected, events, codes: report?.errors?.map(e => e.code) ?? [] })
  } finally { await runtime.close(); journal.close() }
}
interface ChildResult { staleRejected: boolean; status: string; bodies: number; leaked: boolean; codes: string[]; events: { type: string; status?: string; callId?: string }[] }
async function launch(db: string, port: number, fault = 'none', variant = 'same', onPoint?: (name: string, release: () => void) => void) {
  return await new Promise<{ killed: boolean; terminationSignal: string | null; reached: string[]; result?: ChildResult }>((done, fail) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', resolve('test-human/spikes/durable-operation.ts'), '--worker', db, String(port), fault, variant], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH } })
    let pending = '', stderr = '', result: ChildResult | undefined, killed = false
    const reached: string[] = []
    const timeout = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`Worker deadline: ${fault}`)) }, 18000)
    child.on('error', error => { clearTimeout(timeout); fail(error) })
    child.stdout.on('data', chunk => {
      pending += String(chunk)
      let at: number
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1)
        try {
          const event = JSON.parse(line)
          if (event.type === 'point') {
            reached.push(event.name)
            if (event.name === fault) killed = child.kill('SIGKILL')
            onPoint?.(event.name, () => child.stdin.end('release\n'))
          }
          if (event.type === 'result') result = event
        } catch { /* Ignore non-protocol lines, never retain stderr/credentials. */ }
      }
    })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096) })
    child.on('close', (_code, signal) => { clearTimeout(timeout); if (!result && !killed) fail(new Error(`Worker exited without a terminal record: ${stderr}`)); else done({ killed, terminationSignal: signal, reached, ...(result ? { result } : {}) }) })
  })
}
async function main() {
  const id = `durable-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const root = resolve('artifacts/spikes', id)
  await mkdir(root, { recursive: true })
  const cases: unknown[] = []
  const scenarios = ['none', 'after-checkpoint', 'after-claim', 'before-effect', 'after-effect', 'after-complete', 'after-publication', 'commit-failure', 'concurrent', 'conflict', 'tool-conflict', 'principal-conflict', 'no-receipt', 'abort-after-claim', 'disk-full', 'approval-pending', 'delivery-disconnect', 'stale-writer']
    .flatMap(fault => Array.from({ length: ['concurrent', 'after-effect', 'after-complete'].includes(fault) ? 10 : 1 }, (_, repeat) => ({ fault, repeat })))
  for (const { fault, repeat } of scenarios) {
    let effects = 0, requests = 0, deliveryRequests = 0
    const deliveryIds = new Set<string>()
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/deliver?')) {
        req.resume(); deliveryRequests++; deliveryIds.add(new URL(req.url, 'http://fixture').searchParams.get('id') ?? '')
        if (fault === 'delivery-disconnect' && deliveryRequests === 1) { res.destroy(); return }
        res.end('ack'); return
      }
      if (req.method === 'POST') { requests++; effects++ }
      req.resume()
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ status: effects ? 'completed' : 'unknown', receipt: effects && !(fault === 'no-receipt' && req.method !== 'POST') ? 'receipt-1' : null, effects, requests }))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const path = resolve(root, `${fault}-${repeat}.sqlite`)
    const host = openOperationJournal(path)
    const db = host.database
    const operationId = `fixture-tenant:intent:${fault}:${repeat}`
    host.recordIntent('pending', { operationId, toolName: 'create_record', args: { amount: 7 }, identity })
    try {
      let first: Awaited<ReturnType<typeof launch>>[]
      if (fault === 'stale-writer') {
        let reconciliationError: unknown
        const owner = await launch(path, port, 'hold-commit', 'same', (name, release) => {
          if (name === 'before-commit') void (async () => {
            const outcome = await host.reconcile(operationId, async () => {
              const receipt = await (await fetch(`http://127.0.0.1:${port}/effect`)).json() as { receipt: string; effects: number }
              if (receipt.receipt !== 'receipt-1' || receipt.effects !== 1) throw new Error('Independent reconciliation receipt missing')
              return { status: 'completed', result: { isError: false, value: { receipt: receipt.receipt, reconciled: true }, content: [{ type: 'text', text: '{"receipt":"receipt-1"}' }] } }
            })
            if (outcome !== 'reconciled') throw new Error(`Fencing reconciliation failed: ${outcome}`)
            release()
          })().catch(error => { reconciliationError = error; release() })
        })
        if (reconciliationError) throw reconciliationError
        first = [owner]
      } else if (fault === 'concurrent') {
        let contender: Promise<Awaited<ReturnType<typeof launch>>> | undefined
        const owner = await launch(path, port, 'hold-claim', 'same', (name, release) => {
          if (name === 'after-claim') { contender = launch(path, port); void contender.then(release, release) }
        })
        if (!contender) throw new Error('Concurrent claim barrier was not reached')
        first = [owner, await contender]
      } else first = [await launch(path, port, fault === 'no-receipt' ? 'after-effect' : ['none', 'conflict', 'tool-conflict', 'principal-conflict'].includes(fault) ? 'none' : fault)]
      if (fault === 'approval-pending') db.prepare("UPDATE approvals SET decision='allow' WHERE decision IS NULL").run()
      const conflict = ['conflict', 'tool-conflict', 'principal-conflict'].includes(fault)
      const second = await launch(path, port, 'none', conflict ? fault : fault === 'approval-pending' ? 'approval-resume' : fault === 'delivery-disconnect' ? 'delivery-resume' : 'same')
      const expectedEffects = ['after-claim', 'before-effect', 'abort-after-claim', 'approval-pending'].includes(fault) ? 0 : 1
      const unknown = ['after-claim', 'before-effect', 'after-effect', 'commit-failure', 'no-receipt', 'abort-after-claim', 'disk-full'].includes(fault)
      const checks = [
        { name: 'kill failpoint reached and process terminated', passed: ['none', 'concurrent', 'conflict', 'tool-conflict', 'principal-conflict', 'commit-failure', 'abort-after-claim', 'disk-full', 'stale-writer'].includes(fault) || first[0]!.killed && first[0]!.terminationSignal === 'SIGKILL' },
        { name: 'independent service effect count', passed: effects === expectedEffects },
        { name: 'no replay hidden by external idempotency', passed: requests === expectedEffects },
        { name: 'resume dispatch count', passed: second.result?.bodies === (fault === 'after-checkpoint' ? 1 : 0) },
        { name: 'unknown remains unknown, conflict stays distinct', passed: second.result?.codes.includes(conflict ? 'OPERATION_ID_CONFLICT' : 'OPERATION_OUTCOME_UNKNOWN') === (unknown || conflict) },
        { name: 'resume terminal status', passed: second.result?.status === (unknown || conflict ? 'error' : 'success') },
        { name: 'post-policy applied to fresh and recovered result', passed: !first.some(r => r.result?.leaked) && second.result?.leaked === false },
      ]
      if (fault === 'stale-writer') checks.push({ name: 'late original writer cannot overwrite fenced reconciliation', passed: first[0]!.result?.events.some(e => e.type === 'tool-result' && e.status === 'failed') === true && db.prepare('SELECT generation FROM operations WHERE id=?').get(operationId)?.generation === 2 && String(db.prepare('SELECT result FROM operations WHERE id=?').get(operationId)?.result).includes('reconciled') })
      if (fault === 'approval-pending') checks.push({ name: 'fresh approval reissued; old decision cannot dispatch', passed: second.result?.staleRejected === true && db.prepare('SELECT count(*) AS n FROM operations').get()!.n === 0 && db.prepare('SELECT count(*) AS n FROM approvals').get()!.n === 2 && db.prepare("SELECT count(*) AS n FROM approvals WHERE decision='allow'").get()!.n === 1 && db.prepare("SELECT count(*) AS n FROM approvals WHERE decision='deny'").get()!.n === 1 })
      if (fault === 'disk-full') checks.push({ name: 'real SQLite storage capacity failure', passed: first[0]!.reached.includes('sqlite-error-13') })
      if (fault === 'delivery-disconnect') { const row = db.prepare('SELECT attempts, acknowledged FROM deliveries WHERE id=?').get(operationId); checks.push({ name: 'retry delivery by persisted identity without rerunning body', passed: row?.attempts === 2 && row.acknowledged === 1 && requests === 1 && deliveryRequests === 2 && deliveryIds.size === 1 && deliveryIds.has(operationId) }) }
      if (fault === 'concurrent') checks.push({ name: 'contender blocked while original claim is still alive', passed: first[1]?.result?.bodies === 0 && first[1].result.codes.includes('OPERATION_OUTCOME_UNKNOWN') })
      if (fault === 'commit-failure' || fault === 'disk-full') checks.push({ name: 'failed commit is not published as successful tool completion', passed: first[0]?.result?.events.some(e => e.type === 'tool-result' && e.status === 'failed') === true && db.prepare('SELECT result FROM operations WHERE id=?').get(operationId)?.result === null })
      if (fault === 'none' || fault === 'after-complete') checks.push({ name: 'provider call identity is renewed but persisted intent is reused', passed: first[0]?.result === undefined || first[0].result.events.find(e => e.type === 'tool-call')?.callId !== second.result?.events.find(e => e.type === 'tool-call')?.callId })
      // Reconciliation is explicit, backed by independent service evidence; never time-based retry.
      let reconciled: Awaited<ReturnType<typeof launch>> | undefined
      if (fault === 'no-receipt') checks.push({ name: 'no receipt means no fabricated reconciliation', passed: db.prepare('SELECT result FROM operations WHERE id=?').get(operationId)?.result === null && requests === 1 })
      if (unknown && effects === 1 && fault !== 'no-receipt') {
        const outcome = await host.reconcile(operationId, async () => {
          const receipt = await (await fetch(`http://127.0.0.1:${port}/effect`)).json() as { receipt: string; effects: number }
          if (receipt.receipt !== 'receipt-1' || receipt.effects !== 1) throw new Error('Untrusted receipt')
          return { status: 'completed', result: { isError: false, value: { receipt: receipt.receipt, private: sentinel }, content: [{ type: 'text', text: sentinel }] } }
        })
        if (outcome !== 'reconciled') throw new Error(`Reconciliation failed: ${outcome}`)
        reconciled = await launch(path, port)
        checks.push({ name: 'receipt reconciliation permits reuse without replay', passed: reconciled.result?.status === 'success' && reconciled.result.bodies === 0 && !reconciled.result.leaked && requests === 1 && effects === 1 })
      }
      const record = { fault, repeat, operationId, checks, first, second, reconciled, effects, requests, deliveryRequests, deliveryIds: [...deliveryIds], passed: checks.every(c => c.passed) }
      cases.push(record)
      await writeFile(resolve(root, `${fault}-${repeat}.json`), JSON.stringify(record, null, 2), { flag: 'wx' })
      output({ fault, repeat, passed: record.passed })
    } finally { host.close(); await new Promise<void>(r => server.close(() => r())) }
  }
  const summary = { spike: 'SP-02', status: 'completed', decision: 'go-for-local-host-spike', scope: 'Node-local two-worker SQLite process recovery; deterministic AgentRuntime fixture, not live-model utility or distributed recovery',
    node: process.version, sourceHash: createHash('sha256').update(await readFile('test-human/spikes/durable-operation.ts')).digest('hex'),
    sampleHash: createHash('sha256').update(await readFile('samples/durable-operations/journal.ts')).digest('hex'),
    cases, passed: cases.every(c => (c as { passed: boolean }).passed), limitations: ['Host sample, not a package export', 'No atomic session/checkpoint/journal transaction (accepted in ADR)', 'Host owns retirement and receipt reconciliation; no automatic reclaim or distributed lease', 'Node-local SQLite only; not a distributed store'] }
  await writeFile(resolve(root, 'durable-operation.ts'), await readFile('test-human/spikes/durable-operation.ts'), { flag: 'wx' })
  await writeFile(resolve(root, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' })
  output({ artifact: resolve(root, 'summary.json'), passed: summary.passed })
  if (!summary.passed) process.exitCode = 1
}
if (process.argv[2] === '--worker') await worker()
else await main()
