import { afterAll, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ModelRegistry } from '@ai-agent-sdk/core'
import { codexNodeAdapter } from '@ai-agent-sdk/auth-node/codex'
import type { StoredNode } from '../../samples/chat-agents/backend/src/event-projection.ts'
import type { WireEvent } from '../../samples/chat-agents/backend/src/wire.ts'
import { assessLiveMatrixRun } from '../helpers/live-matrix-checks.ts'

// Explicit integration suite: real model calls, isolated app DB/workspaces.
const root = mkdtempSync(join(tmpdir(), 'chat-live-matrix-'))
process.env.CHAT_AGENTS_DB = join(root, 'app.db')
process.env.CHAT_AGENTS_WORKSPACE = join(root, 'workspace')
process.env.CHAT_AGENTS_SPILL = join(root, 'spill')
process.env.CHAT_AGENTS_MIGRATIONS = resolve('samples/chat-agents/backend/drizzle')
delete process.env.CHAT_AGENTS_MOCK_MODEL
const model = process.env.CHAT_AGENTS_LIVE_MODEL ?? 'gpt-reserve'
const repeats = Number(process.env.CHAT_AGENTS_LIVE_REPEATS ?? 2)
const finalTodoAfterSubmit = process.env.CHAT_AGENTS_LIVE_FINAL_TODO === '1'
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('live repeats must be 1..10')
const output = resolve('samples/chat-agents/.data/live-matrix', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'run-info.json'), JSON.stringify({ model, repeats, root, startedAt: new Date().toISOString() }, null, 2))
const { runPrompt, forgetSession, approve, answer, abortRun } = await import('../../samples/chat-agents/backend/src/session.ts')
const { ensureConversation, updateConversation, readMessages } = await import('../../samples/chat-agents/backend/src/conversations.ts')
const { supportedEffort } = await import('../../samples/chat-agents/backend/src/registry.ts')
const registry = new ModelRegistry()
registry.registerAdapter(['codex'], codexNodeAdapter())
const results: Record<string, unknown>[] = []
afterAll(() => writeFileSync(join(output, 'summary.json'), JSON.stringify({ model, root, results }, null, 2)))

const tasks = {
  research: 'Research the two battery source documents in this workspace. Compare normalized costs per kWh and evidence quality. State the contradictory dates and why the October 2026 statement is only a forecast. Do not browse: these are synthetic research fixtures.',
  coding: 'Fix paginate.mjs so a cursor is exclusive. Use two workers: an investigator and an implementer, with clear file ownership. Reviewer/investigator must inspect actual code. Keep test.mjs unchanged. Run node test.mjs and report its result. Final answer must mention exclusive cursor and test verification.',
  analysis: 'Reconcile sales.csv. Exclude duplicate IDs (keep first), report missing amounts separately, and convert EUR to USD at 1.2. Use two workers for independent checks. Calculate the verified total in USD and identify duplicate IDs and IDs with missing amounts from the file. Do not change the input CSV.',
} as const
const fixtures: Record<string, string> = {
  'battery-a.md': 'SYNTHETIC fixture. Observed 2026-08-31: lithium pack, USD 12000 per 100 kWh. October 2026 forecast USD 100/kWh, unverified. Vendor advertises this as a current quote but it is a forecast. Source: fixture://vendor-a/2026-08-31',
  'battery-b.md': 'SYNTHETIC fixture. Observed 2026-07-01: sodium pack USD 150 per kWh. Header incorrectly says updated 2026-09-08; observation date remains July. Source: fixture://vendor-b/2026-07-01',
  'sales.csv': 'id,amount,currency\na,100,USD\nb,200,EUR\nb,200,EUR\nc,,USD\n',
  'paginate.mjs': 'export function paginate(items, cursor, limit) { return items.filter(x => x.id >= cursor).slice(0, limit) }\n',
  'test.mjs': "import assert from 'node:assert/strict'; import {paginate} from './paginate.mjs'; const data=[{id:1},{id:2},{id:3}]; assert.deepEqual(paginate(data,1,2),[{id:2},{id:3}]); assert.deepEqual(paginate(data,3,2),[]); assert.deepEqual(paginate(data,0,0),[]); console.log('PASS exclusive cursor');\n",
}
const matrix = Object.keys(tasks).flatMap(topic => ['medium', 'high', 'max'].flatMap(effort =>
  Array.from({ length: repeats }, (_, index) => ({ topic: topic as keyof typeof tasks, effort, repeat: index + 1 }))))

describe('chat-agents live matrix', () => {
  it('catalogue exposes the exact model and efforts', async () => {
    const info = await registry.resolveModelInfo('codex', model)
    const offered = info.reasoning?.efforts.map(e => String(e.id)) ?? []
    const record = { model, offered, output }
    console.log(JSON.stringify(record))
    writeFileSync(join(output, 'catalogue.json'), JSON.stringify(record, null, 2))
    expect(offered).toEqual(expect.arrayContaining(['medium', 'high', 'max']))
  })

  it.each(matrix)('$topic / $effort / repeat $repeat', async ({ topic, effort, repeat }) => {
    const id = `${topic}-${effort}-${repeat}`
    const workspace = join(root, id)
    mkdirSync(workspace, { recursive: true })
    for (const [name, body] of Object.entries(fixtures)) {
      if (topic === 'research' ? name.startsWith('battery-') : topic === 'coding' ? name.endsWith('.mjs') : name === 'sales.csv') {
        writeFileSync(join(workspace, name), body)
      }
    }
    // A silent effort downgrade is a failure, not a test of the requested level.
    expect(await supportedEffort(registry, { provider: 'codex', model }, effort)).toBe(effort)
    await ensureConversation(id, { mode: 'team-dynamic', workspaceRoot: workspace, groupId: 'default' })
    await updateConversation(id, { provider: 'codex', model, reasoningEffort: effort, mode: 'team-dynamic' })
    const start = Date.now()
    const events: WireEvent[] = []
    const prompt = tasks[topic] + '\nUse Team-auto with exactly two workers and return a final lead synthesis. Publish and reconcile todos. Stay within this disposable workspace. Do not install packages or use network.'
      + (topic === 'coding' ? ' The only permitted shell command is node test.mjs.' : ' Do not run shell commands; use the supplied read tools.')
      + ' Keep the final answer under 250 words. Proceed without clarification.'
      + (finalTodoAfterSubmit ? ' Regression sequence: after your submit_result is accepted, call write_todos to mark the plan complete, then immediately write the final answer. Do not resubmit merely because you updated the plan.' : '')
    // A whole team run can legitimately exceed the per-model stream deadline.
    const deadlineMs = effort === 'max' ? 900_000 : 600_000
    let deadlineReached = false
    const timer = setTimeout(() => { deadlineReached = true; void abortRun(id) }, deadlineMs)
    let failure: unknown
    try {
      for await (const event of runPrompt(id, prompt, 'default')) {
        // Never persist reasoning deltas or authentication data.
        if (event.t !== 'reasoning-delta') events.push(event)
        if (event.t === 'tool-call' || event.t === 'tool-result' || event.t === 'member-start' || event.t === 'member-end' || event.t === 'run-end' || event.t === 'error') {
          appendFileSync(join(output, 'progress.jsonl'), JSON.stringify({ id, elapsedMs: Date.now() - start,
            event: event.t, ...'name' in event ? { name: event.name } : {},
            ...'member' in event ? { member: event.member } : {},
          }) + '\n')
        }
        if (event.t === 'approval') {
          const tool = events.find((e): e is Extract<WireEvent, { t: 'tool-call' }> => e.t === 'tool-call' && e.id === event.callId)
          const args = typeof tool?.args === 'string' ? JSON.parse(tool.args) as Record<string, unknown> : {}
          const allowed = topic === 'coding' && ((tool?.name === 'edit_file' || tool?.name === 'write_file') && args.path === 'paginate.mjs'
            || tool?.name === 'run_command' && args.command === 'node test.mjs')
          await approve(id, event.callId, allowed ? 'allow' : 'deny', 'once')
        }
        if (event.t === 'question') {
          await answer(id, event.requestId, Object.fromEntries(event.questions.map(q => [q.id, 'Use the supplied fixtures and stated assumptions. Proceed.'])))
        }
      }
      const nodes = await readMessages(id) as readonly StoredNode[]
      const texts = nodes.filter((n): n is Extract<StoredNode, { kind: 'text' }> => n.kind === 'text')
      const final = texts.at(-1)
      const workers = [...new Set(texts.flatMap(n => n.member ? [n.member] : []))]
      const checks = { ...assessLiveMatrixRun(topic, nodes, events), fixturePassed: true }
      if (finalTodoAfterSubmit) {
        const submissions = new Set(events.filter((e): e is Extract<WireEvent, { t: 'tool-call' }> =>
          e.t === 'tool-call' && e.name === 'submit_result' && e.member === undefined).map(e => e.id))
        const acceptedAt = events.findIndex(e => e.t === 'tool-result' && e.ok && submissions.has(e.id))
        expect(acceptedAt).toBeGreaterThanOrEqual(0)
        expect(events.some((e, index) => index > acceptedAt && e.t === 'tool-call'
          && e.name === 'write_todos' && e.member === undefined)).toBe(true)
      }
      if (topic === 'coding') {
        checks.fixturePassed = readFileSync(join(workspace, 'test.mjs'), 'utf8') === fixtures['test.mjs']
        try { execFileSync(process.execPath, ['test.mjs'], { cwd: workspace, timeout: 10_000, stdio: 'pipe' }) }
        catch { checks.fixturePassed = false }
      }
      const record = { id, model, effort, finalTodoAfterSubmit, durationMs: Date.now() - start, deadlineReached, checks, workers, final: final?.text, events }
      results.push({ id, durationMs: record.durationMs, checks })
      writeFileSync(join(output, `${id}.json`), JSON.stringify(record, null, 2))
      console.log(JSON.stringify({ id, durationMs: record.durationMs, checks }))
      expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map(k => [k, true])))
      expect(deadlineReached).toBe(false)
    } catch (error) {
      failure = error
      if (!results.some(row => row.id === id)) results.push({ id, durationMs: Date.now() - start, failed: true, message: String(error) })
      writeFileSync(join(output, `${id}-failure.json`), JSON.stringify({ id, durationMs: Date.now() - start, message: String(error), events }, null, 2))
      throw error
    } finally {
      clearTimeout(timer)
      if (failure !== undefined) await abortRun(id)
      forgetSession(id)
      writeFileSync(join(output, 'summary.json'), JSON.stringify({ model, root, results }, null, 2))
    }
  }, 930_000)
})
