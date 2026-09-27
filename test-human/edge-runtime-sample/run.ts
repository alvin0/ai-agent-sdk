/** Actual Next Edge route, real OpenAI provider and compact SSE wire contract. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

if (process.argv.includes('--help')) {
  console.log('node --experimental-strip-types test-human/edge-runtime-sample/run.ts --base <sample-url> --output <new-directory> [--model <id>] [--secondary-model <id>] [--only <case-id,...>]')
  process.exit(0)
}

const option = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1] }
const caseIds = [
  'single-and-model-switch-preserve-history', 'clock-tool-real-execution',
  'bounded-https-tool-real-execution', 'provider-error-and-recovery',
  'credential-scoped-traces-and-close', 'fixed-team-peer-report-and-synthesis',
  'team-auto-workers-released-between-turns', 'disconnect-aborts-provider-and-allows-next-turn',
]
const selected = new Set((option('only') ?? caseIds.join(',')).split(','))
assert.ok([...selected].every(id => caseIds.includes(id)), 'Unknown --only case id')
const base = option('base') ?? 'http://127.0.0.1:3368'
const output = resolve(option('output') ?? (() => { throw new Error('--output required') })())
const model = option('model') ?? 'gpt-6-luna'
const secondary = option('secondary-model') ?? model
await mkdir(output, { recursive: false })
type Wire = Record<string, unknown>
const rows: Record<string, unknown>[] = [], conversations = new Set<string>()
const prefix = `audit-${Date.now().toString(36)}`
const events: Record<string, Wire[]> = {}
const text = (event: Wire | undefined) => String(event?.text ?? '')
const body = (id: string, message: string, extra: Record<string, unknown> = {}) => ({ conversationId: id, message, model, ...extra })
async function request(path: string, method = 'GET', input?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(150000) })
}
async function chat(id: string, message: string, extra: Record<string, unknown> = {}) {
  conversations.add(id)
  const response = await request('/chat', 'POST', body(id, message, extra))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const seen = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as Wire)
  ;(events[id] ??= []).push(...seen)
  assert.equal(seen[0]?.t, 'start')
  const terminals = seen.filter(event => event.t === 'done' || event.t === 'error')
  assert.equal(terminals.length, 1)
  assert.equal(seen.at(-1), terminals[0])
  return { seen, terminal: terminals[0]! }
}
function completed(result: Awaited<ReturnType<typeof chat>>) {
  assert.equal(result.terminal.t, 'done', JSON.stringify(result.terminal))
  const usage = result.terminal.usage as { inputTokens: number; outputTokens: number }
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0)
}
async function run(id: string, action: () => Promise<unknown>) {
  if (!selected.has(id)) return
  const at = performance.now()
  try { const evidence = await action(); rows.push({ id, passed: true, elapsedMs: Math.round(performance.now() - at), evidence }) }
  catch (error) { rows.push({ id, passed: false, elapsedMs: Math.round(performance.now() - at), error: error instanceof Error ? error.message : 'unknown error' }) }
  console.log(JSON.stringify({ id, passed: rows.at(-1)!.passed }))
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ base, model, secondary, rows }, null, 2))
  await writeFile(resolve(output, 'events.json'), JSON.stringify(events, null, 2))
}

try {
  await run('single-and-model-switch-preserve-history', async () => {
    const id = `${prefix}-history`
    const first = await chat(id, 'Remember this exact marker: edge-4827. Reply only ACK.'); completed(first)
    const second = await chat(id, 'Return only the exact marker I gave previously.', { model: secondary }); completed(second)
    assert.equal(text(second.terminal).trim(), 'edge-4827')
    const traces = await (await request(`/conversations/${id}/traces`)).json() as { traces: Wire[] }
    assert.equal(traces.traces.length, 2)
    assert.ok(traces.traces.every(trace => trace.status === 'success' && Number(trace.spans) > 0))
    return { texts: [text(first.terminal), text(second.terminal)], traces: traces.traces }
  })
  await run('clock-tool-real-execution', async () => {
    const result = await chat(`${prefix}-clock`, 'Call current_time with timeZone UTC exactly once, then report the date from its result.'); completed(result)
    assert.ok(result.seen.some(event => event.t === 'tool-call' && event.name === 'current_time'))
    assert.ok(result.seen.some(event => event.t === 'tool-result' && event.name === 'current_time' && event.status === 'completed'))
    assert.ok(text(result.terminal).includes(new Date().getUTCFullYear().toString()))
    return { terminal: result.terminal }
  })
  await run('bounded-https-tool-real-execution', async () => {
    const result = await chat(`${prefix}-fetch`, 'Call fetch_url for https://www.iana.org/help/example-domains exactly once. Summarize the actual page in one sentence.'); completed(result)
    assert.ok(result.seen.some(event => event.t === 'tool-call' && event.name === 'fetch_url'))
    assert.ok(result.seen.some(event => event.t === 'tool-result' && event.name === 'fetch_url' && event.status === 'completed'))
    assert.match(text(result.terminal), /example|illustrat/i)
    return { terminal: result.terminal }
  })
  await run('provider-error-and-recovery', async () => {
    const id = `${prefix}-error`
    const bad = await chat(id, 'Reply only OK.', { model: 'definitely-no-such-model-sdk-harness-audit' })
    assert.equal(bad.terminal.t, 'error'); assert.ok(Number(bad.terminal.status) >= 400)
    assert.ok(typeof bad.terminal.detail === 'string' && bad.terminal.detail.length > 0)
    const recovered = await chat(id, 'Reply only RECOVERED.'); completed(recovered)
    assert.equal(text(recovered.terminal).trim(), 'RECOVERED')
    return { failed: bad.terminal, recovered: recovered.terminal }
  })
  await run('credential-scoped-traces-and-close', async () => {
    const id = `${prefix}-owner`
    const first = await chat(id, 'Reply only OWNER_OK.'); completed(first)
    const runId = first.seen[0]!.runId
    const headers = { 'x-openai-key': 'sk-other-harness-fixture' }
    const foreign = await (await request(`/traces/${String(runId)}`, 'GET', undefined, headers)).json()
    assert.deepEqual(foreign, { spans: [] })
    const denied = await (await request('/close', 'POST', { conversationId: id }, headers)).json()
    assert.deepEqual(denied, { closed: false })
    const own = await (await request(`/traces/${String(runId)}`)).json() as { spans: unknown[] }
    assert.ok(own.spans.length > 0)
    return { foreign, denied, ownSpanCount: own.spans.length }
  })
  await run('fixed-team-peer-report-and-synthesis', async () => {
    const result = await chat(`${prefix}-fixed`, 'Use followup_task to start peer with the task: return PEER_OK. Wait for its result using wait_agents. Then reply only TEAM_FIXED_OK.', {
      mode: 'team', team: [{ name: 'lead', role: 'lead' }, { name: 'peer', role: 'peer', instructions: 'Return exactly PEER_OK when asked.' }],
    }); completed(result)
    assert.ok(result.seen.some(event => event.t === 'member-start' && event.member === 'peer'))
    assert.ok(result.seen.some(event => event.t === 'member-end' && event.member === 'peer' && event.failed !== true))
    assert.ok(result.seen.some(event => event.t === 'member-message' && event.member === 'peer' && text(event).includes('PEER_OK')))
    assert.equal(text(result.terminal).trim(), 'TEAM_FIXED_OK')
    return { terminal: result.terminal }
  })
  await run('team-auto-workers-released-between-turns', async () => {
    const id = `${prefix}-auto`, terminals: Wire[] = [], mismatches: string[] = []
    for (const name of ['first', 'second']) {
      const result = await chat(id, `Use spawn_agent to create an analyst named ${name} with task: reply exactly AUTO_PEER_OK. Wait for its result, then reply only AUTO_TEAM_OK.`, { mode: 'team-auto' }); completed(result)
      assert.ok(result.seen.some(event => event.t === 'tool-call' && event.name === 'spawn_agent'))
      assert.ok(result.seen.some(event => event.t === 'member-start' && event.member === name))
      assert.ok(result.seen.some(event => event.t === 'member-end' && event.member === name && event.failed !== true))
      const workerEnds = result.seen.filter(event => event.t === 'span')
        .map(event => event.span as Wire)
        .filter(span => span.kind === 'invoke_agent' && span.member === name && span.durationMs !== null)
      assert.ok(workerEnds.length > 0, 'Missing worker terminal trace')
      const workerText = text(workerEnds.at(-1)?.output as Wire | undefined).trim()
      if (workerText !== 'AUTO_PEER_OK') mismatches.push(`${name} worker: ${JSON.stringify(workerText)}`)
      if (text(result.terminal).trim() !== 'AUTO_TEAM_OK') mismatches.push(`${name} lead: ${JSON.stringify(text(result.terminal))}`)
      terminals.push(result.terminal)
    }
    assert.deepEqual(mismatches, [], 'Worker and lead must honor their distinct assigned outputs on both turns')
    return { terminals }
  })
  await run('disconnect-aborts-provider-and-allows-next-turn', async () => {
    const id = `${prefix}-abort`; conversations.add(id)
    const abort = new AbortController()
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body(id, 'Write 800 words about oceans.')), signal: abort.signal })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = '', runId = ''
    for (;;) {
      const chunk = await reader.read(); assert.equal(chunk.done, false)
      pending += decoder.decode(chunk.value, { stream: true })
      if (!runId) { const start = pending.split('\n').find(line => line.startsWith('data: ') && line.includes('"t":"start"')); if (start) runId = String((JSON.parse(start.slice(6)) as Wire).runId) }
      if (pending.includes('"t":"text-delta"')) break
    }
    abort.abort(); await reader.cancel().catch(() => undefined)
    let settled: Wire | undefined
    for (let n = 0; n < 100; n++) {
      const data = await (await request(`/conversations/${id}/traces`)).json() as { traces: Wire[] }
      settled = data.traces.find(row => row.runId === runId)
      if (settled?.status === 'aborted' || settled?.status === 'error') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(settled?.status === 'aborted' || settled?.status === 'error', JSON.stringify(settled))
    const next = await chat(id, 'Reply only AFTER_ABORT.'); completed(next)
    assert.equal(text(next.terminal).trim(), 'AFTER_ABORT')
    return { abortedTrace: settled, next: next.terminal }
  })
} finally {
  const cleanup: unknown[] = []
  for (const id of conversations) {
    try {
      const response = await request('/close', 'POST', { conversationId: id })
      assert.equal(response.status, 200)
      cleanup.push({ id, ...await response.json() as Record<string, unknown> })
    } catch (error) {
      cleanup.push({ id, error: error instanceof Error ? error.message : 'cleanup failed' })
    }
  }
  await writeFile(resolve(output, 'cleanup.json'), JSON.stringify(cleanup, null, 2))
}
assert.ok(rows.length === selected.size && rows.every(row => row.passed), 'Inspect retained sample flow failures')

const cleanup = JSON.parse(await readFile(resolve(output, 'cleanup.json'), 'utf8')) as Wire[]
assert.ok(cleanup.every(row => row.closed === true), 'Inspect retained cleanup failures')
