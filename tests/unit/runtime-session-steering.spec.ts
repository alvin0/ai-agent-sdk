import { describe, expect, it } from 'vitest'
import { createAgentRuntime, ModelAdapter, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { GenerateOptions, RuntimeAgentSession, StreamChunk } from '@alvin0/ai-agent-sdk-core'
import { defineTool } from '@alvin0/ai-agent-sdk-core/agent'
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

  it('keeps steering that arrives during the final round, after the answer it could not change', async () => {
    const started = gate(), release = gate()
    await withSession(async function* () {
      started.open(); await release.opened
      yield* text('only round')
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
      // The last round was already streaming, so this run does not answer it: it
      // is kept, after that answer, for the caller to process with runPending().
      expect(model.requests).toHaveLength(1)
      expect(userTexts(session)).toEqual(['question', 'late steering'])
      expect(session.snapshot().history.entries.at(-1)?.event.kind).toBe('user')
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
