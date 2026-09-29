import { describe, expect, it } from 'vitest'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, RuntimeAgentSession, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineTool, projectMessages, UNCHANGED_ANSWER_MARKER } from '@alvin0/ai-agent-sdk-core/agent'
import { defineModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'

/**
 * `RuntimeAgentSession.inject` used to refuse while a run was in flight, so an
 * application built on the runtime could not steer at all even though the
 * underlying session (and the team path) queue such input. These specs pin the
 * runtime surface to that behaviour so a later change cannot quietly bring the
 * refusal back.
 */

type Round = (options: GenerateOptions, index: number) => AsyncIterable<StreamChunk>

class ScriptedModel extends ModelAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly round: Round) { super() }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 32_000 } }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return this.round(options, this.requests.length)
  }
}

function text(value: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: value },
    { type: 'block-end', index: 0, block: { type: 'text', text: value } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCall(id: string, name: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function noopTool(name: string) {
  return defineTool({ name, description: 'Look.', parameters: { type: 'object', properties: {} }, execute: () => ({ ok: true }) })
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open }
}

async function withSession<T>(
  round: Round,
  body: (context: { model: ScriptedModel; session: RuntimeAgentSession; runtime: Awaited<ReturnType<typeof createAgentRuntime>> }) => Promise<T>,
  agent: { tools?: ReturnType<typeof defineTool>[]; mode?: 'basic' | 'deep' } = {},
): Promise<T> {
  const model = new ScriptedModel(round)
  const runtime = await createAgentRuntime({ providers: [defineModelProviderPlugin({
    id: 'fixture', family: 'fixture', displayName: 'Fixture', routes: ['fixture'],
    setup(registrar) { registrar.registerAdapter(model) },
  })] })
  try {
    const session = runtime.agent({
      id: 'steered', model: { provider: 'fixture', id: 'test' }, instructions: 'Answer the user.',
      mode: agent.mode ?? 'basic', ...agent.tools === undefined ? {} : { tools: agent.tools },
    }).createSession()
    return await body({ model, session, runtime })
  } finally {
    await runtime.close()
  }
}

const userTexts = (session: RuntimeAgentSession): string[] => session.snapshot().history.entries.flatMap(entry =>
  entry.event.kind === 'user' && entry.event.message.source.kind === 'user'
    ? entry.event.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])

async function drain(handle: AsyncIterable<{ type: string }>): Promise<void> {
  for await (const event of handle) if (event.type === 'error') throw new Error('run reported an error event')
}

describe('RuntimeAgentSession.inject while a run is in flight', () => {
  it('accepts steering mid-round, delivers it to the next request, and settles the run', async () => {
    const started = gate(), release = gate()
    await withSession(async function* (_options, index) {
      if (index === 1) { started.open(); await release.opened; yield* toolCall('look-1', 'look'); return }
      yield* text('steered answer')
    }, async ({ model, session, runtime }) => {
      const handle = session.stream('original question')
      const done = drain(handle)
      await started.opened
      expect(session.isRunning).toBe(true)
      expect(() => session.inject('Answer in Vietnamese')).not.toThrow()
      release.open()
      await done
      const response = await handle.result
      expect(response.runId).toBe(handle.runId)
      expect(model.requests).toHaveLength(2)
      expect(JSON.stringify(model.requests[1]?.messages)).toContain('Answer in Vietnamese')
      // It follows the round that could not see it, not precedes it.
      const second = JSON.stringify(model.requests[1]?.messages)
      expect(second.indexOf('look-1')).toBeLessThan(second.indexOf('Answer in Vietnamese'))
      expect(userTexts(session)).toEqual(['original question', 'Answer in Vietnamese'])
      expect((await runtime.close()).unsettledRuns).toBe(0)
    }, { tools: [noopTool('look')] })
  })

  it('keeps a host tool result paired before the steering message', async () => {
    const started = gate(), release = gate()
    await withSession(async function* (_options, index) {
      yield* index === 1 ? toolCall('check-1', 'check') : text('verified')
    }, async ({ model, session }) => {
      const handle = session.stream('check this')
      const done = drain(handle)
      await started.opened
      session.inject('Use Vietnamese')
      release.open()
      await done
      expect((await handle.result).completed).toBe(true)
      const second = JSON.stringify(model.requests[1]?.messages)
      expect(second).toContain('check-1')
      expect(second.indexOf('verified')).toBeLessThan(second.indexOf('Use Vietnamese'))
      expect(userTexts(session)).toEqual(['check this', 'Use Vietnamese'])
    }, { tools: [defineTool({
      name: 'check', description: 'Verify.', parameters: { type: 'object', properties: {} },
      execute: async () => { started.open(); await release.opened; return { verified: true } },
    })] })
  })

  it('delivers several steering messages in arrival order', async () => {
    const started = gate(), release = gate()
    await withSession(async function* (_options, index) {
      if (index === 1) { started.open(); await release.opened; yield* toolCall('look-1', 'look'); return }
      yield* text('answer')
    }, async ({ model, session }) => {
      const handle = session.stream('question')
      const done = drain(handle)
      await started.opened
      session.inject('first')
      session.inject('second')
      session.inject('third')
      release.open()
      await done
      await handle.result
      expect(userTexts(session)).toEqual(['question', 'first', 'second', 'third'])
      const second = JSON.stringify(model.requests[1]?.messages)
      expect(second.indexOf('first')).toBeLessThan(second.indexOf('second'))
      expect(second.indexOf('second')).toBeLessThan(second.indexOf('third'))
    }, { tools: [noopTool('look')] })
  })

  it('answers steering that arrives during the final round in the same run, after the answer it could not change', async () => {
    const started = gate(), release = gate()
    await withSession(async function* (_options, index) {
      if (index === 1) { started.open(); await release.opened; yield* text('first answer'); return }
      yield* text('answer to the steering')
    }, async ({ model, session }) => {
      const handle = session.stream('question')
      const done = drain(handle)
      await started.opened
      session.inject('late steering')
      release.open()
      await done
      await handle.result
      await session.whenIdle()
      expect(session.isRunning).toBe(false)
      // The round already streaming could not see it; the run answers it in
      // one more round instead of leaving the person without a reply.
      expect(model.requests).toHaveLength(2)
      const second = JSON.stringify(model.requests[1]?.messages)
      expect(second.indexOf('first answer')).toBeLessThan(second.indexOf('late steering'))
      expect(userTexts(session)).toEqual(['question', 'late steering'])
      const answers = session.snapshot().history.entries.flatMap(entry => entry.event.kind === 'assistant'
        ? entry.event.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
      expect(answers.at(-1)).toBe('answer to the steering')
    })
  })

  it('retains queued steering in a snapshot taken mid-run and resumes it', async () => {
    const started = gate(), release = gate()
    await withSession(async function* () {
      started.open(); await release.opened
      yield* text('done')
    }, async ({ session }) => {
      const handle = session.stream('question')
      const done = drain(handle)
      await started.opened
      session.inject('queued while running')
      const captured = JSON.parse(JSON.stringify(session.snapshot()))
      release.open()
      await done
      await handle.result
      const serialized = JSON.stringify(captured)
      expect(serialized).toContain('queued while running')
    })
  })

  it('rejects oversized steering at admission without breaking the run', async () => {
    const started = gate(), release = gate()
    const model = new ScriptedModel(async function* () {
      started.open(); await release.opened
      yield* text('done')
    })
    const runtime = await createAgentRuntime({
      providers: [defineModelProviderPlugin({
        id: 'fixture', family: 'fixture', displayName: 'Fixture', routes: ['fixture'],
        setup(registrar) { registrar.registerAdapter(model) },
      })],
    })
    try {
      const session = runtime.agent({ id: 'small', model: { provider: 'fixture', id: 'test' }, instructions: 'x', mode: 'basic' })
        .createSession({ historyLimits: { maxEntryBytes: 1_024, maxBytes: 16_384 } })
      const handle = session.stream('question')
      const done = drain(handle)
      await started.opened
      expect(() => session.inject('x'.repeat(4_096))).toThrow(/byte limit/)
      release.open()
      await done
      expect((await handle.result).completed).toBe(true)
      expect(session.isRunning).toBe(false)
    } finally { await runtime.close() }
  })

  it('still appends at once when no run is active', async () => {
    await withSession(async function* () { yield* text('unused') }, async ({ session }) => {
      expect(session.isRunning).toBe(false)
      expect(session.inject('hello')).toBe(1)
      expect(userTexts(session)).toEqual(['hello'])
    })
  })

  it('still refuses to inject after the runtime is closed', async () => {
    const model = new ScriptedModel(async function* () { yield* text('unused') })
    const runtime = await createAgentRuntime({ providers: [defineModelProviderPlugin({
      id: 'fixture', family: 'fixture', displayName: 'Fixture', routes: ['fixture'],
      setup(registrar) { registrar.registerAdapter(model) },
    })] })
    const session = runtime.agent({ id: 'closed', model: { provider: 'fixture', id: 'test' }, instructions: 'x', mode: 'basic' }).createSession()
    await runtime.close()
    expect(() => session.inject('too late')).toThrow()
  })

  it('does not relax the other guards: reset and a second start still refuse mid-run', async () => {
    const started = gate(), release = gate()
    await withSession(async function* () {
      started.open(); await release.opened
      yield* text('done')
    }, async ({ session }) => {
      const handle = session.stream('question')
      const done = drain(handle)
      await started.opened
      expect(() => session.reset()).toThrow(/Cannot reset while a runtime session is active/)
      expect(() => session.stream('another')).toThrow(/active/)
      release.open()
      await done
      await handle.result
    })
  })

  it('steers a deep-mode run and the steering survives the self-check round', async () => {
    const started = gate(), release = gate()
    await withSession(async function* (_options, index) {
      if (index === 1) { started.open(); await release.opened; yield* text('draft answer'); return }
      if (index === 2) { yield* toolCall('submit', 'submit_result'); return }
      yield* text('final answer')
    }, async ({ session }) => {
      const handle = session.stream('question')
      const done = drain(handle)
      await started.opened
      session.inject('keep it short')
      release.open()
      await done
      await handle.result
      expect(userTexts(session)).toContain('keep it short')
      expect(session.isRunning).toBe(false)
    }, { mode: 'deep' })
  })
})

describe('RuntimeAgentSession: deep-mode kept answer, end to end', () => {
  const submitCall = (id: string): StreamChunk[] => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name: 'submit_result',
      arguments: JSON.stringify({ summary: 'Checked.', evidence: ['reviewed'] }) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const MARKER = UNCHANGED_ANSWER_MARKER
  const DRAFT = 'The draft answer, complete.'

  async function collectRun(session: RuntimeAgentSession, input: string, midRun?: () => void) {
    const events: { type: string; [key: string]: unknown }[] = []
    const handle = session.stream(input)
    for await (const event of handle) {
      events.push(event as never)
      if (event.type === 'error') throw new Error('run reported an error event')
      if (event.type === 'tool-result' && midRun) { midRun(); midRun = undefined }
    }
    return { events, result: await handle.result }
  }

  // What SDK consumers read back: the history surface. The raw log is
  // append-only and keeps the marker entry, superseded by a replace entry.
  const surface = (session: RuntimeAgentSession) => projectMessages(session.snapshot().history.entries)
  const assistantTexts = (session: RuntimeAgentSession) => surface(session).flatMap(message =>
    message.role === 'assistant' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])

  it('returns the kept draft as the run result and never streams the marker', async () => {
    await withSession(async function* (_options, index) {
      yield* index === 1 ? text(DRAFT) : index === 2 ? submitCall('s1') : text(MARKER)
    }, async ({ session }) => {
      const { events, result } = await collectRun(session, 'question')
      expect(result).toMatchObject({ completed: true, text: DRAFT })
      const deltas = events.filter(event => event.type === 'assistant-delta').map(event => event.text).join('')
      expect(deltas).toBe(DRAFT)
      const leaks = events.filter(event => event.type !== 'tool-result' && event.type !== 'span-start' && event.type !== 'span-end')
        .filter(event => JSON.stringify(event).includes(MARKER)).map(event => event.type)
      expect(leaks).toEqual([])
    }, { mode: 'deep' })
  })

  it('keeps the answer, then answers steering that arrived during the confirming round', async () => {
    const started = gate(), release = gate()
    await withSession(async function* (_options, index) {
      if (index === 1) { yield* text(DRAFT); return }
      if (index === 2) { yield* submitCall('s1'); return }
      if (index === 3) { started.open(); await release.opened; yield* text(MARKER); return }
      yield* text('Costs: about 20% more.')
    }, async ({ session }) => {
      const handle = session.stream('question')
      const done = drain(handle)
      await started.opened
      session.inject('also mention costs')
      release.open()
      await done
      // The steering is answered in the same run, so its answer is the result.
      expect(await handle.result).toMatchObject({ completed: true, text: 'Costs: about 20% more.' })
      await session.whenIdle()
      // The kept answer, then the steering it could not see, then its answer.
      expect(userTexts(session)).toEqual(['question', 'also mention costs'])
      const order = surface(session).flatMap(message => message.content.flatMap(block => block.type === 'text'
        && [DRAFT, 'also mention costs', 'Costs: about 20% more.'].includes(block.text) ? [block.text] : []))
      // The stand-in repeats the draft where the marker was, so the model-facing
      // surface carries it twice (the original and the kept answer). Known cost,
      // cheaper than the rewrite it replaces; collapsing the range would erase
      // steering or tool results that fall between them.
      expect(order).toEqual([DRAFT, DRAFT, 'also mention costs', 'Costs: about 20% more.'])
      expect(assistantTexts(session).some(value => value.includes(MARKER))).toBe(false)
    }, { mode: 'deep' })
  })

  it('steering during the self-check tool round reaches the model before it confirms or rewrites', async () => {
    await withSession(async function* (options, index) {
      if (index === 1) { yield* text(DRAFT); return }
      if (index === 2) { yield* submitCall('s1'); return }
      // The steering changed the task, so the model rewrites rather than keeps.
      const sawSteer = JSON.stringify(options.messages).includes('answer in one line')
      yield* text(sawSteer ? 'One-line answer.' : MARKER)
    }, async ({ session, model }) => {
      const { result } = await collectRun(session, 'question', () => session.inject('answer in one line'))
      expect(JSON.stringify(model.requests[2]?.messages)).toContain('answer in one line')
      expect(result).toMatchObject({ completed: true, text: 'One-line answer.' })
      expect(assistantTexts(session).at(-1)).toBe('One-line answer.')
    }, { mode: 'deep' })
  })

  it('a follow-up run after a kept answer starts clean and answers the new question', async () => {
    await withSession(async function* (_options, index) {
      if (index === 1) { yield* text(DRAFT); return }
      if (index === 2) { yield* submitCall('s1'); return }
      if (index === 3) { yield* text(MARKER); return }
      if (index === 4) { yield* submitCall('s2'); return }
      yield* text('Second answer.')
    }, async ({ session }) => {
      expect((await collectRun(session, 'first')).result.text).toBe(DRAFT)
      const second = await collectRun(session, 'second')
      expect(second.result).toMatchObject({ completed: true, text: 'Second answer.' })
      expect(assistantTexts(session).some(value => value.includes(MARKER))).toBe(false)
    }, { mode: 'deep' })
  })

  it('a snapshot resumed after a kept answer replays the answer, not the marker', async () => {
    let snapshot: unknown
    await withSession(async function* (_options, index) {
      yield* index === 1 ? text(DRAFT) : index === 2 ? submitCall('s1') : text(MARKER)
    }, async ({ session }) => {
      await collectRun(session, 'question')
      snapshot = JSON.parse(JSON.stringify(session.snapshot()))
    }, { mode: 'deep' })
    // Replay into a fresh runtime: the model-facing history it sends must carry
    // the kept answer as the last assistant turn.
    const requests: GenerateOptions[] = []
    await withSession(async function* (options) { requests.push(options); yield* text('ok') }, async ({ runtime }) => {
      const resumed = runtime.agent({ id: 'steered', model: { provider: 'fixture', id: 'test' }, instructions: 'x', mode: 'basic' })
        .resumeSession(snapshot as never)
      await drain(resumed.stream('next'))
      const sent = JSON.stringify(requests[0]?.messages)
      expect(sent).toContain(DRAFT)
      expect(sent.lastIndexOf(DRAFT)).toBeGreaterThan(sent.lastIndexOf(MARKER))
    })
  })
})
