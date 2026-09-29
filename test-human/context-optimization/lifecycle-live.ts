/** Real Codex traffic through optimizer composition, paging, milestones and reducer guards. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createAgentRuntime, createMessage, ModelRegistry } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, JsonValue } from '@alvin0/ai-agent-sdk-core'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { codexNodeAdapter, codexNodeProviderPlugin } from '@alvin0/ai-agent-sdk-auth-node/codex'
import { createContextOptimizer } from '@alvin0/ai-agent-sdk-core/memory'
import { createMemorySpillStore, createModelEvidenceReducer, defineTool } from '@alvin0/ai-agent-sdk-core/tools'
import type { EvidenceReducer } from '@alvin0/ai-agent-sdk-core/tools'

const option = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] }
const output = resolve(option('output') ?? (() => { throw new Error('--output required') })())
const model = option('model') ?? 'gpt-6-luna'
const selectedCase = option('case')
const cases = ['two-full-requests-paging-milestone-and-resume', 'live-reducer-evidence-in-main-model-request', 'corrupt-reducer-raw-fallback-in-main-model-request', 'queued-steering-application-redaction-before-real-provider', 'shared-projection-parallel-real-provider-isolation', 'checkpoint-retry-steering-supersedes-original-objective']
assert.ok(selectedCase === undefined || cases.includes(selectedCase), 'Unknown --case')
await mkdir(output, { recursive: true })
const runtime = await createAgentRuntime({ providers: [codexNodeProviderPlugin({ defaultModel: model })] })
const rows: Record<string, unknown>[] = []
const checkpointText = (request: GenerateOptions) => JSON.stringify(request.messages)
const invoke = { signal: AbortSignal.timeout(300_000) }
const prefix = 'inventory row: ordinary fixture data\n'.repeat(450)
const marker = 'fixture-7391'
const inventory = prefix + `EVIDENCE_MARKER=${marker}\n`
const log = 'ordinary build progress\n'.repeat(250) + 'FAIL sentinel.spec.ts:37\nExpected true\nReceived false\n  at sentinel.ts:19:2\nTests 1 failed, 3 passed\nexit code 1\n'

async function runCase(id: string, action: () => Promise<Record<string, unknown>>) {
  if (selectedCase !== undefined && selectedCase !== id) return
  const started = performance.now()
  try {
    const evidence = await action()
    rows.push({ id, passed: true, elapsedMs: Math.round(performance.now() - started), ...evidence })
    console.log(JSON.stringify({ id, passed: true }))
  } catch (error) {
    rows.push({ id, passed: false, elapsedMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : 'unknown error' })
    console.log(JSON.stringify({ id, passed: false }))
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ model, rows }, null, 2))
}

try {
  await runCase('checkpoint-retry-steering-supersedes-original-objective', async () => {
    const registry = new ModelRegistry()
    const remove = registry.registerAdapter(['codex'], codexNodeAdapter())
    const requests: string[] = []
    let preparations = 0
    const session = defineAgent({ id: 'retry-steering', provider: 'codex', model, effort: 'low', mode: 'basic',
      instructions: 'Follow the latest user request exactly.', compaction: false, maxTurns: 4,
    }).createSession({ registry, hooks: {
      beforeStep() {
        if (++preparations === 2) session.inject('The latest instruction overrides the first request. Reply only with 83.')
        return { kind: 'proceed' }
      },
      checkpoint(context) {
        if (context.kind !== 'before-model-request') return
        if (preparations === 1) {
          session.inject('Checkpoint steering: change the requested number to 83.')
          throw new Error('fixture: checkpoint unavailable')
        }
        requests.push(checkpointText(context.request))
      },
      onRequestError: () => 'retry',
    } })
    try {
      const result = await session.run('Reply only with 37.', invoke)
      await writeFile(resolve(output, 'checkpoint-retry-request-trace.json'), JSON.stringify(requests, null, 2))
      assert.equal(result.outcome.completed, true)
      assert.equal(result.text.trim(), '83', 'steering must supersede the pinned original objective')
      assert.equal(requests.length, 1)
      assert.equal(preparations, 2)
      assert.ok(requests[0]?.includes('original-objective'), 'the original objective must remain retained')
      assert.ok(requests[0]?.includes('Checkpoint steering'))
      assert.ok(requests[0]?.includes('latest instruction'))
      assert.ok(JSON.stringify(session.snapshot().history).includes('Reply only with 37.'), 'raw history must retain the original request')
      return { text: result.text, preparations, modelRequests: requests.length, usage: result.report.usage }
    } finally { remove() }
  })

  await runCase('two-full-requests-paging-milestone-and-resume', async () => {
    const requests: { bytes: number; raw: boolean; packed: boolean; milestone: boolean }[] = []
    const requestTrace: string[] = []
    const calls: string[] = [], usage: unknown[] = []
    let bodies = 0, archives = 0, retired = false, deniedAfterRetirement = 0
    const authority = { name: 'retired-inventory', before: async () => {
      if (retired) { deniedAfterRetirement++; return { kind: 'deny' as const, reason: 'The host retired reads after verification. Use the retained verified state.' } }
      return { kind: 'allow' as const }
    } }
    const store = createMemorySpillStore()
    const optimizer = createContextOptimizer({ store, archive: async (snapshot, milestone, signal) => {
      await writeFile(resolve(output, `${milestone.id}-raw.json`), JSON.stringify(snapshot, null, 2), { signal }); archives++
    } })
    const dump = defineTool({ name: 'read_inventory', description: 'Read the fixture inventory, including its exact evidence marker.', parameters: { type: 'object', properties: {}, additionalProperties: false },
      maxOutputTokens: 20000, execute: () => { bodies++; return inventory } })
    const agent = runtime.agent({ id: 'live-inventory', model: { provider: 'codex', id: model }, effort: 'low', compaction: false,
      maxTurns: 6, maxToolCalls: 6,
      instructions: 'Follow each turn precisely. Read original inventory evidence using read_inventory. Prior verified tool receipts and host-verified milestone state remain valid evidence. Use read_tool_output when asked for a stored chunk. Never repeat read_inventory unless explicitly asked.',
      tools: [dump] })
    const session = agent.createSession({ tools: [optimizer.retrievalTool], interceptors: [authority], runtimeLimits: { maxToolResultTokens: 20000 }, hooks: optimizer.wrapHooks({ checkpoint(context) {
      if (context.kind === 'before-tool-dispatch') calls.push(context.call.toolName)
      if (context.kind === 'before-model-request') {
        const text = checkpointText(context.request)
        requestTrace.push(text)
        requests.push({ bytes: Buffer.byteLength(text), raw: text.includes(JSON.stringify(inventory).slice(1, -1)), packed: text.includes('Observation stored'), milestone: text.includes('[Completed inventory-verified:') })
      }
    } }) })
    try {
      for (const prompt of ['Call read_inventory exactly once with {}. Then reply only LOADED.', 'Reply only ACK. Do not call tools.']) {
        const result = await session.run(prompt, invoke); assert.equal(result.completed, true); usage.push(result.usage)
      }
      const packedAt = requests.length
      const recovered = await session.run(`Use read_tool_output with the stored inventory locator, offset ${[...prefix].length}, limit 100. Do not call read_inventory. Return only the EVIDENCE_MARKER value from that chunk.`, invoke)
      assert.equal(recovered.completed, true); assert.equal(recovered.text.trim(), marker); usage.push(recovered.usage)
      assert.equal(requests[1]?.raw, true); assert.equal(requests[2]?.raw, true)
      assert.equal(requests[packedAt]?.packed, true); assert.equal(requests[packedAt]?.raw, false)
      assert.equal(bodies, 1); assert.ok(calls.includes('read_tool_output'))
      const snapshot = session.snapshot()
      optimizer.completeMilestone({ id: 'inventory-verified', throughSeq: snapshot.history.entries.at(-1)!.seq,
        summary: `Inventory read once; exact marker ${marker} verified by stored chunk retrieval. No mutations.`, remainingTurns: 3, compactionCost: 0 })
      retired = true
      const compactedAt = requests.length
      const recall = await session.run('From verified retained state, return only the inventory evidence marker. Do not call tools.', invoke)
      assert.equal(recall.completed, true); assert.equal(recall.text.trim(), marker, 'milestone recall'); usage.push(recall.usage)
      assert.equal(requests[compactedAt]?.milestone, true); assert.equal(requests[compactedAt]?.raw, false)
      assert.equal(archives, 1)
      assert.equal(bodies, 1, 'milestone recall must not be satisfied by a new read')
      assert.ok(JSON.stringify(session.snapshot()).includes(JSON.stringify(inventory).slice(1, -1)), 'raw snapshot must retain the inventory')
      // Resume with fresh optimizer/store state, as prescribed by the SDK lifecycle contract.
      const fresh = createContextOptimizer({ store: createMemorySpillStore() })
      const resumed = agent.resumeSession(JSON.parse(JSON.stringify(session.snapshot())), { tools: [fresh.retrievalTool], interceptors: [authority], hooks: fresh.wrapHooks({ checkpoint(context) {
        if (context.kind === 'before-model-request') requestTrace.push(checkpointText(context.request))
      } }) })
      try {
        const after = await resumed.run('Return only the exact inventory evidence marker already verified. Do not call tools.', invoke)
        assert.equal(after.completed, true); assert.equal(after.text.trim(), marker, 'resumed recall'); usage.push(after.usage)
      } finally { fresh.dispose() }
      assert.equal(bodies, 1, 'resumed recall must not be satisfied by a new read')
      return { requests, calls, bodies, archives, deniedAfterRetirement, metrics: optimizer.metrics(), usage }
    } finally {
      optimizer.dispose()
      await writeFile(resolve(output, 'inventory-request-trace.json'), JSON.stringify({ requests, requestTrace, bodies, archives, deniedAfterRetirement }, null, 2))
    }
  })

  for (const valid of [true, false]) await runCase(valid ? 'live-reducer-evidence-in-main-model-request' : 'corrupt-reducer-raw-fallback-in-main-model-request', async () => {
    const requests: { reduced: boolean; raw: boolean; evidence: boolean }[] = []
    const extractionUsage: unknown[] = []
    let bodies = 0, reductions = 0
    const extractor = runtime.agent({ id: `extractor-${valid}`, model: { provider: 'codex', id: model }, effort: 'low', compaction: false, tools: [], maxTurns: 2,
      instructions: 'Return the exact requested extractive JSON without prose.' })
    const bridge = createModelEvidenceReducer({ generate: async request => {
      reductions++
      const result = await extractor.createSession().run(request.system + '\n' + request.prompt, {
        signal: request.signal, structuredOutput: { name: 'evidence', schema: {
          jsonSchema: { type: 'object', properties: { status: { type: 'string', enum: ['pass', 'fail', 'unknown'] }, lines: { type: 'array', items: { type: 'object', properties: { line: { type: 'integer' }, text: { type: 'string' } }, required: ['line', 'text'], additionalProperties: false } } }, required: ['status', 'lines'], additionalProperties: false },
          parse: value => value as JsonValue,
        } },
      })
      assert.equal(result.completed, true); extractionUsage.push(result.usage)
      return JSON.stringify(result.output)
    } })
    const reducer: EvidenceReducer = valid ? bridge : { async reduce() { reductions++; return { status: 'pass', lines: [] } } }
    const optimizer = createContextOptimizer({ store: createMemorySpillStore(), reducer, log: name => name === 'read_build_log' ? { status: 'fail' } : undefined })
    const session = runtime.agent({ id: `build-reader-${valid}`, model: { provider: 'codex', id: model }, effort: 'low', compaction: false, maxTurns: 4,
      instructions: 'Call read_build_log exactly once. Then report only the test verdict, failing test path and line number from actual tool evidence.',
      tools: [defineTool({ name: 'read_build_log', description: 'Read a build log. Its authoritative exit status is failure.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => { bodies++; return log } }), optimizer.retrievalTool],
    }).createSession({ hooks: optimizer.wrapHooks({ checkpoint(context) {
      if (context.kind === 'before-model-request') { const text = checkpointText(context.request)
        requests.push({ reduced: text.includes('Extractive log; status: fail'), raw: text.includes(JSON.stringify(log).slice(1, -1)), evidence: text.includes('FAIL sentinel.spec.ts:37') }) }
    } }) })
    try {
      const result = await session.run('Read the build log and report the verdict with failing path and line. Do not rerun a build.', invoke)
      assert.equal(result.completed, true); assert.match(result.text, /fail/i); assert.match(result.text, /sentinel\.spec\.ts:37|sentinel\.spec\.ts.*37/s)
      assert.equal(bodies, 1); assert.equal(reductions, 1)
      assert.ok(requests.some(request => request.evidence && (valid ? request.reduced && !request.raw : request.raw && !request.reduced)))
      assert.equal(valid ? optimizer.metrics().verifiedReductions : optimizer.metrics().rejectedReductions, 1)
      return { requests, bodies, reductions, text: result.text, usage: result.usage, extractionUsage, metrics: optimizer.metrics() }
    } finally { optimizer.dispose() }
  })

  await runCase('queued-steering-application-redaction-before-real-provider', async () => {
    const registry = new ModelRegistry(); registry.registerAdapter(['codex'], codexNodeAdapter({ requestTimeoutMs: 120000 }))
    const canary = 'PRIVATE/queued%lifecycle-canary', requests: string[] = []
    let visibleToHook = false, bodies = 0
    const optimizer = createContextOptimizer({ store: createMemorySpillStore() })
    let session: ReturnType<ReturnType<typeof defineAgent>['createSession']>
    session = defineAgent({ id: 'redacted-steer', provider: 'codex', model, effort: 'low', mode: 'basic', compaction: false, maxTurns: 4,
      instructions: 'Call read_public exactly once, then report only the returned public number. Do not call any other tool.',
      tools: [defineTool({ name: 'read_public', description: 'Read a public number.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute() { bodies++; session.inject(canary); return { publicNumber: 37 } } }), optimizer.retrievalTool],
    }).createSession({ registry, hooks: optimizer.wrapHooks({ beforeStep(context) {
      visibleToHook ||= JSON.stringify(context.messages).includes(canary) && JSON.stringify(context.snapshot).includes(canary)
      return { kind: 'proceed', messages: context.messages.filter(message => !JSON.stringify(message).includes(canary)) }
    }, checkpoint(context) { if (context.kind === 'before-model-request') requests.push(checkpointText(context.request)) } }) })
    try {
      const result = await session.run('Read the public number and return only that number.', invoke)
      assert.equal(result.outcome.completed, true); assert.equal(result.text.trim(), '37')
      assert.equal(bodies, 1); assert.equal(visibleToHook, true)
      assert.ok(requests.length >= 2); assert.ok(requests.every(request => !request.includes(canary)))
      return { modelRequests: requests.length, bodies, visibleToHook, canaryAbsentFromEveryProviderRequest: true, text: result.text, usage: result.report.usage }
    } finally { optimizer.dispose() }
  })
  await runCase('shared-projection-parallel-real-provider-isolation', async () => {
    const registry = new ModelRegistry(); registry.registerAdapter(['codex'], codexNodeAdapter({ requestTimeoutMs: 120000 }))
    const requests: string[] = []
    // Codex rejects an empty input. Replace private input with one public app
    // message while keeping the same decision object shared by both sessions.
    const projection = Object.freeze({ kind: 'proceed' as const, messages: Object.freeze([
      createMessage({ role: 'user', source: { kind: 'app', producer: 'live-audit' }, content: [{ type: 'text', text: 'Reply only with the number 37.' }] }),
    ]) })
    let entered = 0, release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const agent = defineAgent({ id: 'shared-projection', provider: 'codex', model, effort: 'low', mode: 'basic', compaction: false,
      instructions: 'Reply only with the number 37.', tools: [] })
    const sessions = [0, 1].map(() => agent.createSession({ registry, hooks: {
      async beforeStep() {
        if (++entered === 2) release()
        await barrier
        return projection
      }, checkpoint(context) { if (context.kind === 'before-model-request') requests.push(checkpointText(context.request)) },
    } }))
    const results = await Promise.all(sessions.map((session, index) => session.run(`PRIVATE/parallel%live-${index}`, invoke)))
    await writeFile(resolve(output, 'shared-projection-trace.json'), JSON.stringify({ requests, results: results.map(result => ({ outcome: result.outcome, text: result.text, usage: result.report.usage })) }, null, 2))
    assert.equal(requests.length, 2)
    assert.ok(requests.every(request => !request.includes('PRIVATE/parallel%')))
    assert.ok(results.every(result => result.outcome.completed && result.text.trim() === '37'))
    assert.ok(sessions.every(session => JSON.stringify(session.snapshot()).includes('PRIVATE/parallel%')))
    return { modelRequests: requests.length, canaryAbsentFromEveryProviderRequest: true, texts: results.map(result => result.text), usage: results.map(result => result.report.usage) }
  })
} finally {
  const close = await runtime.close()
  await writeFile(resolve(output, 'runtime-close.json'), JSON.stringify(close, null, 2))
}
assert.ok(rows.length === (selectedCase === undefined ? cases.length : 1) && rows.every(row => row.passed), 'Inspect retained failures; live lifecycle acceptance did not pass')
