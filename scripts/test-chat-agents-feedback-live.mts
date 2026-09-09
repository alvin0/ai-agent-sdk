import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WireEvent } from '../samples/chat-agents/backend/src/wire.ts'

// Requires a separately started, rebuilt sample server with a disposable DB/workspace.
const base = process.env.CHAT_AGENTS_FEEDBACK_URL
const workspace = process.env.CHAT_AGENTS_FEEDBACK_WORKSPACE
if (!base || !workspace) throw new Error('Set CHAT_AGENTS_FEEDBACK_URL and CHAT_AGENTS_FEEDBACK_WORKSPACE to the isolated live sample')
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Live regression server must be local')
const model = process.env.CHAT_AGENTS_LIVE_MODEL ?? 'gpt-5.6-sol'
const report: unknown[] = []
async function api(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${base}/api/${path}`, body === undefined ? {} : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  assert.equal(response.ok, true, `${path}: ${response.status}`)
  return await response.json() as Record<string, unknown>
}
assert.equal((await api('workspace')).root, resolve(workspace))
for (const decision of ['allow', 'deny', 'abort'] as const) {
  const id = `feedback-${decision}-${crypto.randomUUID()}`
  const filename = `${id}.txt`, expected = `FEEDBACK_${decision.toUpperCase()}\n`
  await api(`conversations/${id}`, { provider: 'codex', model, mode: 'basic', reasoningEffort: 'medium', workspaceRoot: resolve(workspace) }, 'PATCH')
  const events: WireEvent[] = []
  let approvalId: string | undefined
  const signal = AbortSignal.timeout(180_000)
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ sessionId: id, prompt: `Use write_file to create ${filename} with exactly ${JSON.stringify(expected)}. Request permission normally. If denied, stop and report denial without retrying. If allowed, read the file back and report its content. Do not modify any other file or run commands.` }),
  })
  assert.equal(response.ok, true)
  let buffer = ''
  const decoder = new TextDecoder()
  try {
    for await (const bytes of response.body!) {
      buffer += decoder.decode(bytes, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        if (!frame.startsWith('data: ')) continue
        const event = JSON.parse(frame.slice(6)) as WireEvent
        if (event.t !== 'reasoning-delta') events.push(event)
        if (event.t !== 'approval') continue
        assert.equal(approvalId, undefined, 'one approval per scenario')
        approvalId = event.callId
        assert.notEqual(approvalId, event.providerCallId)
        assert.equal(existsSync(resolve(workspace, filename)), false)
        const call = events.find((item): item is Extract<WireEvent, { t: 'tool-call' }> => item.t === 'tool-call' && item.id === event.providerCallId)
        assert.equal(call?.name, 'write_file')
        const args = JSON.parse(call!.args)
        assert.equal(args.path, filename)
        assert.equal(args.content, expected)
        assert.equal((await api('approve', { sessionId: id, callId: event.providerCallId, decision: 'allow', scope: 'once' })).resolved, false)
        if (decision === 'abort') assert.equal((await api('abort', { sessionId: id })).aborted, true)
        else assert.equal((await api('approve', { sessionId: id, callId: approvalId, decision, scope: 'once' })).resolved, true)
        assert.equal((await api('approve', { sessionId: id, callId: approvalId, decision: 'allow', scope: 'once' })).resolved, false)
      }
    }
    assert.ok(approvalId)
    if (decision !== 'abort') assert.ok(events.some(event => event.t === 'run-end'))
    if (decision !== 'abort') assert.equal(events.some(event => event.t === 'error'), false)
    if (decision === 'allow') assert.equal(readFileSync(resolve(workspace, filename), 'utf8'), expected)
    else assert.equal(existsSync(resolve(workspace, filename)), false)
    const persisted = await api(`conversations/${id}`)
    assert.ok(Array.isArray(persisted.pendingApprovals))
    assert.equal(persisted.pendingApprovals.length, 0)
    assert.ok(Array.isArray(persisted.messages) && persisted.messages.length > 0)
    if (decision === 'abort') {
      const resumed = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120_000), body: JSON.stringify({ sessionId: id, prompt: 'The previous write is cancelled. Do not write files or call tools. Reply exactly RECOVERED.' }) })
      const transcript = await resumed.text()
      assert.ok(transcript.includes('"t":"run-end"'))
      assert.ok(transcript.includes('RECOVERED'))
      assert.equal(transcript.includes('"t":"error"'), false)
      assert.equal(existsSync(resolve(workspace, filename)), false)
    }
    report.push({ decision, id, model, approvalId, passed: true, events })
    console.log(JSON.stringify({ decision, model, passed: true }))
  } finally { await api('abort', { sessionId: id }) }
}
const output = process.env.CHAT_AGENTS_FEEDBACK_REPORT
if (output) writeFileSync(output, JSON.stringify(report, null, 2))
