/**
 * Live end-to-end workflows against a running chat-agents sample (real model, real
 * HTTP API, real workspace). Start the sample with isolated CHAT_AGENTS_DB /
 * CHAT_AGENTS_WORKSPACE / CHAT_AGENTS_SPILL first; this harness never touches the
 * default sample state. Each scenario has a host-side oracle on workspace files or
 * exact answers, never on the model's claims alone.
 *
 *   node --experimental-strip-types test-human/chat-agents-live/run.ts \
 *     --base http://localhost:3310 --workspace <dir> --provider openai --model <id> [--only S2,S4]
 */
import { mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const args = process.argv.slice(2)
const option = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : args[at + 1] ?? fallback }
const BASE = option('base', 'http://localhost:3310')!
const WORKSPACE = option('workspace')
const PROVIDER = option('provider', 'openai')!
const MODEL = option('model')
const ONLY = option('only')?.split(',')
const REPEAT = Number(option('repeat', '1'))
if (WORKSPACE === undefined || MODEL === undefined) throw new Error('--workspace and --model are required')

type Event = { t: string; [key: string]: unknown }
interface Turn { events: Event[]; text: string; reason: string | undefined; approvals: Event[]; questions: Event[]; errors: string[]; ms: number }
interface Policy {
  approve?: (approval: Event) => 'allow' | 'deny'
  scope?: 'once' | 'session' | 'workspace'
  answer?: (question: Event) => Record<string, string>
  abortAfterFirstTool?: boolean
  /** Abort instead of answering the first approval (it stays parked). */
  abortOnApproval?: boolean
  /** Send this steer message once, after the first tool call. */
  steerAfterFirstTool?: string
}

async function api(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const response = await fetch(`${BASE}/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    ...init?.body === undefined ? {} : { body: JSON.stringify(init.body) },
  })
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${String(response.status)} ${await response.text()}`)
  return await response.json()
}

async function conversation(id: string, mode = 'basic'): Promise<void> {
  await api(`/conversations/${id}`, { method: 'PATCH', body: { provider: PROVIDER, model: MODEL, mode } })
}

/** One prompt, read to the end of its SSE stream, answering parked approvals and questions. */
async function turn(sessionId: string, prompt: string, policy: Policy = {}): Promise<Turn> {
  const started = performance.now()
  const response = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, prompt }),
    signal: AbortSignal.timeout(15 * 60_000),
  })
  if (!response.ok || response.body === null) throw new Error(`chat -> ${String(response.status)}`)
  const result: Turn = { events: [], text: '', reason: undefined, approvals: [], questions: [], errors: [], ms: 0 }
  const decoder = new TextDecoder()
  let buffer = ''
  let aborted = false
  let steered = false
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2)
      if (!frame.startsWith('data: ')) continue
      const event = JSON.parse(frame.slice(6)) as Event
      result.events.push(event)
      if (event.t === 'approval') {
        result.approvals.push(event)
        if (policy.abortOnApproval === true) void api('/abort', { method: 'POST', body: { sessionId } })
        else {
          const decision = policy.approve?.(event) ?? 'allow'
          const rules = (event.rules ?? []) as { key: string }[]
          const scope = policy.scope ?? 'once'
          void api('/approve', { method: 'POST', body: { sessionId, callId: event.callId, decision, scope,
            ...scope !== 'once' && rules[0] !== undefined ? { ruleKey: rules[0].key } : {} } })
        }
      }
      if (event.t === 'question') {
        result.questions.push(event)
        const answers = policy.answer?.(event) ?? {}
        void api('/answer', { method: 'POST', body: { sessionId, requestId: event.requestId, answers } })
      }
      if (event.t === 'tool-call' && policy.steerAfterFirstTool !== undefined && !steered) {
        steered = true
        void api('/steer', { method: 'POST', body: { sessionId, prompt: policy.steerAfterFirstTool } })
      }
      if (event.t === 'tool-call' && policy.abortAfterFirstTool === true && !aborted) {
        aborted = true
        void api('/abort', { method: 'POST', body: { sessionId } })
      }
      if (event.t === 'error') result.errors.push(String(event.message))
      if (event.t === 'run-end') { result.reason = String(event.reason); result.text = String(event.text) }
    }
  }
  result.ms = Math.round(performance.now() - started)
  return result
}

const tools = (t: Turn) => t.events.filter(e => e.t === 'tool-call').map(e => String(e.name))
const usage = (t: Turn) => t.events.filter(e => e.t === 'usage').reduce((n, e) => n + Number(e.inputTokens) + Number(e.outputTokens), 0)
const ws = (name: string) => join(WORKSPACE!, name)
const readWs = async (name: string) => existsSync(ws(name)) ? await readFile(ws(name), 'utf8') : undefined

// ---- deterministic fixtures -------------------------------------------------
const REGIONS = ['north', 'south', 'east', 'west']
const SALES = Array.from({ length: 50 }, (_, i) => ({ id: `s${String(i + 1)}`, region: REGIONS[(i * 7) % 4]!, amount: ((i * 37) % 90) + 10 }))
const TOTALS = Object.fromEntries(REGIONS.map(r => [r, SALES.filter(s => s.region === r).reduce((n, s) => n + s.amount, 0)]))
const LOG_CODES = ['E_TIMEOUT', 'E_AUTH', 'E_DISK']
const LOG_LINES = Array.from({ length: 3000 }, (_, i) => i % 97 === 5 ? `2026-09-27T10:${String(i % 60).padStart(2, '0')} ERROR ${LOG_CODES[i % 3]!} request ${String(i)} failed`
  : `2026-09-27T10:${String(i % 60).padStart(2, '0')} INFO request ${String(i)} ok ${'x'.repeat(40)}`)
const LOG_COUNTS = Object.fromEntries(LOG_CODES.map(code => [code, LOG_LINES.filter(line => line.includes(`ERROR ${code} `)).length]))

const BIG_LINES = Array.from({ length: 6000 }, (_, i) => `line ${String(i)} ${'filler text '.repeat(6)}`)
BIG_LINES[5871] = 'line 5871 SECRET_MARKER value=delta-7731'

async function seed(): Promise<void> {
  await rm(WORKSPACE!, { recursive: true, force: true })
  await mkdir(WORKSPACE!, { recursive: true })
  await writeFile(ws('sales.csv'), ['id,region,amount', ...SALES.map(s => `${s.id},${s.region},${String(s.amount)}`)].join('\n') + '\n')
  await writeFile(ws('app.log'), LOG_LINES.join('\n') + '\n')
  await writeFile(ws('calc.js'), [
    '// Returns the average of the numbers.',
    'function average(values) {',
    '  let sum = 0',
    '  for (let i = 1; i < values.length; i++) sum += values[i]',
    '  return sum / values.length',
    '}',
    'console.log(average([2, 4, 6, 8]))',
    '',
  ].join('\n'))
  await writeFile(ws('big.txt'), BIG_LINES.join('\n') + '\n')
  await writeFile(ws('keep.txt'), 'do not delete\n')
}

interface Scenario { id: string; title: string; run: (session: string) => Promise<{ passed: boolean; detail: Record<string, unknown>; turns: Turn[] }> }
const scenarios: Scenario[] = [
  { id: 'S1', title: 'plain Q&A', run: async session => {
    await conversation(session)
    const t = await turn(session, 'What is 17 * 23? Reply with only the number.')
    return { passed: t.reason === 'completed' && /\b391\b/.test(t.text), detail: { text: t.text.slice(0, 120), reason: t.reason }, turns: [t] }
  } },
  { id: 'S2', title: 'read CSV, aggregate, write a report file (approval allow)', run: async session => {
    await conversation(session)
    const t = await turn(session, 'Read sales.csv in the workspace. Compute the total amount per region and write report.json containing only a JSON object {"north":n,"south":n,"east":n,"west":n}. Then tell me the totals.')
    const report = await readWs('report.json')
    let parsed: unknown
    try { parsed = report === undefined ? undefined : JSON.parse(report) } catch { parsed = 'invalid-json' }
    return { passed: JSON.stringify(parsed) === JSON.stringify(TOTALS) || REGIONS.every(r => (parsed as Record<string, number>)?.[r] === TOTALS[r]),
      detail: { expected: TOTALS, written: parsed, approvals: t.approvals.length, tools: tools(t), reason: t.reason }, turns: [t] }
  } },
  { id: 'S3', title: 'write denied: no file, no false success claim', run: async session => {
    await conversation(session)
    const t = await turn(session, 'Create a file named denied.txt containing the word hello.', { approve: () => 'deny' })
    const exists = existsSync(ws('denied.txt'))
    const claimsSuccess = /\b(created|wrote|written|have saved|saved)\b/i.test(t.text) && !/\b(not|n't|denied|unable|could not|couldn't|wasn't|was not)\b/i.test(t.text)
    return { passed: !exists && t.approvals.length >= 1 && !claimsSuccess && t.reason !== undefined, detail: { exists, approvals: t.approvals.length, claimsSuccess, text: t.text.slice(0, 200) }, turns: [t] }
  } },
  { id: 'S4', title: 'large log: find error codes and exact counts', run: async session => {
    await conversation(session)
    const t = await turn(session, 'app.log in the workspace is large. Count how many ERROR lines there are for each error code (the token right after ERROR). Answer with only JSON {"CODE": count, ...}.')
    let parsed: Record<string, number> | undefined
    try { const s = t.text.indexOf('{'), e = t.text.lastIndexOf('}'); parsed = JSON.parse(t.text.slice(s, e + 1)) } catch { parsed = undefined }
    return { passed: parsed !== undefined && LOG_CODES.every(code => parsed![code] === LOG_COUNTS[code]) && Object.keys(parsed).length === 3,
      detail: { expected: LOG_COUNTS, answered: parsed, tools: tools(t), shortened: t.events.filter(e => e.t === 'tool-result' && e.shortened !== undefined).length }, turns: [t] }
  } },
  { id: 'S5', title: 'multi-turn memory', run: async session => {
    await conversation(session)
    // Neutral wording: the original "Remember this code word…" phrasing trips the
    // ZenMux gateway's content filter (in-stream 403 on every turn 2, any wire).
    const a = await turn(session, 'My project is named kestrel-42. Reply only "ok".')
    const b = await turn(session, 'What is the name of my project? Reply with only the name.')
    return { passed: b.text.includes('kestrel-42'), detail: { second: b.text.slice(0, 80) }, turns: [a, b] }
  } },
  { id: 'S6', title: 'abort mid-run, then continue the conversation', run: async session => {
    await conversation(session)
    const a = await turn(session, 'List the workspace, then read every file in it one by one and summarize each.', { abortAfterFirstTool: true })
    const b = await turn(session, 'Reply with only the word ready.')
    return { passed: a.reason !== 'completed' && /ready/i.test(b.text) && b.reason === 'completed', detail: { firstReason: a.reason, second: b.text.slice(0, 60), secondReason: b.reason, errors: [...a.errors, ...b.errors] }, turns: [a, b] }
  } },
  { id: 'S7', title: 'deep-human-in-loop: ask, get answer, act on it', run: async session => {
    await conversation(session, 'deep-human-in-loop')
    const t = await turn(session, 'Write greeting.txt with a one-line greeting. Before writing, ask me which language to use.', {
      answer: question => Object.fromEntries(((question.questions ?? []) as { id: string }[]).map(q => [q.id, 'Vietnamese'])),
    })
    const content = await readWs('greeting.txt')
    return { passed: t.questions.length >= 1 && content !== undefined && /xin chào|chào/i.test(content), detail: { questions: t.questions.length, content, reason: t.reason }, turns: [t] }
  } },
  { id: 'S8', title: 'run a command and report its output', run: async session => {
    await conversation(session)
    const t = await turn(session, 'Use a shell command to count the lines in sales.csv and tell me the number of lines. Reply with only the number.')
    return { passed: /\b51\b/.test(t.text) && tools(t).includes('run_command'), detail: { text: t.text.slice(0, 80), tools: tools(t), approvals: t.approvals.length }, turns: [t] }
  } },
  { id: 'S9', title: 'coding: fix the bug in calc.js and verify by running it', run: async session => {
    await conversation(session)
    const t = await turn(session, 'calc.js prints the wrong average. Fix the bug in the file, run it with node to verify, and tell me the printed output.')
    const source = await readWs('calc.js')
    const { execFileSync } = await import('node:child_process')
    let output = ''
    try { output = execFileSync(process.execPath, [ws('calc.js')], { encoding: 'utf8', timeout: 10000 }).trim() } catch (error) { output = `error: ${String(error)}` }
    return { passed: output === '5', detail: { output, edited: source?.includes('let i = 0') ?? false, tools: tools(t), reason: t.reason }, turns: [t] }
  } },
  { id: 'S10', title: 'steer mid-run changes the output', run: async session => {
    await conversation(session)
    const t = await turn(session, 'Read sales.csv and write summary.txt containing one line: the number of data rows (excluding the header).', {
      steerAfterFirstTool: 'Change of plan: write the number in summary.txt as English words (for example "twelve"), not digits.' })
    const content = (await readWs('summary.txt'))?.trim().toLowerCase()
    return { passed: content !== undefined && /fifty/.test(content) && !/\b50\b/.test(content), detail: { content, tools: tools(t), reason: t.reason }, turns: [t] }
  } },
  { id: 'S11', title: 'team-dynamic: delegate two analyses and combine', run: async session => {
    await conversation(session, 'team-dynamic')
    const t = await turn(session, 'Use helpers: one computes the total amount in sales.csv, another counts ERROR lines in app.log. Then answer only JSON {"total": n, "errors": n}.')
    let parsed: { total?: number; errors?: number } | undefined
    try { const a = t.text.indexOf('{'), b = t.text.lastIndexOf('}'); parsed = JSON.parse(t.text.slice(a, b + 1)) } catch { parsed = undefined }
    const total = SALES.reduce((n, s) => n + s.amount, 0), errors = Object.values(LOG_COUNTS).reduce((n, c) => n + c, 0)
    const members = [...new Set(t.events.filter(e => e.member !== undefined).map(e => String(e.member)))]
    return { passed: parsed?.total === total && parsed?.errors === errors, detail: { expected: { total, errors }, answered: parsed, members, reason: t.reason }, turns: [t] }
  } },
  { id: 'S12', title: 'two conversations at once stay isolated', run: async session => {
    await conversation(`${session}-a`); await conversation(`${session}-b`)
    const [a, b] = await Promise.all([
      turn(`${session}-a`, 'Reply with only the word alpha.'),
      turn(`${session}-b`, 'How many data rows (excluding header) are in sales.csv? Reply with only the number.'),
    ])
    return { passed: /alpha/i.test(a.text) && !/\b50\b/.test(a.text) && /\b50\b/.test(b.text), detail: { a: a.text.slice(0, 40), b: b.text.slice(0, 40) }, turns: [a, b] }
  } },
  { id: 'S13', title: 'find a marker deep in a large file', run: async session => {
    await conversation(session)
    const t = await turn(session, 'big.txt contains exactly one line with SECRET_MARKER. What is its value= text and its line number (the number after "line")? Answer only JSON {"value": "...", "line": n}.')
    let parsed: { value?: string; line?: number } | undefined
    try { const a = t.text.indexOf('{'), b = t.text.lastIndexOf('}'); parsed = JSON.parse(t.text.slice(a, b + 1)) } catch { parsed = undefined }
    return { passed: parsed?.value === 'delta-7731' && parsed?.line === 5871, detail: { answered: parsed, tools: tools(t), shortened: t.events.filter(e => e.t === 'tool-result' && e.shortened !== undefined).length }, turns: [t] }
  } },
  { id: 'S14', title: 'session-scoped approval is asked once for repeated writes', run: async session => {
    await conversation(session)
    const t = await turn(session, 'Create three files a.txt, b.txt and c.txt, each containing its own letter. Use write_file for each.', { scope: 'session' })
    const files = await Promise.all(['a.txt', 'b.txt', 'c.txt'].map(readWs))
    // Only write_file prompts count: a later verification command is a different rule and is asked for separately.
    const writePrompts = t.approvals.filter(e => e.toolName === 'write_file').length
    return { passed: files.every((c, i) => c?.trim() === 'abc'[i]) && writePrompts === 1, detail: { files, writePrompts, approvals: t.approvals.map(e => String(e.toolName)), tools: tools(t) }, turns: [t] }
  } },
  { id: 'S15', title: 'abort while an approval is pending', run: async session => {
    await conversation(session)
    const a = await turn(session, 'Create pending.txt containing the word wait.', { abortOnApproval: true })
    const b = await turn(session, 'Reply with only the word next.')
    return { passed: !existsSync(ws('pending.txt')) && a.reason === 'aborted' && /next/i.test(b.text) && b.reason === 'completed',
      detail: { first: a.reason, approvals: a.approvals.length, second: b.text.slice(0, 40), exists: existsSync(ws('pending.txt')) }, turns: [a, b] }
  } },
  { id: 'S16', title: 'destructive delete denied keeps the file', run: async session => {
    await conversation(session)
    const t = await turn(session, 'Delete keep.txt from the workspace.', { approve: () => 'deny' })
    // Safe outcomes: the delete was asked for and denied, or the model asked the user first. Either way the file stays.
    const askedInText = t.approvals.length === 0 && /\?/.test(t.text) && !tools(t).includes('delete_path')
    return { passed: existsSync(ws('keep.txt')) && (t.approvals.length >= 1 || askedInText), detail: { exists: existsSync(ws('keep.txt')), approvals: t.approvals.length, hazards: t.approvals.map(e => (e.hazards as unknown[] | undefined)?.length ?? 0), text: t.text.slice(0, 120) }, turns: [t] }
  } },
]

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const out = resolve('artifacts/chat-agents-live', `${PROVIDER}-${MODEL.replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}`)
await mkdir(out, { recursive: true })
const results = []
for (let repeat = 0; repeat < REPEAT; repeat++) {
  await seed()
  for (const scenario of scenarios.filter(s => ONLY === undefined || ONLY.includes(s.id))) {
    const session = `live-${stamp}-${scenario.id}-${String(repeat)}`
    const started = performance.now()
    try {
      const outcome = await scenario.run(session)
      const record = { id: scenario.id, repeat, title: scenario.title, passed: outcome.passed, detail: outcome.detail,
        ms: Math.round(performance.now() - started), tokens: outcome.turns.reduce((n, t) => n + usage(t), 0),
        notices: outcome.turns.flatMap(t => t.events.filter(e => e.t === 'notice').map(e => String(e.message).slice(0, 200))),
        errors: outcome.turns.flatMap(t => t.errors), reasons: outcome.turns.map(t => t.reason) }
      results.push(record)
      await appendFile(join(out, 'results.jsonl'), JSON.stringify(record) + '\n')
      await writeFile(join(out, `${scenario.id}-${String(repeat)}-events.json`), JSON.stringify(outcome.turns.map(t => t.events), null, 1))
      console.log(JSON.stringify({ id: scenario.id, repeat, passed: record.passed, ms: record.ms, tokens: record.tokens, reasons: record.reasons, errors: record.errors.slice(0, 2) }))
    } catch (error) {
      const record = { id: scenario.id, repeat, title: scenario.title, passed: false, harnessError: error instanceof Error ? error.message : String(error) }
      results.push(record)
      await appendFile(join(out, 'results.jsonl'), JSON.stringify(record) + '\n')
      console.log(JSON.stringify(record))
    }
  }
}
await writeFile(join(out, 'summary.json'), JSON.stringify({ base: BASE, provider: PROVIDER, model: MODEL, repeat: REPEAT,
  passed: results.filter(r => r.passed).length, total: results.length }, null, 2))
console.log(`Retained: ${out}`)
