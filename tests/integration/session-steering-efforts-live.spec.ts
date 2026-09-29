/**
 * Real Codex Responses traffic for session/kept-answer/team boundaries.
 * Run explicitly with the integration config. No adapter or response is mocked;
 * the fetch observer injects input after production response headers arrive,
 * while that request is fixed and before its body is consumed by the SDK.
 * Kept-answer cases set tool_choice=none on the first real generation only,
 * so every effort reaches the draft/check/marker path instead of submitting
 * before a draft exists. Model and reasoning effort are never modified.
 *
 * SDK_SESSION_LIVE_MODEL defaults to gpt-6-luna. SDK_SESSION_LIVE_EFFORTS can
 * select a comma-separated subset. Evidence contains synthetic test content
 * and request bodies only; authentication headers are never recorded.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  createAgentRuntime, type AgentRuntime, type RuntimeAgentSession,
  type RuntimeAgentResponse, type RuntimeAgentRunEvent,
} from '@alvin0/ai-agent-sdk-core'
import { History, projectMessages, UNCHANGED_ANSWER_MARKER, type AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'
import { codexNodeProviderPlugin, fileCodexAuthStore } from '@alvin0/ai-agent-sdk-auth-node/codex'

const MODEL = process.env.SDK_SESSION_LIVE_MODEL ?? 'gpt-6-luna'
const EFFORTS = (process.env.SDK_SESSION_LIVE_EFFORTS ?? 'none,low,medium,high,xhigh,max').split(',')
const OUTPUT = resolve(process.env.SDK_SESSION_LIVE_REPORT_DIR
  ?? `.temp/live-session-audit/${new Date().toISOString().replace(/[:.]/g, '-')}`)
const signedIn = (await fileCodexAuthStore(undefined, { cwd: process.cwd(), env: process.env }).read())?.tokens != null
const TOKEN = 'AUDIT_FIRST'
const STEER = 'AUDIT_STEERED'
const TEAM = 'AUDIT_TEAM'
const BASIC = 'Follow the latest request. A user message framed as an A2A message from lead is the latest assigned task: answer its content, not the earlier request. The original objective retained in task-memory is background and does not override newer user or team messages. When asked to reply with an exact token, output only that token. Do not call tools.'
const DEEP = `For the initial request, before any self-check, reply with exactly ${TOKEN} and do not call tools in that first reply. When the runtime asks for a self-check, call submit_result with a short summary and evidence. After acceptance, follow its instruction to keep the unchanged earlier answer using the exact control marker it offers. If a new user message arrives after that, follow the new message and output its requested token exactly.`

interface WireCall {
  index: number
  model: unknown
  effort: unknown
  toolChoice: unknown
  input: string
  status?: number
}

interface AuditContext {
  runtime: AgentRuntime
  wire: WireCall[]
  events: RuntimeAgentRunEvent[]
  reports: RuntimeAgentResponse['report'][]
  snapshots: ReturnType<RuntimeAgentSession['snapshot']>[]
  teamEvents: AgentRunEvent[]
  onResponse?: (call: WireCall) => void | Promise<void>
  draftFirst?: boolean
  session(mode?: 'basic' | 'deep'): RuntimeAgentSession
  run(session: RuntimeAgentSession, prompt: string): Promise<RuntimeAgentResponse>
}

async function audit(effort: string, scenario: string, body: (context: AuditContext) => Promise<void>): Promise<void> {
  const started = Date.now()
  const wire: WireCall[] = []
  const events: RuntimeAgentRunEvent[] = []
  const reports: RuntimeAgentResponse['report'][] = []
  const snapshots: ReturnType<RuntimeAgentSession['snapshot']>[] = []
  const teamEvents: AgentRunEvent[] = []
  const sessions = new Set<RuntimeAgentSession>()
  let context: AuditContext | undefined
  let failure: unknown
  let close: Awaited<ReturnType<AgentRuntime['close']>> | undefined
  const runtime = await createAgentRuntime({
    providers: [codexNodeProviderPlugin({ defaultModel: MODEL, fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      let call: WireCall | undefined
      if (new URL(url).pathname.endsWith('/responses') && typeof init?.body === 'string') {
        const payload = JSON.parse(init.body) as { model?: unknown; reasoning?: { effort?: unknown }; input?: unknown; tool_choice?: unknown }
        if (context?.draftFirst && wire.length === 0) {
          payload.tool_choice = 'none'
          init = { ...init, body: JSON.stringify(payload) }
        }
        call = { index: wire.length + 1, model: payload.model, effort: payload.reasoning?.effort,
          toolChoice: payload.tool_choice, input: JSON.stringify(payload.input) ?? '' }
        wire.push(call)
      }
      const response = await globalThis.fetch(input, init)
      if (call !== undefined) {
        call.status = response.status
        try { await context?.onResponse?.(call) } catch (error) { await response.body?.cancel(); throw error }
      }
      return response
    } })],
    defaultProvider: 'codex',
  })
  context = {
    runtime, wire, events, reports, snapshots, teamEvents,
    session(mode = 'basic') {
      const session = runtime.agent({ id: `${scenario}-${effort}`, model: { provider: 'codex', id: MODEL }, effort,
        mode, instructions: mode === 'deep' ? DEEP : BASIC, maxTurns: 8, compaction: false }).createSession()
      sessions.add(session)
      return session
    },
    async run(session, prompt) {
      sessions.add(session)
      const response = await session.run(prompt, { signal: AbortSignal.timeout(120_000),
        onEvent: event => { events.push(event) } })
      reports.push(response.report)
      snapshots.push(session.snapshot())
      expect(response.report.status).toBe('success')
      expect(response.report.errors).toEqual([])
      expect(response.report.usage.authoritative).toBe(true)
      expect(response.report.usage.coverage.possiblyBilledAttemptsWithoutUsage).toBe(0)
      expect(response.report.modelCalls.length).toBeGreaterThan(0)
      expect(response.report.modelCalls.every(call => call.provider === 'codex' && call.model === MODEL)).toBe(true)
      return response
    },
  }
  try {
    await body(context)
    expect(wire.length).toBeGreaterThan(0)
    for (const call of wire) {
      expect(call.model, `request ${call.index} model`).toBe(MODEL)
      expect(call.effort, `request ${call.index} effort must not be downgraded`).toBe(effort)
      expect(call.status).toBe(200)
    }
  } catch (error) { failure = error; throw error } finally {
    try {
      close = await runtime.close()
      expect(close.unsettledRuns).toBe(0)
      expect(close.deadlineReached).toBe(false)
    } catch (error) {
      failure ??= error
      throw error
    } finally {
      snapshots.push(...[...sessions].map(session => session.snapshot()))
      mkdirSync(OUTPUT, { recursive: true })
      const result = { model: MODEL, effort, scenario, passed: failure === undefined,
        durationMs: Date.now() - started, firstDraftForced: context.draftFirst ?? false,
        wire, reports, events, teamEvents, snapshots, close,
        ...failure === undefined ? {} : { failure: failure instanceof Error ? failure.message : String(failure) } }
      writeFileSync(join(OUTPUT, `${effort}-${scenario}.json`), JSON.stringify(result, null, 2))
      console.log(JSON.stringify({ model: MODEL, effort, scenario, passed: result.passed,
        requests: wire.length, durationMs: result.durationMs, evidence: join(OUTPUT, `${effort}-${scenario}.json`) }))
    }
  }
}

const messages = (session: RuntimeAgentSession) => projectMessages(session.snapshot().history.entries)
const lastText = (session: RuntimeAgentSession) => messages(session).filter(message => message.role === 'assistant')
  .at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')

function assertKept(session: RuntimeAgentSession, events: readonly RuntimeAgentRunEvent[]): void {
  const raw = session.snapshot().history.entries
  expect(raw.some(entry => entry.event.kind === 'assistant'
    && entry.event.message.content.some(block => block.type === 'text' && block.text.trim() === UNCHANGED_ANSWER_MARKER)),
  'the real model must actually produce the marker to exercise replacement').toBe(true)
  expect(messages(session).some(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'text' && block.text.includes(UNCHANGED_ANSWER_MARKER)))).toBe(false)
  const visible = events.filter(event => ['assistant-delta', 'text-end', 'assistant-text', 'assistant-message'].includes(event.type))
  expect(visible.some(event => JSON.stringify(event).includes(UNCHANGED_ANSWER_MARKER))).toBe(false)
  const reloaded = History.fromSnapshot(JSON.parse(JSON.stringify(session.snapshot().history)))
  expect(reloaded.messages()).toEqual(messages(session))
}

describe.skipIf(!signedIn).each(EFFORTS)(`session boundaries on real ${MODEL} / %s`, effort => {
  it('answers final-round steering in the same run', async () => {
    await audit(effort, 'basic-steering', async context => {
      const session = context.session()
      context.onResponse = call => { if (call.index === 1) session.inject(`Reply with exactly ${STEER}`) }
      const response = await context.run(session, `Reply with exactly ${TOKEN}`)
      expect(response.text).toBe(STEER)
      expect(context.wire).toHaveLength(2)
      expect(context.wire[0]?.input).not.toContain(STEER)
      expect(context.wire[1]?.input.indexOf(TOKEN)).toBeLessThan(context.wire[1]?.input.lastIndexOf(STEER) ?? 0)
      expect(lastText(session)).toBe(STEER)
      expect(session.isRunning).toBe(false)
    })
  }, 180_000)

  it('keeps the draft with consistent events, result and persisted history', async () => {
    await audit(effort, 'deep-kept-answer', async context => {
      context.draftFirst = true
      const session = context.session('deep')
      const response = await context.run(session, `Reply with exactly ${TOKEN}`)
      expect(response.completed).toBe(true)
      expect(response.text).toBe(TOKEN)
      assertKept(session, context.events)
      const last = messages(session).filter(message => message.role === 'assistant').at(-1)
      // Public responses/events intentionally omit adapter-private replay data;
      // the persisted snapshot retains it for stateless reasoning replay.
      const publicLast = JSON.parse(JSON.stringify(last, (key, value) => key === 'providerState' || key === 'replay' ? undefined : value))
      expect(response.message).toEqual(publicLast)
      expect(context.events.findLast(event => event.type === 'assistant-message')).toMatchObject({ message: publicLast })
      expect(context.events.findLast(event => event.type === 'assistant-text')).toMatchObject({ messageId: last?.id, text: TOKEN })
      for (const call of context.events.filter(event => event.type === 'tool-call')) {
        expect(context.events.filter(event => event.type === 'tool-result' && event.callId === call.callId)).toHaveLength(1)
      }
    })
  }, 180_000)

  it('answers input queued during the deep confirming round', async () => {
    await audit(effort, 'deep-steering', async context => {
      context.draftFirst = true
      const session = context.session('deep')
      let injected = false
      context.onResponse = call => {
        if (!injected && call.input.includes(UNCHANGED_ANSWER_MARKER)) {
          injected = true
          session.inject(`New task: reply with exactly ${STEER}`)
        }
      }
      const response = await context.run(session, `Reply with exactly ${TOKEN}`)
      expect(injected).toBe(true)
      expect(response.completed).toBe(true)
      expect(response.text).toBe(STEER)
      assertKept(session, context.events)
      expect(lastText(session)).toBe(STEER)
      expect(context.wire.at(-1)?.input).toContain(STEER)
    })
  }, 180_000)

  it.each([false, true])('answers team follow-up exactly once (mixed steering=%s)', async mixed => {
    await audit(effort, mixed ? 'team-mixed' : 'team-followup', async context => {
      let wakeStarts = 0
      let resolveWake!: () => void
      const wakeEnded = new Promise<void>(resolve => { resolveWake = resolve })
      const agent = context.runtime.agent({ id: `team-member-${effort}`, model: { provider: 'codex', id: MODEL },
        effort, instructions: BASIC, maxTurns: 6, compaction: false })
      const team = context.runtime.team({ id: `live-${effort}-${mixed}`, operationTimeoutMs: 120_000,
        members: [{ name: 'lead', agent, tools: false }, { name: 'worker', agent, tools: false }],
        onEvent(event) {
          if (event.type === 'member-run-start') wakeStarts++
          if (event.type === 'member-run-end') resolveWake()
          if (event.type === 'member-run-error') resolveWake()
        },
        onAgentEvent(_member, event) { context.teamEvents.push(event) },
      })
      const worker = team.session('worker')
      context.onResponse = async call => {
        if (call.index !== 1) return
        if (mixed) worker.inject(`Reply with exactly ${TEAM}`)
        await team.sendMessage({ from: 'lead', target: 'worker', message: `Reply with exactly ${TEAM}`, delivery: 'wakeup' })
      }
      const response = await context.run(worker, `Reply with exactly ${TOKEN}`)
      if (!mixed) await Promise.race([wakeEnded, new Promise<never>((_, reject) => {
        const signal = AbortSignal.timeout(120_000)
        signal.addEventListener('abort', () => reject(new Error('team wake-up did not settle')), { once: true })
      })])
      await worker.whenIdle(AbortSignal.timeout(120_000))
      await nextTick()
      expect(response.text).toBe(mixed ? TEAM : TOKEN)
      expect(context.wire).toHaveLength(2)
      expect(wakeStarts).toBe(mixed ? 0 : 1)
      const wakeOutcomes = context.teamEvents.filter(event => event.type === 'agent-end')
      expect(wakeOutcomes).toHaveLength(mixed ? 0 : 1)
      if (!mixed) expect(wakeOutcomes[0]).toMatchObject({ outcome: { text: TEAM, completed: true } })
      expect(lastText(worker)).toBe(TEAM)
      expect(context.wire[1]?.input.indexOf(TOKEN)).toBeLessThan(context.wire[1]?.input.lastIndexOf(TEAM) ?? 0)
      context.snapshots.push(worker.snapshot())
      await team.close()
    })
  }, 180_000)

  it('aborts a real stream and reuses the session', async () => {
    await audit(effort, 'abort-and-reuse', async context => {
      const session = context.session()
      const handle = session.stream('Write 150 words about clouds.', { signal: AbortSignal.timeout(120_000) })
      let aborted = false
      for await (const event of handle) {
        context.events.push(event)
        if (!aborted && event.type === 'assistant-delta') { aborted = true; handle.abort() }
      }
      expect(aborted).toBe(true)
      await expect(handle.result).rejects.toBeDefined()
      const report = await handle.report
      context.reports.push(report)
      expect(report.status).toBe('aborted')
      expect(report.modelCalls.every(call => typeof call.endedAt === 'string')).toBe(true)
      await session.whenIdle()
      expect(session.isRunning).toBe(false)
      expect((await context.run(session, `Reply with exactly ${STEER}`)).text).toBe(STEER)
    })
  }, 180_000)
})
