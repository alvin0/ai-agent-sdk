/**
 * The Hono application, written against web standards only.
 *
 * Nothing here touches `node:` anything, so the same module runs unchanged on
 * the Next.js Edge runtime, on Cloudflare Workers, and on Deno. The Next route
 * handler does nothing but forward the request to `app.fetch`.
 */

import { Hono } from 'hono'
import type {
  RuntimeAgentRunEvent, RuntimeAgentRunHandle, RuntimeAgentSession, RuntimeAgentTeam,
} from '@alvin0/ai-agent-sdk-core'
import type { AgentRunEvent, AgentRunHandle, AgentSession } from '@alvin0/ai-agent-sdk-core/agent'
import { readConfig } from './config'
import {
  SessionCapacityError, acquireSession, activeSessions, dropSession, findSession, findTrace, leadName,
  type WarmSession,
} from './sessions'
import type { RunTrace } from './traces'
import {
  API_KEY_HEADER, API_KEY_PATTERN, CONVERSATION_ID, EFFORTS, MAX_CATALOG_MODELS,
  MAX_CONTEXT_WINDOW, MAX_MEMBER_INSTRUCTIONS, MAX_PROMPT_CHARS, MAX_TEAM_MEMBERS,
  MEMBER_NAME, MIN_CONTEXT_WINDOW, MIN_OUTPUT_TOKENS, MODEL_ID,
  effortsForModel, type HealthBody, type RunMode, type WireEvent, type WireMember,
  type WireModel, type WireUsage,
} from './wire'

/** Longest single text delta forwarded to the browser, in characters. */
const MAX_DELTA_CHARS = 8_000

/**
 * Create the Edge chat backend.
 * @param basePath - Path prefix the host mounts the app under, e.g. `/api`.
 * @returns A Hono app whose `fetch` handles the request.
 */
export function createEdgeChatApp(basePath = '/api') {
  const app = new Hono().basePath(basePath)

  app.get('/health', (c) => {
    const config = readConfig()
    const body: HealthBody = {
      ok: true,
      runtime: 'web-standards',
      mode: config.mode,
      model: config.model,
      models: config.models,
      efforts: EFFORTS,
      configured: config.apiKey !== undefined,
      activeSessions: activeSessions(),
    }
    return c.json(body)
  })

  app.get('/conversations/:id/traces', async (c) => {
    const conversationId = c.req.param('id')
    if (!CONVERSATION_ID.test(conversationId)) return c.json({ error: 'invalid_conversation_id' }, 400)
    const supplied = c.req.header(API_KEY_HEADER)
    if (supplied !== undefined && !API_KEY_PATTERN.test(supplied)) {
      return c.json({ error: 'invalid_api_key' }, 400)
    }
    const config = readConfig(process.env, supplied)
    const entry = await findSession(conversationId, config.apiKey)
    return c.json({ traces: entry?.traceStore.list() ?? [] })
  })

  app.get('/traces/:runId', async (c) => {
    const supplied = c.req.header(API_KEY_HEADER)
    if (supplied !== undefined && !API_KEY_PATTERN.test(supplied)) {
      return c.json({ error: 'invalid_api_key' }, 400)
    }
    const config = readConfig(process.env, supplied)
    return c.json({ spans: await findTrace(c.req.param('runId'), config.apiKey) })
  })

  app.post('/chat', async (c) => {
    const supplied = c.req.header(API_KEY_HEADER)
    if (supplied !== undefined && !API_KEY_PATTERN.test(supplied)) {
      return c.json({ error: 'invalid_api_key' }, 400)
    }
    const body: unknown = await c.req.json().catch(() => undefined)
    const conversationId = field(body, 'conversationId')
    const message = field(body, 'message')
    const model = field(body, 'model')
    const effort = field(body, 'effort')
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) {
      return c.json({ error: 'invalid_conversation_id' }, 400)
    }
    if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_PROMPT_CHARS) {
      return c.json({ error: 'invalid_message', maxChars: MAX_PROMPT_CHARS }, 400)
    }
    if (model !== undefined && (typeof model !== 'string' || !MODEL_ID.test(model))) {
      return c.json({ error: 'invalid_model' }, 400)
    }
    if (effort !== undefined && (typeof effort !== 'string' || !EFFORTS.includes(effort))) {
      return c.json({ error: 'invalid_effort', efforts: EFFORTS }, 400)
    }
    const mode = field(body, 'mode')
    if (mode !== undefined && mode !== 'single' && mode !== 'team' && mode !== 'team-auto') {
      return c.json({ error: 'invalid_mode' }, 400)
    }
    let team: readonly WireMember[] | undefined
    try { team = parseTeam(field(body, 'team')) }
    catch (error) { return c.json({ error: 'invalid_team', message: reason(error) }, 400) }
    let catalog: readonly WireModel[] | undefined
    try { catalog = parseCatalog(field(body, 'catalog')) }
    catch (error) { return c.json({ error: 'invalid_catalog', message: reason(error) }, 400) }

    const config = readConfig(process.env, supplied, {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(mode === undefined ? {} : { mode: mode as RunMode }),
      ...(team === undefined ? {} : { team }),
      ...(catalog === undefined ? {} : { catalog }),
    })
    const unsupported = unsupportedEffort(config)
    if (unsupported !== undefined) {
      return c.json({
        error: 'invalid_effort',
        model: unsupported.model,
        effort: unsupported.effort,
        efforts: unsupported.allowed,
      }, 400)
    }
    if (config.apiKey === undefined) {
      return c.json({
        error: 'not_configured',
        message: 'No API key. Add one in the page, or set OPENAI_API_KEY for this deployment.',
      }, 503)
    }

    let entry
    try { entry = await acquireSession(conversationId, config) }
    catch (error) {
      if (error instanceof SessionCapacityError) return c.json({ error: 'session_capacity' }, 503)
      return c.json({ error: 'provider_initialization_failed', message: reason(error) }, 503)
    }
    // One conversation runs one turn at a time: the session owns the history,
    // and two interleaved runs would write into it in an order neither the user
    // nor the model can reconstruct.
    if (entry.session.isRunning) return c.json({ error: 'conversation_busy' }, 409)
    entry.touchedAt = Date.now()

    // A failure recorded during an earlier run must not be offered as the
    // explanation for this one.
    entry.providerError.message = undefined
    // Events queued by an earlier turn describe that turn, not this one.
    entry.teamEvents.length = 0
    entry.teamRawEvents.length = 0
    entry.autoEvents.length = 0
    const context: RunContext = {
      conversationId,
      prompt: message.trim(),
      model: config.model,
      mode: config.mode,
      ...(config.mode === 'team' ? { members: config.team } : {}),
      entry,
    }
    if (entry.kind === 'team-auto') {
      const managed = entry.managedTeam
      if (managed === undefined) return c.json({ error: 'team_auto_unavailable' }, 503)
      const abort = new AbortController()
      entry.activeAbort = abort
      return streamAutoRun(managed.lead.stream(message.trim(), { signal: abort.signal }), abort, context)
    }
    const session = entry.session as RuntimeAgentSession
    // The model and effort for THIS turn, not for the session. The visitor can
    // change either between turns and keep the conversation: the agent's own
    // binding is untouched, and a turn that names neither runs on it again.
    return streamRun(session.stream(message.trim(), {
      includeTraceEvents: true,
      model: { provider: 'openai', id: config.model },
      ...(config.effort === undefined ? {} : { effort: config.effort }),
    }), context)
  })

  app.post('/close', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined)
    const conversationId = field(body, 'conversationId')
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) {
      return c.json({ error: 'invalid_conversation_id' }, 400)
    }
    const supplied = c.req.header(API_KEY_HEADER)
    if (supplied !== undefined && !API_KEY_PATTERN.test(supplied)) {
      return c.json({ error: 'invalid_api_key' }, 400)
    }
    // The same key must be presented to close a session as to open it, since
    // that is what identifies whose session it is.
    const config = readConfig(process.env, supplied)
    return c.json({ closed: await dropSession(conversationId, config.apiKey) })
  })

  app.all('*', c => c.json({ error: 'not_found' }, 404))
  return app
}

/** Find an effort that is not declared for the exact model it would run on. */
function unsupportedEffort(config: ReturnType<typeof readConfig>): {
  readonly model: string
  readonly effort: string
  readonly allowed: readonly string[]
} | undefined {
  const choices = [
    { model: config.model, effort: config.effort },
    ...config.team.map(member => ({
      model: member.model ?? config.model,
      effort: member.effort ?? (member.model === undefined ? config.effort : undefined),
    })),
  ]
  for (const choice of choices) {
    if (choice.effort === undefined) continue
    const allowed = effortsForModel(choice.model, config.catalog)
    if (!allowed.includes(choice.effort)) {
      return { model: choice.model, effort: choice.effort, allowed }
    }
  }
  return undefined
}

/**
 * Turn a run handle into a Server-Sent Events response.
 *
 * The browser cancelling the body is the abort signal: there is no separate
 * cancel endpoint to route to a different isolate, which would not hold this
 * run anyway.
 * @param handle - The run in flight.
 * @param context - What the opening frame announces, plus the warm session the
 *   run belongs to: its team, its queued team events, and the box the host's
 *   fetch leaves provider errors in.
 * @returns The streaming response.
 */
function streamRun(handle: RuntimeAgentRunHandle, context: RunContext): Response {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false

  const send = (event: WireEvent): void => {
    if (controller === undefined || closed) return
    try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
    catch { closed = true }
  }

  const body = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target
      send({
        t: 'start',
        runId: handle.runId,
        conversationId: context.conversationId,
        model: context.model,
        mode: context.mode,
        ...(context.members === undefined ? {} : { members: context.members }),
      })
      const trace = context.entry.traceStore.start(handle.runId, context.prompt)
      void pump(handle, send, { ...context, trace }).finally(() => {
        closed = true
        controller = undefined
        try { target.close() } catch { /* the client is already gone */ }
      })
    },
    async cancel() {
      closed = true
      controller = undefined
      handle.abort()
      await handle.report.catch(() => undefined)
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Proxies that buffer a response defeat streaming entirely.
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Stream a managed dynamic team.
 *
 * A low-level managed handle has no public abort method because cancellation is
 * supplied when the run starts. The controller here therefore belongs to both
 * the SSE body and the handle, preserving the same browser-cancels-run contract
 * as the composition runtime above.
 */
function streamAutoRun(
  handle: AgentRunHandle,
  abort: AbortController,
  context: RunContext,
): Response {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false

  const send = (event: WireEvent): void => {
    if (controller === undefined || closed) return
    try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
    catch { closed = true }
  }

  const body = new ReadableStream<Uint8Array>({
    start(target) {
      controller = target
      send({
        t: 'start',
        runId: handle.runId,
        conversationId: context.conversationId,
        model: context.model,
        mode: 'team-auto',
        members: [{ name: 'lead', role: 'lead' }],
      })
      const trace = context.entry.traceStore.start(handle.runId, context.prompt)
      void pumpAuto(handle, abort, send, { ...context, trace }).finally(() => {
        closed = true
        controller = undefined
        try { target.close() } catch { /* the client is already gone */ }
      })
    },
    async cancel() {
      closed = true
      controller = undefined
      abort.abort(new Error('Team Auto response cancelled'))
      await handle.report.catch(() => undefined)
      await closeAutoWorkers(context.entry)
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
    },
  })
}

/** Consume the lead stream while also forwarding workers and lead wakeups. */
async function pumpAuto(
  handle: AgentRunHandle,
  abort: AbortController,
  send: (event: WireEvent) => void,
  context: RunContext,
): Promise<void> {
  const managed = context.entry.managedTeam
  if (managed === undefined) return
  const started = new Set<string>()
  const ended = new Set<string>()
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  const account = (event: AgentRunEvent): void => {
    if (event.type !== 'usage') return
    const input = event.usage.inputTokens ?? 0
    const output = event.usage.outputTokens ?? 0
    usage.inputTokens += input
    usage.outputTokens += output
    usage.totalTokens += event.usage.totalTokens ?? input + output
  }
  const projectQueued = (member: string, event: AgentRunEvent): void => {
    account(event)
    const lead = member === managed.leadName
    const span = context.trace?.observe(event, member)
    if (span !== undefined) send({ t: 'span', span })
    if (!lead && !started.has(member)) {
      started.add(member)
      send({ t: 'member-start', member })
    }
    projectAgentEvent(event, send, lead ? managed.leadName : member)
    if (!lead && event.type === 'agent-end' && !ended.has(member)) {
      ended.add(member)
      const failed = !event.outcome.completed
      send({ t: 'member-end', member, ...(failed ? { failed: true as const } : {}) })
    }
  }
  const drain = (): void => {
    for (const queued of context.entry.autoEvents.splice(0, context.entry.autoEvents.length)) {
      projectQueued(queued.member, queued.event)
    }
  }
  // A lead waiting inside a team tool emits nothing, so worker events need an
  // independent wakeup path to reach the SSE body promptly.
  const timer = setInterval(drain, TEAM_POLL_MS)

  try {
    for await (const event of handle) {
      drain()
      account(event)
      const span = context.trace?.observe(event, managed.leadName)
      if (span !== undefined) send({ t: 'span', span })
      projectAgentEvent(event, send, managed.leadName)
    }
    const initial = await handle.result
    drain()
    // Workers are intentionally detached from the original lead handle. Keep
    // this response open through their reports and any synthesis turn they
    // wake on the lead, matching chat-agents' Team Auto lifecycle.
    await managed.whenQuiet(abort.signal)
    drain()
    const text = lastAssistantTextFromSession(managed.lead) ?? initial.text
    if (usage.totalTokens === 0) {
      const reported = usageOf(initial.report.usage.reported)
      usage.inputTokens = reported.inputTokens
      usage.outputTokens = reported.outputTokens
      usage.totalTokens = reported.totalTokens
    }
    send({ t: 'done', text, usage })
    await closeAutoWorkers(context.entry)
  } catch {
    drain()
    if (abort.signal.aborted) return
    const report = await handle.report.catch(() => undefined)
    const last = report?.errors.at(-1)
    const call = report?.modelCalls.findLast(entry => entry.error !== undefined)
    const detail = context.entry.providerError.message
    send({
      t: 'error',
      code: last?.code ?? 'RUN_FAILED',
      message: last?.message ?? 'The Team Auto run did not complete.',
      ...(last?.stage === undefined ? {} : { stage: last.stage }),
      ...(call?.error?.status === undefined ? {} : { status: call.error.status }),
      ...(detail === undefined ? {} : { detail }),
    })
    await closeAutoWorkers(context.entry)
  } finally {
    clearInterval(timer)
    if (context.entry.activeAbort === abort) context.entry.activeAbort = undefined
  }
}

/** Free settled worker slots so a long conversation can create a fresh team. */
async function closeAutoWorkers(entry: WarmSession): Promise<void> {
  const managed = entry.managedTeam
  if (managed === undefined) return
  const workers = managed.workers()
  await Promise.allSettled(workers.map(worker => managed.closeWorker(
    worker.name,
    new Error('Team Auto turn finished'),
  )))
}

/** Everything the stream needs beyond the handle itself. */
interface RunContext {
  readonly conversationId: string
  readonly prompt: string
  readonly model: string
  readonly mode: RunMode
  readonly members?: readonly WireMember[]
  readonly entry: WarmSession
  readonly trace?: RunTrace
}

async function pump(
  handle: RuntimeAgentRunHandle,
  send: (event: WireEvent) => void,
  context: RunContext,
): Promise<void> {
  const { providerError } = context.entry
  // The lead's own output is what streams. A peer's run is started by the team
  // rather than by this host, so nothing of it is on this handle; the watcher
  // below reports peers from the team's event queue instead, and the two write
  // to the stream from the same task so their frames cannot interleave badly.
  const lead = context.mode === 'team' ? leadOf(context) : undefined
  const watcher = context.mode === 'team' ? watchTeam(send, context) : undefined
  try {
    for await (const event of handle) {
      watcher?.drain()
      project(event, send, lead)
    }
    const result = await handle.result
    watcher?.drain()
    send({ t: 'done', text: result.text, usage: usageOf(result.report.usage.reported) })
  } catch {
    watcher?.drain()
    const report = await handle.report.catch(() => undefined)
    const last = report?.errors.at(-1)
    // Every message the report carries is redacted down to "Provider operation
    // failed", which tells nobody anything. The status comes from the failing
    // model call, and the words come from the body the host's own fetch read —
    // together they are what makes a wrong model id or an exhausted quota
    // diagnosable from the page instead of from a log nobody has.
    const call = report?.modelCalls.findLast(entry => entry.error !== undefined)
    const detail = providerError.message
    send({
      t: 'error',
      code: last?.code ?? 'RUN_FAILED',
      message: last?.message ?? 'The run did not complete.',
      ...(last?.stage === undefined ? {} : { stage: last.stage }),
      ...(call?.error?.status === undefined ? {} : { status: call.error.status }),
      ...(detail === undefined ? {} : { detail }),
    })
  } finally {
    watcher?.stop()
  }
}

/** The lead's name, which every frame from this handle carries in a team run. */
function leadOf(context: RunContext): string | undefined {
  return context.members === undefined ? undefined : leadName(context.members)
}

/** How often the team queue is checked while the lead is blocked, in ms. */
const TEAM_POLL_MS = 200

/**
 * Report peers while the lead works.
 *
 * The lead spends most of a team turn blocked in `wait_agents`, producing no
 * events of its own, so draining the queue only when the handle yields would
 * leave the roster frozen for the whole delegation. A timer drains it too.
 * @param send - The stream writer.
 * @param context - The run's team and its queued events.
 * @returns A drain function and the timer's stop.
 */
function watchTeam(send: (event: WireEvent) => void, context: RunContext) {
  const { teamEvents, team, teamRawEvents } = context.entry
  const drain = (): void => {
    for (const event of teamEvents.splice(0, teamEvents.length)) {
      if (event.type === 'member-run-start') send({ t: 'member-start', member: event.member })
      else if (event.type === 'member-run-error') {
        send({ t: 'member-end', member: event.member, failed: true })
      } else if (event.type === 'member-run-end') {
        // The member's text is read from its own session, because that is where
        // the run that produced it wrote.
        const text = team === undefined ? undefined : lastAssistantText(team, event.member)
        if (text !== undefined) send({ t: 'member-message', member: event.member, text })
        send({ t: 'member-end', member: event.member })
      }
    }
    for (const queued of teamRawEvents.splice(0, teamRawEvents.length)) {
      const span = context.trace?.observe(queued.event, queued.member)
      if (span !== undefined) send({ t: 'span', span })
      projectAgentEvent(queued.event, send, queued.member)
    }
  }
  const timer = setInterval(drain, TEAM_POLL_MS)
  return { drain, stop: () => { clearInterval(timer) } }
}

/** The last thing a member said, out of its own session history. */
function lastAssistantText(team: RuntimeAgentTeam, member: string): string | undefined {
  let session
  try { session = team.session(member) }
  catch { return undefined }
  const entries = session.snapshot().history.entries
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index]?.event
    if (event?.kind !== 'assistant') continue
    const text = event.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    return text.length === 0 ? undefined : cap(text)
  }
  return undefined
}

/** Last complete assistant text in a low-level managed session. */
function lastAssistantTextFromSession(session: AgentSession): string | undefined {
  const entries = session.snapshot().history.entries
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index]?.event
    if (event?.kind !== 'assistant') continue
    const text = event.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    return text.length === 0 ? undefined : text
  }
  return undefined
}

/** Map low-level managed-team events onto the compact Edge wire protocol. */
function projectAgentEvent(
  event: AgentRunEvent,
  send: (event: WireEvent) => void,
  member: string,
): void {
  const from = { member }
  if (event.type === 'text-delta') {
    send({
      t: 'text-delta', text: cap(event.text),
      blockId: `${event.trace.spanId}:${String(event.index)}`,
      ...from,
    })
  } else if (event.type === 'reasoning-delta') {
    send({
      t: 'reasoning-delta', text: cap(event.text),
      blockId: `${event.trace.spanId}:${String(event.index)}`,
      ...from,
    })
  } else if (event.type === 'tool-call') {
    send({
      t: 'tool-call',
      callId: event.call.callId,
      name: event.call.toolName,
      input: toolInput(event.call.rawArguments),
      ...from,
    })
  } else if (event.type === 'tool-result') {
    send({
      t: 'tool-result',
      callId: event.call.callId,
      name: event.call.toolName,
      status: event.result.isError ? 'failed' : 'completed',
      isError: event.result.isError,
      ...from,
    })
  } else if (event.type === 'assistant-native-tool') {
    send({
      t: 'native-tool',
      callId: event.call.id,
      name: event.call.name,
      provider: 'openai',
      status: event.call.status ?? 'unknown',
    })
  }
}

/** Preserve malformed model arguments as text instead of hiding the call. */
function toolInput(raw: string): unknown {
  try { return JSON.parse(raw) as unknown }
  catch { return raw }
}


/** Map one runtime event onto the wire, dropping everything the UI does not draw. */
function project(
  event: RuntimeAgentRunEvent,
  send: (event: WireEvent) => void,
  member: string | undefined,
): void {
  // Undefined attribution is a single-agent run; the field is omitted rather
  // than sent empty, so the client can tell "nobody in particular" from "".
  const from = member === undefined ? {} : { member }
  if (event.type === 'assistant-delta') {
    send({
      t: 'text-delta', text: cap(event.text), blockId: event.blockId, ...from,
    })
  } else if (event.type === 'reasoning-delta') {
    send({
      t: 'reasoning-delta', text: cap(event.text),
      ...(event.blockId === undefined ? {} : { blockId: event.blockId }),
      ...from,
    })
  } else if (event.type === 'commentary-delta') {
    send({
      t: 'reasoning-delta', text: cap(event.text), blockId: event.blockId, ...from,
    })
  }
  else if (event.type === 'tool-call') {
    send({ t: 'tool-call', callId: event.callId, name: event.name, input: event.input, ...from })
  } else if (event.type === 'tool-result') {
    send({
      t: 'tool-result',
      callId: event.callId,
      name: event.name,
      status: event.status,
      isError: event.status !== 'completed',
      ...from,
    })
  } else if (event.type === 'assistant-native-tool') {
    send({
      t: 'native-tool',
      callId: event.callId,
      name: event.name,
      provider: event.provider,
      status: event.status,
    })
  }
}

function usageOf(counters: {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}): WireUsage {
  return {
    inputTokens: counters.inputTokens ?? 0,
    outputTokens: counters.outputTokens ?? 0,
    totalTokens: counters.totalTokens ?? 0,
  }
}

function cap(text: string): string {
  return text.length > MAX_DELTA_CHARS ? text.slice(0, MAX_DELTA_CHARS) : text
}

function field(value: unknown, key: string): unknown {
  return value === null || typeof value !== 'object' ? undefined : Reflect.get(value, key)
}

/**
 * Validate a model catalog the page sent.
 *
 * The pair matters as much as each number: the SDK refuses an output cap that
 * does not fit inside its context window, and it refuses it at run time, so a
 * pair that cannot work is rejected here where the message can say why.
 * @param value - The `catalog` field of the request body.
 * @returns The catalog, or undefined when the page sent none.
 */
function parseCatalog(value: unknown): readonly WireModel[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('catalog must be an array')
  if (value.length > MAX_CATALOG_MODELS) {
    throw new TypeError(`a catalog holds at most ${String(MAX_CATALOG_MODELS)} models`)
  }
  return value.map((raw): WireModel => {
    const id = field(raw, 'id')
    if (typeof id !== 'string' || !MODEL_ID.test(id)) throw new TypeError('invalid model id in catalog')
    const contextWindow = capacity(field(raw, 'contextWindow'), id, 'context window')
    const maxOutputTokens = capacity(field(raw, 'maxOutputTokens'), id, 'output cap')
    if (contextWindow !== undefined && contextWindow > MAX_CONTEXT_WINDOW) {
      throw new TypeError(`context window for ${id} is beyond ${String(MAX_CONTEXT_WINDOW)}`)
    }
    if (contextWindow !== undefined && contextWindow < MIN_CONTEXT_WINDOW) {
      throw new TypeError(`context window for ${id} is below ${String(MIN_CONTEXT_WINDOW)}`)
    }
    if (maxOutputTokens !== undefined && maxOutputTokens < MIN_OUTPUT_TOKENS) {
      throw new TypeError(`output cap for ${id} is below ${String(MIN_OUTPUT_TOKENS)}`)
    }
    const efforts = parseEfforts(field(raw, 'efforts'), id)
    if (contextWindow !== undefined && maxOutputTokens !== undefined
      && maxOutputTokens >= contextWindow) {
      throw new TypeError(`output cap for ${id} must fit inside its context window`)
    }
    return {
      id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(efforts === undefined ? {} : { efforts }),
    }
  })
}

/** Validate the effort values declared for one catalog model. */
function parseEfforts(value: unknown, id: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !EFFORTS.includes(entry))) {
    throw new TypeError(`invalid reasoning efforts for ${id}`)
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`reasoning efforts for ${id} must be unique`)
  }
  return value
}

/** One capacity field: a positive whole number of tokens, or absent. */
function capacity(value: unknown, id: string, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} for ${id} must be a whole number of tokens`)
  }
  return value
}

/**
 * Validate a roster the page sent.
 *
 * Every field is checked rather than trusted: the roster becomes agent
 * instructions and tool arguments, and a member name is something the model
 * types back when it delegates.
 * @param value - The `team` field of the request body.
 * @returns The roster, or undefined when the page sent none.
 */
function parseTeam(value: unknown): readonly WireMember[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError('team must be an array')
  if (value.length < 2 || value.length > MAX_TEAM_MEMBERS) {
    throw new TypeError(`a team has between 2 and ${String(MAX_TEAM_MEMBERS)} members`)
  }
  const names = new Set<string>()
  let leads = 0
  const members = value.map((raw): WireMember => {
    const name = field(raw, 'name')
    if (typeof name !== 'string' || !MEMBER_NAME.test(name)) {
      throw new TypeError('a member name is 2-24 lowercase letters, digits or dashes')
    }
    if (names.has(name)) throw new TypeError(`duplicate member name: ${name}`)
    names.add(name)
    const role = field(raw, 'role')
    if (role !== undefined && role !== 'lead' && role !== 'peer') {
      throw new TypeError('a member role is lead or peer')
    }
    if (role === 'lead') leads += 1
    const model = field(raw, 'model')
    if (model !== undefined && (typeof model !== 'string' || !MODEL_ID.test(model))) {
      throw new TypeError(`invalid model for member ${name}`)
    }
    const effort = field(raw, 'effort')
    if (effort !== undefined && (typeof effort !== 'string' || !EFFORTS.includes(effort))) {
      throw new TypeError(`invalid effort for member ${name}`)
    }
    const instructions = field(raw, 'instructions')
    if (instructions !== undefined
      && (typeof instructions !== 'string' || instructions.length > MAX_MEMBER_INSTRUCTIONS)) {
      throw new TypeError(`invalid instructions for member ${name}`)
    }
    return {
      name,
      ...(role === undefined ? {} : { role }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(instructions === undefined ? {} : { instructions }),
    }
  })
  // The SDK refuses two leads outright; catching it here names the field.
  if (leads > 1) throw new TypeError('a team has at most one lead')
  return members
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
