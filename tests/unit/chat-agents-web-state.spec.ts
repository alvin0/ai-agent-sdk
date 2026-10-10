import { describe, expect, it } from 'vitest'
import { reduce, reduceMembers, reduceSpans } from '../../samples/chat-agents/web/src/ui/chat/controller/reducers'
import { createRun, reportRunError } from '../../samples/chat-agents/web/src/ui/chat/controller/live-run'
import { readStream } from '../../samples/chat-agents/web/src/ui/chat/controller/stream'
import type { WireEvent } from '../../samples/chat-agents/backend/src/wire'
import type { ChatState } from '../../samples/chat-agents/web/src/ui/chat/types'

const empty: ChatState = {
  nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 },
  progress: null, members: [], spans: [], runId: '',
}
const approval: WireEvent = {
  t: 'approval', callId: 'permission', toolName: 'command', title: 'Run', summary: 'Build', rules: [],
}

describe('chat browser transcript state', () => {
  it('keeps the last known text phase and final replacement, including incomplete output', () => {
    let nodes = reduce([], { t: 'text-delta', id: 'text', text: 'A', phase: 'final-answer', member: 'worker' })
    nodes = reduce(nodes, { t: 'text-delta', id: 'text', text: 'B', phase: 'unknown' })
    expect(nodes[0]).toMatchObject({ text: 'AB', phase: 'final-answer', streaming: true, member: 'worker' })
    nodes = reduce(nodes, { t: 'text-end', id: 'text', text: 'final', incomplete: true })
    expect(nodes[0]).toMatchObject({ text: 'final', phase: 'final-answer', streaming: false, incomplete: true })
    expect(reduce([], { t: 'text-end', id: 'absent' })).toEqual([])
  })

  it('caps live output and distinguishes declined calls from failed calls', () => {
    let nodes = reduce([], { t: 'tool-call', id: 'tool', name: 'command', args: '{}' })
    nodes = reduce(nodes, { t: 'tool-output', id: 'tool', chunk: 'x'.repeat(20_000) + 'tail' })
    expect(nodes[0]).toMatchObject({ liveOutput: 'x'.repeat(19_996) + 'tail', state: 'running' })
    nodes = reduce(nodes, { t: 'tool-result', id: 'tool', ok: true, declined: true, output: 'denied' })
    expect(nodes[0]).toMatchObject({ state: 'declined', output: 'denied' })
    nodes = reduce(nodes, { t: 'tool-result', id: 'tool', ok: false, output: '', errorMessage: 'failed' })
    expect(nodes[0]).toMatchObject({ state: 'error', errorMessage: 'failed' })
  })

  it('refreshes a parked approval and settles questions without duplicating cards', () => {
    let nodes = reduce([], approval)
    nodes = reduce(nodes, { t: 'approval-resolved', callId: 'permission', decision: 'allow', scope: 'once' })
    expect(nodes[0]).toMatchObject({ decision: 'allow' })
    nodes = reduce(nodes, approval)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).not.toHaveProperty('decision')
    nodes = reduce(nodes, { t: 'question', requestId: 'question', questions: [] })
    nodes = reduce(nodes, { t: 'question-answered', requestId: 'question' })
    expect(nodes[1]).toMatchObject({ answered: true })
  })

  it('retains unknown-event identity and resets the team roster and spans at run start', () => {
    const nodes = reduce([], approval)
    expect(reduce(nodes, { t: 'progress', message: 'waiting' })).toBe(nodes)
    const members = reduceMembers([], { t: 'tool-call', id: 'tool', name: 'command', args: '{}', member: 'worker' })
    expect(members).toEqual([{ name: 'worker', status: 'running', toolCalls: 1 }])
    const start: WireEvent = { t: 'run-start', runId: 'run', members: ['lead'] }
    expect(reduceMembers(members, start)).toEqual([{ name: 'lead', status: 'idle', toolCalls: 0 }])
    expect(reduceSpans([], start)).toEqual([])
  })

  it('decodes UTF-8 and multiple SSE frames across arbitrary chunk boundaries', async () => {
    const run = createRun({ state: empty, prompt: 'hi', attachments: [], skillIds: [] })
    const events: WireEvent[] = [
      { t: 'run-start', runId: 'run', members: ['lead'] },
      { t: 'text-delta', id: 'text', text: 'Xin chào 👋', phase: 'final-answer' },
      { t: 'usage', inputTokens: 3, outputTokens: 2 },
      { t: 'usage', inputTokens: 4, outputTokens: 1 },
      { t: 'progress', message: 'waiting' },
      { t: 'text-end', id: 'text' },
    ]
    const frames = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
    const data = new TextEncoder().encode(': heartbeat\n\n' + frames)
    const body = new ReadableStream({ start(controller) {
      for (const byte of data) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } })
    let repaints = 0
    await readStream(body, run, () => { repaints++ })
    expect(repaints).toBe(events.length)
    expect(run.nodes[1]).toMatchObject({ text: 'Xin chào 👋', streaming: false })
    expect(run).toMatchObject({ runId: 'run', usage: { inputTokens: 7, outputTokens: 3 }, progress: 'waiting' })
  })

  it('surfaces malformed frames and suppresses intentional cancellation errors', async () => {
    const run = createRun({ state: empty, prompt: 'hi', attachments: [], skillIds: [] })
    const body = new Response('data: {bad}\n\n').body!
    await expect(readStream(body, run, () => {})).rejects.toThrow()
    let repaints = 0
    reportRunError(run, new DOMException('stopped', 'AbortError'), () => { repaints++ })
    expect(run.nodes).toHaveLength(1)
    reportRunError(run, new Error('broken'), () => { repaints++ })
    expect(run.nodes[1]).toMatchObject({ kind: 'error', message: 'broken' })
    expect(repaints).toBe(1)
  })
})
