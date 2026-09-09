import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'
import type { WireSpan } from '../../samples/chat-agents/backend/src/wire.ts'

const home = mkdtempSync(join(tmpdir(), 'traces-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_SPILL = join(home, '.data', 'spill')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')
process.env.CHAT_AGENTS_MOCK_MODEL = '1'

const { runPrompt } = await import('../../samples/chat-agents/backend/src/session.ts')
const { ensureConversation, updateConversation } =
  await import('../../samples/chat-agents/backend/src/conversations.ts')
const { listTraces, readTrace } = await import('../../samples/chat-agents/backend/src/traces.ts')
const { createChatApp } = await import('../../samples/chat-agents/backend/src/app.ts')
const app = createChatApp('/api')

const { setMockScript, setMockContextWindow, resetMock } =
  await import('../../samples/chat-agents/backend/src/mock-provider.ts')

/**
 * The trace is what the run actually did, not what it said.
 *
 * The transcript already covers the answer. These tests cover the other
 * question — which step called which, and where the time went — because that is
 * the only record of a run's shape, and the shape is what a slow or looping run
 * is diagnosed from.
 */

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body, phase: 'final-answer' } },
  { type: 'usage', usage: { inputTokens: 40, outputTokens: 10 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const toolCall = (id: string, name: string, args: unknown): StreamChunk[] => [
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

let conversations = 0

async function conversation(): Promise<string> {
  conversations++
  const id = `c_trace_${String(conversations)}`
  await ensureConversation(id, {
    mode: 'basic',
    workspaceRoot: process.env.CHAT_AGENTS_WORKSPACE as string,
    groupId: 'default',
  })
  await updateConversation(id, { provider: 'mock', model: 'mock-scripted', mode: 'basic' })
  return id
}

interface Wire { readonly t: string; readonly runId?: string; readonly span?: WireSpan }

async function prompt(id: string, message: string): Promise<Wire[]> {
  const wires: Wire[] = []
  for await (const event of runPrompt(id, message, 'default')) wires.push(event as Wire)
  return wires
}

afterEach(() => { resetMock() })

describe('a run leaves a trace', () => {
  it('streams a span for every step and stores it under the run', async () => {
    const id = await conversation()
    setMockScript(() => text('answered'))

    const wires = await prompt(id, 'trace me')
    const runId = wires.find(wire => wire.t === 'run-start')?.runId
    expect(runId).toBeDefined()

    const streamed = wires
      .filter((wire): wire is Wire & { span: WireSpan } => wire.t === 'span')
      .map(wire => wire.span)
    // The run's own span plus the model round it made, each reported twice —
    // once on open, once with its duration.
    expect(streamed.length).toBeGreaterThanOrEqual(4)
    // Plus the harness's own preparation, which is not a step the loop took.
    expect(new Set(streamed.map(span => span.kind))).toEqual(new Set(['invoke_agent', 'context', 'chat']))

    const stored = await readTrace(runId as string)
    const root = stored.find(span => span.parentSpanId === null)
    expect(root?.kind).toBe('invoke_agent')
    expect(root?.status).toBe('success')
    expect(root?.durationMs).not.toBeNull()
    // The prompt is the root's input: the SDK's own span carries the agent and
    // its model, so without this the trace could not say what was asked.
    expect(root?.input).toBe('trace me')

    const round = stored.find(span => span.kind === 'chat')
    expect(round?.parentSpanId).toBe(root?.spanId)
    expect(round?.usage?.inputTokens).toBe(40)
    // What the model was SENT, which is the other half of explaining a round:
    // the tail of the conversation, the tools on offer, and how much context
    // was omitted from the preview.
    const request = round?.input as {
      messageCount?: number
      tools?: readonly string[]
      messages?: readonly { role?: string; text?: string }[]
    }
    expect(request.messageCount).toBeGreaterThan(0)
    expect(request.messages?.at(-1)).toMatchObject({ role: 'user', text: 'trace me' })
    expect(request.tools).toContain('read_file')

    const [summary] = await listTraces(id)
    expect(summary?.runId).toBe(runId)
    expect(summary?.status).toBe('success')
    expect(summary?.spans).toBe(stored.length)
    // A folded run is one line, and the prompt is what makes that line
    // recognisable an hour later — an id and a timestamp are not.
    expect(summary?.prompt).toBe('trace me')
    // One agent, so there is nobody to colour: the roster is empty rather than
    // naming the agent the user talks to.
    expect(summary?.members).toEqual([])
    // The run total, summed from the model rounds: a folded run says what it
    // cost without being opened, and fresh input is kept apart from cache.
    expect(summary?.usage).toEqual({ inputTokens: 40, cacheReadTokens: 0, outputTokens: 10 })
  }, 20_000)

  it('records a tool call beside its model round, with the arguments it was given', async () => {
    const id = await conversation()
    setMockScript((_request, index) => index === 0
      ? toolCall('call_1', 'write_todos', { todos: [{ title: 'look', status: 'pending' }] })
      : text('done'))

    const wires = await prompt(id, 'use a tool')
    const runId = wires.find(wire => wire.t === 'run-start')?.runId as string
    const stored = await readTrace(runId)

    const tool = stored.find(span => span.kind === 'execute_tool')
    expect(tool?.name).toBe('execute_tool write_todos')
    // The arguments only ever appear on the `tool-call` event, so a trace that
    // did not fold them in would show a tool call with no input at all.
    expect(JSON.stringify(tool?.input)).toContain('look')
    expect(tool?.attributes?.['gen_ai.tool.name']).toBe('write_todos')

    // The loop hangs tool calls off the TURN, beside the model round that
    // asked for them rather than inside it, because a call outlives the round
    // that requested it. The stored parent is the turn; the tree re-parents
    // them onto the round for display, which is a decision the view owns.
    const parent = stored.find(span => span.spanId === tool?.parentSpanId)
    expect(parent?.kind).toBe('invoke_agent')
    expect(parent?.parentSpanId).toBeNull()
  }, 20_000)

  it('keeps each run of a conversation separate, newest first', async () => {
    const id = await conversation()
    setMockScript(() => text('first'))
    const first = await prompt(id, 'one')
    setMockScript(() => text('second'))
    const second = await prompt(id, 'two')

    const firstRun = first.find(wire => wire.t === 'run-start')?.runId as string
    const secondRun = second.find(wire => wire.t === 'run-start')?.runId as string
    const traces = await listTraces(id)
    expect(traces.map(trace => trace.runId).slice(0, 2)).toEqual([secondRun, firstRun])
    // Two runs, two traces: reading one must not hand back the other's spans.
    const spans = await readTrace(firstRun)
    expect(spans.every(span => span.runId === firstRun)).toBe(true)
  }, 30_000)

  it('records the provider call each round made, matched to that round', async () => {
    // The step row carries a capped SUMMARY of the request. This is the whole
    // payload and the whole streamed answer, which is the only place a reader
    // can check what the model was actually sent.
    const id = await conversation()
    setMockScript((_request, index) => index === 0
      ? toolCall('call_api', 'list_directory', { path: '.' })
      : text('answered from the payload'))

    const wires = await prompt(id, 'show me the payload')
    const runId = wires.find(wire => wire.t === 'run-start')?.runId as string
    const stored = await readTrace(runId)
    const rounds = stored.filter(span => span.kind === 'chat')
    expect(rounds.length).toBe(2)

    // Each round gets its OWN call: matched on the request identity the loop
    // recorded, not on whichever recording happened to finish first.
    const first = rounds[0]?.apiCall
    const second = rounds[1]?.apiCall
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first?.provider).toBe('mock')
    expect(first?.model).toBe('mock-scripted')
    // The first round asked for a tool and the second answered, so the
    // recordings must not be the same call twice.
    expect(first?.response.toolCalls?.[0]?.name).toBe('list_directory')
    expect(second?.response.text).toContain('answered from the payload')
    expect(second?.response.usage?.inputTokens).toBe(40)
    expect(second?.response.finishReason).toBe('stop')

    // The payload itself: the prompt is in the messages, and the tools that
    // were on offer are named.
    expect(JSON.stringify(first?.messages)).toContain('show me the payload')
    expect(first?.params.tools).toContain('read_file')
    // The second round was sent MORE than the first: the tool call and its
    // result joined the conversation in between.
    expect((second?.messages.length ?? 0)).toBeGreaterThan(first?.messages.length ?? 0)
  }, 20_000)

  it('records what the harness prepared: instruction files and the skill catalogue', async () => {
    // Neither is a step the loop takes — the instructions arrive as a context
    // section it rewrites silently, the catalogue as a tool schema — so without
    // these rows a run that read no conventions file looks exactly like one
    // that read three.
    // Its own project directory: an AGENTS.md dropped in the shared workspace
    // would join every other test's prompt, and one of them measures how much
    // room compaction has left.
    const root = mkdtempSync(join(home, 'project-'))
    writeFileSync(join(root, 'AGENTS.md'), '# House rules\nUse tabs.\n', 'utf8')
    const id = 'c_trace_instructions'
    await ensureConversation(id, { mode: 'basic', workspaceRoot: root, groupId: 'default' })
    await updateConversation(id, { provider: 'mock', model: 'mock-scripted', mode: 'basic' })
    setMockScript(() => text('read the rules'))

    const wires = await prompt(id, 'anything')
    const runId = wires.find(wire => wire.t === 'run-start')?.runId as string
    const stored = await readTrace(runId)

    const instructions = stored.find(span => span.name === 'context instructions')
    expect(instructions?.kind).toBe('context')
    // Hung under the run, not beside it: this is preparation FOR the turn.
    expect(instructions?.parentSpanId).toBe(stored.find(span => span.parentSpanId === null)?.spanId)
    expect(instructions?.attributes?.['agent.instructions.files']).toBe(1)
    expect(JSON.stringify(instructions?.output)).toContain('AGENTS.md')
    // The candidates are reported too, so "no file found" can say what it
    // looked for — CLAUDE.md is deliberately not among them.
    expect(instructions?.attributes?.['agent.instructions.candidates']).toContain('AGENTS.md')

    const skills = stored.find(span => span.name === 'context skills')
    expect(skills?.kind).toBe('context')
    expect(typeof skills?.attributes?.['agent.skills.discovered']).toBe('number')
  }, 20_000)

  it('records a compaction as a step of its own, with what it shortened', async () => {
    // Compaction is maintenance, not conversation: it produces no assistant
    // text, so the transcript cannot show it and a chat that suddenly forgot
    // its own history has no explanation anywhere. The trace is where it is
    // visible — as a `compact` span under the turn that triggered it.
    const id = await conversation()
    setMockContextWindow(4_000)
    const long = 'x'.repeat(6_000)
    setMockScript(() => text(long))

    let compact: WireSpan | undefined
    for (let turn = 0; turn < 6 && compact === undefined; turn++) {
      const wires = await prompt(id, `question ${String(turn)} ${long}`)
      const runId = wires.find(wire => wire.t === 'run-start')?.runId as string
      compact = (await readTrace(runId)).find(span => span.kind === 'compact')
    }

    expect(compact).toBeDefined()
    expect(compact?.name.startsWith('compact ')).toBe(true)
    expect(compact?.status).toBe('success')
    // What it did, in the numbers a reader needs: which history entries were
    // shadowed, and the estimate either side of the work.
    const output = compact?.output as { shadowedSeqs?: unknown; estimatedTokensAfter?: number }
    expect(Array.isArray(output.shadowedSeqs)).toBe(true)
    expect(typeof output.estimatedTokensAfter).toBe('number')
    expect(compact?.attributes?.['gen_ai.compaction.trigger']).toBeDefined()
  }, 90_000)

  it('serves the list and one run over HTTP, which is how the view reads them', async () => {
    const id = await conversation()
    setMockScript(() => text('served'))
    const wires = await prompt(id, 'over http')
    const runId = wires.find(wire => wire.t === 'run-start')?.runId as string

    const listed = await (await app.fetch(
      new Request(`http://local/api/conversations/${id}/traces`),
    )).json() as { traces: readonly { runId: string; spans: number }[] }
    expect(listed.traces[0]?.runId).toBe(runId)

    const one = await (await app.fetch(
      new Request(`http://local/api/traces/${runId}`),
    )).json() as { spans: readonly WireSpan[] }
    expect(one.spans.length).toBe(listed.traces[0]?.spans)
    expect(one.spans.some(span => span.parentSpanId === null)).toBe(true)
  }, 20_000)
})
