import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { StreamChunk } from '@alvin0/ai-agent-sdk-core'

const home = mkdtempSync(join(tmpdir(), 'run-prompt-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_SPILL = join(home, '.data', 'spill')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')
// Answers from a script instead of a model, which is the only way to drive the
// app's own request path end to end.
process.env.CHAT_AGENTS_MOCK_MODEL = '1'

const { runPrompt, forgetSession, abortRun } =
  await import('../../samples/chat-agents/backend/src/session.ts')
const { updateConversation, readMessages, ensureConversation } =
  await import('../../samples/chat-agents/backend/src/conversations.ts')
const { usageSummary } = await import('../../samples/chat-agents/backend/src/usage.ts')
const { setMockScript, setMockContextWindow, resetMock, mockRequests } =
  await import('../../samples/chat-agents/backend/src/mock-provider.ts')
const { steer, approve, pendingApprovals, pendingQuestions, answer } =
  await import('../../samples/chat-agents/backend/src/session.ts')
const { readFileSync, existsSync } = await import('node:fs')

/**
 * The app's own entry point, not a reconstruction of it.
 *
 * `runPrompt` is what the POST handler calls: it resolves the model, builds the
 * approval gate, runs the loop, projects the wire, writes the transcript, and
 * follows the workers. Everything tested elsewhere in pieces meets here, and
 * the things that only go wrong when they meet — a second prompt arriving mid
 * run, a cancel, a transcript that has to survive both — are only visible here.
 */

const text = (body: string): StreamChunk[] => [
  { type: 'text-delta', index: 0, text: body },
  { type: 'block-end', index: 0, block: { type: 'text', text: body, phase: 'final-answer' } },
  { type: 'usage', usage: { inputTokens: 40, outputTokens: 10 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const call = (id: string, name: string, args: unknown): StreamChunk[] => [
  {
    type: 'block-end', index: 0,
    block: { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

let conversations = 0

/** A conversation wired to the offline provider. */
async function conversation(): Promise<string> {
  conversations++
  const id = `c_run_${String(conversations)}`
  await ensureConversation(id, { mode: 'basic', workspaceRoot: process.env.CHAT_AGENTS_WORKSPACE as string, groupId: 'default' })
  await updateConversation(id, { provider: 'mock', model: 'mock-scripted', mode: 'basic' })
  return id
}

interface Wire { readonly t: string; readonly text?: string; readonly message?: string }

/** Drain one prompt into the wire events a browser would receive. */
async function prompt(id: string, message: string): Promise<Wire[]> {
  const wires: Wire[] = []
  for await (const event of runPrompt(id, message, 'default')) wires.push(event as Wire)
  return wires
}

afterEach(() => { resetMock() })

describe('runPrompt end to end', () => {
  it('rejects steering if the run ends while conversation metadata is loading', async () => {
    const id = await conversation()
    setMockScript(() => text('done'))
    const stream = runPrompt(id, 'hello', 'default')
    while ((await stream.next()).value?.t !== 'run-start') { /* start */ }
    const module = await import('../../samples/chat-agents/backend/src/conversations.ts')
    const saved = await module.getConversation(id)
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const spy = vi.spyOn(module, 'getConversation').mockImplementationOnce(async () => {
      entered()
      await held
      return saved
    })
    try {
      const pending = steer(id, 'a correction arriving too late')
      await reading
      await stream.return(undefined)
      release()
      await expect(pending).resolves.toBe(false)
    } finally {
      release()
      spy.mockRestore()
      await stream.return(undefined)
    }
  })

  it('releases a run when the client disconnects immediately after run-start', async () => {
    const id = await conversation()
    setMockScript(() => text('done'))
    const stream = runPrompt(id, 'hello', 'default')
    while ((await stream.next()).value?.t !== 'run-start') { /* start */ }
    await stream.return(undefined)
    expect(await abortRun(id)).toBe(false)
  })

  it.each([false, true])('keeps replacement steering after late close (cancel first: %s)', async (cancelFirst) => {
    const id = await conversation()
    setMockScript(request => [
      { type: 'text-delta', index: 0, text: 'working' },
      { type: 'hang', signal: request.signal, ms: 200 } as unknown as StreamChunk,
      ...text('done'),
    ])
    const first = runPrompt(id, 'first', 'default')
    const second = runPrompt(id, 'second', 'default')
    try {
      while ((await first.next()).value?.t !== 'run-start') { /* start */ }
      await first.next() // Suspend inside the try/finally, emulating a slow SSE reader.
      if (cancelFirst) expect(await abortRun(id)).toBe(true)
      while ((await second.next()).value?.t !== 'run-start') { /* replace */ }
      expect(await steer(id, 'retain this correction')).toBe(true)
      await first.return(undefined)
      expect(await steer(id, 'retain this second correction')).toBe(true)
      for await (const _event of second) { /* drain */ }
      expect(JSON.stringify(await readMessages(id))).toContain('retain this correction')
    } finally {
      await first.return(undefined)
      await second.return(undefined)
    }
  }, 30_000)

  it('answers, streams, and writes a transcript that reloads', async () => {
    const id = await conversation()
    setMockScript(() => text('the offline answer'))

    const wires = await prompt(id, 'hello')

    expect(wires.some(wire => wire.t === 'run-end')).toBe(true)
    const stored = await readMessages(id)
    // The prompt and the answer, in that order, ready for a page reload.
    expect(stored.map(node => (node as { kind: string }).kind)).toEqual(['user', 'text'])
    expect(JSON.stringify(stored.at(-1))).toContain('the offline answer')
  }, 20_000)

  it('does not let a second prompt run alongside the first', async () => {
    // Two tabs, or an impatient second send. Both runs share one conversation
    // history and one transcript counter, so running them together interleaves
    // two dialogues into one and neither is readable afterwards.
    const id = await conversation()
    let firstStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => { release = resolve })

    setMockScript((_request, index) => {
      if (index === 0) {
        firstStarted?.()
        return [
          { type: 'text-delta', index: 0, text: 'slow' },
          { type: 'block-end', index: 0, block: { type: 'text', text: 'slow', phase: 'final-answer' } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
      }
      return text(`answer ${String(index)}`)
    })

    const first = prompt(id, 'first prompt')
    await started
    void held
    release?.()
    const second = await prompt(id, 'second prompt')
    const firstWires = await first

    // The first run is ended by the second rather than left running beside it,
    // and it is reported as a takeover, not as a failure of the user's own doing.
    const takeover = firstWires.find(wire => wire.t === 'notice')
    expect(JSON.stringify(takeover)).toContain('took the conversation over')
    expect(firstWires.some(wire => wire.t === 'error')).toBe(false)
    // Still a TERMINAL stream. `runPrompt` promises every run ends with
    // `run-end` or `error`; a displaced one that stopped on the notice left a
    // reader waiting for an end frame that never came.
    expect(firstWires.at(-1)?.t).toBe('run-end')
    // The other half of a takeover — that the displaced run's late answer is
    // not filed UNDERNEATH the answer that replaced it — is guarded in
    // `tests/integration/chat-agents-sample-live.spec.ts`. It needs the
    // displaced run to still be unwinding after the newer one has written, and
    // a scripted adapter finishes far too promptly for that to happen here.
    expect(second.some(wire => wire.t === 'run-end')).toBe(true)
    const stored = await readMessages(id)
    const kinds = stored.map(node => (node as { kind: string }).kind)
    expect(kinds.filter(kind => kind === 'user')).toHaveLength(2)
    // Every user message is followed by an answer, not by another user message.
    for (let index = 0; index < kinds.length - 1; index++) {
      if (kinds[index] === 'user') expect(kinds[index + 1]).not.toBe('user')
    }
  }, 30_000)

  it('records a cancelled run as cancelled and keeps what it had', async () => {
    const id = await conversation()
    let inFlight: (() => void) | undefined
    const running = new Promise<void>((resolve) => { inFlight = resolve })
    setMockScript((request, index) => {
      if (index > 0) return text('after the cancel')
      inFlight?.()
      // Never finishes on its own; the cancel has to end it.
      return [
        { type: 'text-delta', index: 0, text: 'thinking' },
        { type: 'hang', signal: request.signal } as unknown as StreamChunk,
      ]
    })

    const pending = prompt(id, 'cancel me')
    await running
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await abortRun(id)).toBe(true)
    const wires = await pending

    // The run ends rather than hanging, and stopping on purpose is reported as
    // a notice: a red error for a button the user pressed reads as a failure
    // they caused.
    const stopped = wires.find(wire => wire.t === 'notice')
    expect(JSON.stringify(stopped)).toContain('cancelled by the user')
    expect(wires.some(wire => wire.t === 'error')).toBe(false)
    // The partial answer is still there.
    expect(wires.some(wire => wire.t === 'text-delta')).toBe(true)
    await forgetSession(id)
  }, 30_000)

  it('runs a tool, gates the mutating one, and shows both in the transcript', async () => {
    const id = await conversation()
    setMockScript((_request, index) => {
      if (index === 0) return call('t1', 'list_directory', { path: '.' })
      return text('listed the workspace')
    })

    await prompt(id, 'what is in here?')

    const stored = await readMessages(id)
    const tool = stored.find(node => (node as { kind: string }).kind === 'tool')
    expect(tool).toBeDefined()
    expect(JSON.stringify(tool)).toContain('list_directory')
    // A read-only tool runs unattended: nothing should have been parked.
    expect(JSON.stringify(stored)).not.toContain('"kind":"approval"')
  }, 20_000)

  it('sends no reasoning effort to a provider that declares none', async () => {
    // The offline provider declares no efforts, exactly as Gemini does. A run
    // that sent one anyway would be rejected by that provider in production.
    const id = await conversation()
    await updateConversation(id, { reasoningEffort: 'high' })
    setMockScript(() => text('answered'))

    const wires = await prompt(id, 'go')

    // Not an error: the remembered effort is a preference, and a model that
    // cannot honour it is sent none rather than sent something it rejects.
    expect(wires.some(wire => wire.t === 'error')).toBe(false)
    expect(mockRequests()[0]).not.toHaveProperty('reasoningEffort')
  }, 20_000)
})

describe('naming a skill with `/`', () => {
  it('asks the model to load it, without rewriting what the user said', async () => {
    // A skill is loaded when the MODEL decides it applies, so there was no way
    // to say "use the review skill, now" except in prose. `/` says it — and it
    // stays a mention: the directive tells the model to `load_skill`, it does
    // not splice the skill's instructions into the prompt.
    const skill = join(process.env.CHAT_AGENTS_WORKSPACE as string, '.agents', 'skills', 'code-review')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: code-review\ndescription: Review a diff for defects.\n---\n\nRead the diff first.\n',
      'utf8',
    )
    try {
      const id = await conversation()
      setMockScript(() => text('done'))

      await prompt(id, '/code-review look at the diff')

      const sent = JSON.stringify(mockRequests()[0]?.messages ?? [])
      expect(sent).toContain('load_skill')
      expect(sent).toContain('`code-review`')
      // The user's own words survive intact next to the directive.
      expect(sent).toContain('look at the diff')
      // The skill's BODY is not in the prompt: the model loads it or it does
      // not, and a copy here would be a second, stale one.
      expect(sent).not.toContain('Read the diff first')

      // The transcript stores what the user typed, not the instruction written
      // for the model — with the match recorded beside it.
      const stored = await readMessages(id)
      const user = stored.find(node => (node as { kind?: string }).kind === 'user')
      expect(user).toMatchObject({ text: '/code-review look at the diff', skills: ['code-review'] })
      expect(JSON.stringify(user)).not.toContain('`load_skill`')
    } finally { rmSync(join(process.env.CHAT_AGENTS_WORKSPACE as string, '.agents'), { recursive: true, force: true }) }
  }, 20_000)

  it('takes a chip the composer attached, with no `/` in the message', async () => {
    // Picked from the menu, a mention is a chip: it leaves the text, so the
    // prompt the model reads is an ordinary sentence and the id travels beside
    // it. The catalogue is still the allowlist.
    const skill = join(process.env.CHAT_AGENTS_WORKSPACE as string, '.agents', 'skills', 'code-review')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: code-review\ndescription: Review a diff for defects.\n---\n\nRead the diff first.\n',
      'utf8',
    )
    try {
      const id = await conversation()
      setMockScript(() => text('done'))

      const wires: Wire[] = []
      for await (const event of runPrompt(id, 'look at the diff', 'default', [], ['code-review'])) {
        wires.push(event as Wire)
      }

      const sent = JSON.stringify(mockRequests()[0]?.messages ?? [])
      expect(sent).toContain('load_skill')
      expect(sent).toContain('`code-review`')
      const stored = await readMessages(id)
      expect(stored.find(node => (node as { kind?: string }).kind === 'user'))
        .toMatchObject({ text: 'look at the diff', skills: ['code-review'] })
    } finally { rmSync(join(process.env.CHAT_AGENTS_WORKSPACE as string, '.agents'), { recursive: true, force: true }) }
  }, 20_000)

  it('drops a chip id no project has', async () => {
    const id = await conversation()
    setMockScript(() => text('done'))

    for await (const _ of runPrompt(id, 'do it', 'default', [], ['made-up'])) { /* drain */ }

    expect(JSON.stringify(mockRequests()[0]?.messages ?? [])).not.toContain('`load_skill`')
  }, 20_000)

  it('leaves a path alone', async () => {
    // `/etc/passwd` in a prompt must not become a skill, and a prompt with no
    // match must not carry a directive at all.
    const id = await conversation()
    setMockScript(() => text('done'))

    await prompt(id, 'read /etc/passwd and report')

    expect(JSON.stringify(mockRequests()[0]?.messages ?? [])).not.toContain('`load_skill`')
    const stored = await readMessages(id)
    expect(stored.find(node => (node as { kind?: string }).kind === 'user'))
      .not.toHaveProperty('skills')
  }, 20_000)
})

describe('a conversation that goes on all day', () => {
  it('compacts a single-agent chat instead of growing until the provider refuses', async () => {
    // The single-agent modes used to run on the bare loop, which carries no
    // compactor: a long chat grew until the model rejected it, with no recovery
    // and nothing in the UI to explain it. Both reference harnesses condense
    // instead — Codex auto-compacts against its token limit, the DeepSeek
    // harness runs a compaction service — and so must this.
    const id = await conversation()
    setMockContextWindow(4_000)
    const long = 'x'.repeat(6_000)
    setMockScript(() => text(long))

    // Enough exchanges that the transcript is several times the window.
    for (let turn = 0; turn < 6; turn++) await prompt(id, `question ${String(turn)} ${long}`)

    const requests = mockRequests()
    const sizes = requests.map(request => JSON.stringify(request.messages ?? []).length)
    const biggest = Math.max(...sizes)
    const last = sizes.at(-1) ?? 0
    // The request stops growing: whatever was compacted, the model is not being
    // handed the whole day every time.
    expect(last).toBeLessThan(biggest)
  }, 60_000)

  it('reaches the model with a message typed while it is still answering', async () => {
    // Steering runs through the session now rather than through a bare history
    // append. The message still has to arrive in the next model round.
    const id = await conversation()
    let midRun: (() => void) | undefined
    const running = new Promise<void>((resolve) => { midRun = resolve })
    setMockScript((request, index) => {
      if (index === 0) {
        midRun?.()
        return [
          { type: 'text-delta', index: 0, text: 'working' },
          { type: 'hang', signal: request.signal, ms: 150 } as unknown as StreamChunk,
          { type: 'block-end', index: 0, block: { type: 'text', text: 'working', phase: 'final-answer' } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
      }
      return text('took the correction')
    })

    const pending = prompt(id, 'first ask')
    await running
    expect(await steer(id, 'actually, only the summary')).toBe(true)
    await pending
    // The steered text reaches the model, not just the transcript.
    expect(JSON.stringify(mockRequests())).toContain('only the summary')
  }, 30_000)

  it('reads a `/` mention typed mid-run the same way as one typed at the start', async () => {
    // Steering was the path where the composer offered the menu and the mention
    // then arrived as bare text: `/code-review` mid-run meant nothing to the
    // model, which is worse than not offering the menu at all.
    const skill = join(process.env.CHAT_AGENTS_WORKSPACE as string, '.agents', 'skills', 'code-review')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: code-review\ndescription: Review a diff for defects.\n---\n\nRead the diff first.\n',
      'utf8',
    )
    try {
      const id = await conversation()
      let midRun: (() => void) | undefined
      const running = new Promise<void>((resolve) => { midRun = resolve })
      setMockScript((request, index) => {
        if (index === 0) {
          midRun?.()
          return [
            { type: 'text-delta', index: 0, text: 'working' },
            { type: 'hang', signal: request.signal, ms: 150 } as unknown as StreamChunk,
            { type: 'block-end', index: 0, block: { type: 'text', text: 'working', phase: 'final-answer' } },
            { type: 'finish', reason: { kind: 'stop' } },
          ]
        }
        return text('loaded it')
      })

      const pending = prompt(id, 'first ask')
      await running
      expect(await steer(id, 'now /code-review the diff')).toBe(true)
      await pending

      const sent = JSON.stringify(mockRequests())
      expect(sent).toContain('load_skill')
      expect(sent).toContain('the diff')
    } finally { rmSync(join(process.env.CHAT_AGENTS_WORKSPACE as string, '.agents'), { recursive: true, force: true }) }
  }, 30_000)
})

describe('the gate the user answers', () => {
  it('parks a write, shows it to a reload, and writes it once allowed', async () => {
    const id = await conversation()
    setMockScript((_request, index) => {
      if (index === 0) return call('w1', 'write_file', { path: 'gated.md', content: 'approved content' })
      return text('wrote it')
    })

    const running = prompt(id, 'write gated.md')
    // The prompt is not in the transcript, so a page reload has to find it here.
    let parked: readonly { callId: string }[] = []
    for (let attempt = 0; attempt < 200 && parked.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      parked = await pendingApprovals(id)
    }
    expect(parked).toHaveLength(1)

    expect(await approve(id, parked[0]?.callId ?? '', 'allow', 'once')).toBe(true)
    await running

    const written = join(home, 'sandbox', 'gated.md')
    expect(existsSync(written)).toBe(true)
    expect(readFileSync(written, 'utf8')).toContain('approved content')
  }, 30_000)

  it('leaves the file alone when the user says no, and says so in the transcript', async () => {
    const id = await conversation()
    setMockScript((_request, index) => {
      if (index === 0) return call('w1', 'write_file', { path: 'refused.md', content: 'nope' })
      return text('understood')
    })

    const running = prompt(id, 'write refused.md')
    let parked: readonly { callId: string }[] = []
    for (let attempt = 0; attempt < 200 && parked.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      parked = await pendingApprovals(id)
    }
    await approve(id, parked[0]?.callId ?? '', 'deny', 'once')
    await running

    expect(existsSync(join(home, 'sandbox', 'refused.md'))).toBe(false)
    const stored = await readMessages(id)
    // The refusal is part of the record, not something that only the model saw.
    expect(JSON.stringify(stored)).toContain('did not permit')
  }, 30_000)
})

describe('what the run spent and what it could not show', () => {
  it('records usage for an ordinary single-agent prompt', async () => {
    const id = await conversation()
    setMockScript(() => text('answered'))
    await prompt(id, 'go')

    const summary = await usageSummary('default')
    expect(summary.totals.totalTokens).toBeGreaterThan(0)
    expect(summary.rows.some(row => row.model === 'mock-scripted')).toBe(true)
  }, 20_000)

  it('spills a huge tool result and reads it back through the retrieval tool', async () => {
    const id = await conversation()
    setMockScript((_request, index) => {
      if (index === 0) return call('r1', 'read_file', { path: 'big.txt' })
      if (index === 1) {
        const previous = JSON.stringify(mockRequests()[1]?.messages ?? [])
        const locator = /spill:[0-9a-f]{32}/.exec(previous)?.[0] ?? 'spill:missing'
        return call('r2', 'read_tool_output', { locator, limit: 40 })
      }
      return text('summarised the file')
    })

    // A file far larger than one result's share of the context.
    const workspace = join(home, 'sandbox')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'big.txt'), 'NEEDLE '.repeat(20_000), 'utf8')

    await prompt(id, 'read big.txt')

    const stored = await readMessages(id)
    const asText = JSON.stringify(stored)
    // The oversized result left a locator rather than the whole file...
    expect(asText).toMatch(/spill:[0-9a-f]{32}/)
    expect(asText).toContain('read_tool_output')
    // ...and the retrieval tool answered with the content, not with an error.
    expect(asText).not.toContain('no saved output for this locator')
  }, 30_000)
})

describe('the other loop policies, end to end', () => {
  it('runs a deep turn through its self-check', async () => {
    const id = await conversation()
    await updateConversation(id, { mode: 'deep' })
    setMockScript((_request, index) => {
      if (index === 0) return call('t1', 'list_directory', { path: '.' })
      if (index === 1) {
        return call('s1', 'submit_result', {
          summary: 'Listed the workspace.', evidence: ['list_directory returned entries'],
        })
      }
      return text('here is what is in the workspace')
    })

    const wires = await prompt(id, 'what is here?')

    // The self-check is part of the record, and the run ends on the answer.
    const stored = await readMessages(id)
    expect(JSON.stringify(stored)).toContain('submit_result')
    expect(stored.at(-1)).toMatchObject({ kind: 'text' })
    expect(wires.some(wire => wire.t === 'run-end')).toBe(true)
  }, 30_000)

  it('parks a human-in-the-loop question and continues with the answer', async () => {
    const id = await conversation()
    await updateConversation(id, { mode: 'deep-human-in-loop' })
    setMockScript((_request, index) => {
      if (index === 0) {
        return call('q1', 'request_user_input', {
          questions: [{
            id: 'scope', header: 'Scope', question: 'Everything, or just the source?',
            options: [
              { label: 'Everything', description: 'the whole workspace' },
              { label: 'Source only', description: 'skip generated files' },
            ],
          }],
        })
      }
      if (index === 1) {
        return call('s1', 'submit_result', {
          summary: 'Used the answer.', evidence: ['the user chose Source only'],
        })
      }
      return text('scoped to the source')
    })

    const running = prompt(id, 'summarise this project')
    // An open question is not in the transcript — it lives in the run — so a
    // reload has to be handed it, exactly as a waiting permission prompt is.
    // A count could not be rendered into the card the user has to answer.
    let open: readonly { requestId: string; questions: readonly unknown[] }[] = []
    for (let attempt = 0; attempt < 300 && open.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      open = await pendingQuestions(id)
    }
    expect(open).toHaveLength(1)
    expect(open[0]?.questions).toHaveLength(1)

    expect(await answer(id, open[0]?.requestId ?? '', { scope: 'Source only' })).toBe(true)
    const wires = await running

    expect(JSON.stringify(mockRequests())).toContain('Source only')
    expect(wires.some(wire => wire.t === 'run-end')).toBe(true)
  }, 30_000)
})
