/**
 * Session store and the SDK-event → wire-event projection.
 *
 * A "session" is the live half of a conversation: the hydrated agent history,
 * the user-input broker that lets a parked question be answered by a later
 * request, and the abort handle. Everything durable — history snapshot,
 * transcript, model, mode, workspace — lives in SQLite (`conversations.ts`).
 */

import { ToolRegistry } from '@ai-agent-sdk/core/agent'
import type { AgentRunEvent, History } from '@ai-agent-sdk/core/agent'
import { createUserInputBroker } from '@ai-agent-sdk/core'
import type { InteractiveUserInputBroker, UserInputResponse } from '@ai-agent-sdk/core'
import type { ToolCallId } from '@ai-agent-sdk/core'
import {
  appendMessage, ensureConversation, getConversation, loadHistory, nextSeq, saveHistory,
  updateConversation,
} from './conversations'
import { resolveModel } from './registry'
import type { ModelSelection } from './registry'
import { getAgent } from './agents'
import { startRun } from './agent-runtime'
import type { RunMode } from './agent-runtime'
import { getGroup } from './groups'
import { createSampleTools, onCommandOutput, TOOL_LABELS } from './tools'
import { createApprovalPolicy } from './approvals'
import { createIdleWatch } from './resilience'
import type { ApprovalPolicy } from './approvals'
import type { ManagedAgentTeam } from '@ai-agent-sdk/core/agent'
import { EventProjector } from './event-projection'
import type { StoredNode } from './event-projection'
import type { WireApproval, WireApprovalScope, WireEvent } from './wire'

/**
 * Something that happened outside the run's own event stream and still belongs
 * in the transcript: a permission answer, which arrives on its own request.
 */
interface OutboxEntry {
  /** Omitted when the client already rendered the change it made itself. */
  readonly wire?: WireEvent
  readonly node?: StoredNode
}

export interface ChatSession {
  readonly id: string
  readonly history: History
  readonly broker: InteractiveUserInputBroker
  /**
   * Tool families the user permitted "for this session".
   *
   * Owned by the session rather than by a run, so the grant survives from one
   * prompt to the next and is dropped by `forgetSession`.
   */
  readonly sessionGrants: Set<string>
  /** Answers to permission prompts, waiting to be folded into the live run. */
  readonly outbox: OutboxEntry[]
  /** The gate for the run in flight, and the handle `POST /approve` answers. */
  approvals: ApprovalPolicy | undefined
  /**
   * The dynamic-team harness, kept for the whole conversation.
   *
   * A worker outlives the run that spawned it, so the run cannot own the
   * harness: rebuilding it per prompt would strand the previous prompt's
   * workers with nothing left to stop them.
   */
  managed: ManagedAgentTeam | undefined
  /**
   * Where worker events go right now.
   *
   * Re-pointed at each run, because the harness captures its callback once.
   * Between runs it still has somewhere to go — a worker that finishes after
   * the stream closed belongs in the transcript, not in the bin.
   */
  workerSink: ((member: string, event: AgentRunEvent) => void) | undefined
  /** Hands the run in flight a message; absent when nothing is running. */
  steerRun: ((text: string) => boolean) | undefined
  /** Wakes the run generator after another request adds to `outbox`. */
  notify: (() => void) | undefined
  abort: AbortController | undefined
  /** Transcript position for the next persisted node. */
  seq: number
}

interface SessionStore {
  readonly sessions: Map<string, ChatSession>
}

/**
 * A wake-up the run generator can wait on and anyone else can ring.
 *
 * The run's own event stream is not the only thing that produces output: a team
 * member reports through a callback, and permission answers arrive on their own
 * HTTP request. Without this the generator would only ever wake for a LEAD
 * event, and a lead parked in `wait_agents` emits none — so a member's
 * permission prompt would never reach the browser, the member could never be
 * answered, and the lead would wait for it forever.
 *
 * Rings are remembered, so one that lands while nobody is waiting is not lost.
 */
export interface Doorbell {
  ring(): void
  wait(): Promise<void>
}

/** One reason the run generator woke up. */
export type RunStep<L> = { readonly lead: L } | { readonly wake: true }

/**
 * Yield a step for every lead event AND every ring of the doorbell.
 *
 * The `wake` steps are the whole point: they let the consumer flush what other
 * producers queued while the lead is blocked. Iterating the lead alone is what
 * deadlocked team runs — the lead waits inside `wait_agents` for a member, and
 * the member waits for a permission prompt that only a lead event would have
 * flushed.
 * @param lead - The agent-the-user-talks-to event iterator.
 * @param wake - Rung by member events and by answers arriving on other requests.
 * @returns Steps until the lead stream ends.
 */
export async function* runSteps<L>(
  lead: AsyncIterator<L>,
  wake: Doorbell,
): AsyncGenerator<RunStep<L>> {
  let next = lead.next()
  try {
    for (;;) {
      const step = await Promise.race([
        next.then(result => ({ lead: result })),
        wake.wait().then(() => ({ lead: undefined })),
      ])
      if (step.lead === undefined) {
        yield { wake: true }
        continue
      }
      if (step.lead.done === true) return
      yield { lead: step.lead.value }
      next = lead.next()
    }
  } finally {
    // The client disconnecting abandons this generator mid-loop; close the
    // lead rather than leaving it holding the run open.
    await lead.return?.()
  }
}

/** Tracks which team members are working, and projects what they report. */
export interface MemberFeed {
  /** Members currently working; the run closes any left open at teardown. */
  readonly open: Set<string>
  /**
   * Project one member event, bracketing it with lifecycle events.
   * @param member - Who reported.
   * @param event - Their raw SDK event.
   */
  handle(member: string, event: AgentRunEvent): void
}

/**
 * Follow a team's members.
 *
 * A member opens on its first event and closes on its OWN `agent-end`, which is
 * when IT finished — not when the run did. Reporting the end only at the run's
 * teardown left every member shown as busy for the whole rest of the run, long
 * after its work was visibly complete. A member is dropped from `open` rather
 * than flagged done, because it can be woken again and its next event has to
 * reopen it.
 * @param project - The projector turning SDK events into wire events.
 * @param push - Receives every wire event, in order.
 * @returns The feed.
 */
export function createMemberFeed(
  project: EventProjector,
  push: (event: WireEvent) => void,
): MemberFeed {
  const open = new Set<string>()
  return {
    open,
    handle(member, event) {
      if (!open.has(member)) {
        open.add(member)
        push({ t: 'member-start', member })
      }
      for (const wire of project.forMember(member, event)) push(wire)
      if (event.type === 'agent-end') {
        open.delete(member)
        push({ t: 'member-end', member })
      }
    },
  }
}

/**
 * Keep reporting while a lead's workers are still running.
 *
 * A worker outlives the run that spawned it, so the lead finishing is not the
 * conversation finishing. Closing the stream there would leave the user with an
 * answer and no sign of the two agents still working behind it — they would only
 * find out on their next prompt.
 *
 * Stops as soon as a NEW run takes over the conversation: two streams draining
 * the same outbox and numbering the same transcript would interleave.
 * @param live - The conversation's live state.
 * @param controller - This run's abort handle, and its claim on the session.
 * @param wake - Rung by worker events and by the run's heartbeat.
 * @param queued - Wire events waiting to go out.
 * @param project - The run's projector, for the nodes to persist.
 * @param persist - Appends one settled node to the transcript.
 * @param drainOutbox - Flushes anything another request queued.
 * @returns Progress and worker events until they settle.
 */
export async function* followWorkers(
  live: ChatSession,
  controller: AbortController,
  wake: Doorbell,
  queued: WireEvent[],
  project: EventProjector,
  persist: (node: StoredNode) => Promise<void>,
  drainOutbox: () => AsyncGenerator<WireEvent>,
): AsyncGenerator<WireEvent> {
  let reported = false
  let lastProgress: string | undefined
  for (;;) {
    const managed = live.managed
    if (managed === undefined) break
    if (controller.signal.aborted || live.abort !== controller) break
    // The ROSTER, not just the workers: a worker finishing wakes the lead for
    // a follow-up turn, and that turn is the synthesis. Watching only the
    // workers would close the stream at the exact moment the lead started
    // writing it.
    // `pending` counts as busy: a worker held until its dependencies settle has
    // not started, let alone finished. Watching only `running` would end the
    // stream while the queued half of the plan was still to come.
    const busy = managed.team.members()
      .filter(member => member.status === 'running' || member.status === 'pending')
    if (busy.length === 0) break
    reported = true
    // Only when it CHANGES. The doorbell rings on every worker event, and three
    // busy workers ring it many times a second; re-sending the same line each
    // time sent 189 identical events in one measured run. The client counts the
    // elapsed seconds itself, so an unchanged line carries no new information —
    // it is pure traffic, and it buries everything else in the stream.
    const message = `Waiting for ${busy.map(member => member.name).join(', ')}`
    if (message !== lastProgress) {
      lastProgress = message
      yield { t: 'progress', message }
    }
    // The run's heartbeat rings this every few seconds, and every worker event
    // rings it immediately, so this is neither a spin nor a fixed poll.
    await wake.wait()
    while (queued.length > 0) yield queued.shift() as WireEvent
    yield* drainOutbox()
    for (const node of project.flush()) await persist(node)
  }
  while (queued.length > 0) yield queued.shift() as WireEvent
  yield* drainOutbox()
  for (const node of project.flush()) await persist(node)
  if (reported) yield { t: 'progress', message: null }

  // Release the settled workers' slots.
  //
  // The SDK keeps a finished worker addressable, and occupying one of
  // `maxWorkers`, until something closes it — that is what makes `close_agent`
  // worth calling. This app holds the harness for the whole conversation, so a
  // lead that forgets to close would exhaust the cap after a few prompts and
  // every later spawn would fail. Their answers are already in the lead's
  // history and in the transcript, so nothing is lost by reclaiming the slot.
  const settled = live.managed
  if (settled !== undefined && live.abort === controller) {
    for (const worker of settled.workers()) {
      // A pending worker has not run yet; closing it would silently delete the
      // step the lead had queued behind another one.
      if (worker.status === 'running' || worker.status === 'pending') continue
      await settled.closeWorker(worker.name).catch(() => undefined)
    }
  }
}

/**
 * Build a doorbell.
 * @returns The ring/wait pair.
 */
export function createDoorbell(): Doorbell {
  let rung = false
  let open: (() => void) | undefined
  return {
    ring() {
      const waiter = open
      open = undefined
      // Remember the ring ONLY when nobody heard it. Setting the flag as well
      // as waking a waiter would spend the same ring twice, waking the run a
      // second time for work that was already flushed.
      if (waiter === undefined) rung = true
      else waiter()
    },
    async wait() {
      if (rung) {
        rung = false
        return
      }
      await new Promise<void>((resolve) => { open = resolve })
    },
  }
}

/**
 * One tool registry per workspace root, at MODULE scope on purpose: a hot
 * reload must rebuild tool definitions, while live sessions (below) must
 * survive it.
 */
const toolsByRoot = new Map<string, ToolRegistry>()

/**
 * The lead's address in a dynamic team.
 *
 * Shared with `agent-runtime`'s `createManagedAgentTeam({ leadName: 'lead' })`:
 * the team reports every member through one observer, and this is how the
 * agent the user talks to is told apart from the workers it created.
 */
const LEAD_NAME = 'lead'

const STORE_KEY = Symbol.for('@chat-agents/backend.sessions')

/** Module-level store that survives Next.js dev hot reloads. */
function store(): SessionStore {
  const holder = globalThis as unknown as Record<symbol, SessionStore | undefined>
  const existing = holder[STORE_KEY]
  if (existing !== undefined) return existing
  const created: SessionStore = { sessions: new Map() }
  holder[STORE_KEY] = created
  return created
}

function toolsFor(root: string): ToolRegistry {
  const existing = toolsByRoot.get(root)
  if (existing !== undefined) return existing
  const created = createSampleTools(root)
  toolsByRoot.set(root, created)
  return created
}

/**
 * Fetch or create one live session, hydrating its history from SQLite.
 *
 * This is the ONLY thing that creates a conversation row, and the row it
 * creates decides which project — and therefore which directory the agent
 * writes to — the conversation belongs to for the rest of its life. An omitted
 * `groupId` means the default project, so any caller that could be the FIRST
 * to touch a new conversation must pass the group the user has open. The
 * callers that omit it (`answer`, `approve`, `abortRun`, `pendingApprovals`)
 * are safe only because they act on a run already in flight, which means the
 * row already exists.
 * @param id - Conversation id.
 * @param groupId - Owning project; omitted uses the default one.
 * @returns The live session.
 */
export async function session(id: string, groupId?: string): Promise<ChatSession> {
  const { sessions } = store()
  const group = await getGroup(groupId)
  await ensureConversation(id, {
    mode: 'basic',
    workspaceRoot: group.workspaceRoot,
    groupId: group.id,
  })
  const existing = sessions.get(id)
  if (existing !== undefined) return existing
  const created: ChatSession = {
    id,
    history: await loadHistory(id),
    broker: createUserInputBroker(),
    sessionGrants: new Set<string>(),
    outbox: [],
    approvals: undefined,
    managed: undefined,
    workerSink: undefined,
    steerRun: undefined,
    notify: undefined,
    abort: undefined,
    seq: await nextSeq(id),
  }
  sessions.set(id, created)
  return created
}

/**
 * Drop a session's live state, so the next touch re-reads SQLite.
 * @param id - Conversation id.
 */
export function forgetSession(id: string): void {
  const { sessions } = store()
  const live = sessions.get(id)
  live?.abort?.abort(new Error('conversation closed'))
  live?.approvals?.broker.abortAll()
  // Nothing else ends a detached worker: the run it came from is long over.
  void live?.managed?.dispose(new Error('conversation closed'))
  sessions.delete(id)
}

/**
 * Answer a parked question.
 * @param id - Conversation id.
 * @param requestId - The provider tool-call id carried by the question event.
 * @param answers - One answer string per question id.
 * @returns Whether a waiter was actually resolved.
 */
export async function answer(
  id: string,
  requestId: string,
  answers: Readonly<Record<string, string>>,
): Promise<boolean> {
  const response: UserInputResponse = {
    answers: Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [key, { answers: [value] }]),
    ),
  }
  const live = await session(id)
  return live.broker.resolve(requestId as ToolCallId, response)
}

/**
 * Answer a parked permission prompt.
 *
 * The decision is recorded and the call released here; the transcript row and
 * the `approval-resolved` event are queued on the session, because the run
 * generator — not this request — owns the event order the client sees.
 * @param id - Conversation id.
 * @param callId - The call carried by the `approval` event.
 * @param decision - Allow it, refuse this call, or withdraw the turn.
 * @param scope - How far an `allow` reaches; ignored otherwise.
 * @returns Whether a parked call was actually released.
 */
export async function approve(
  id: string,
  callId: string,
  decision: 'allow' | 'deny' | 'abort',
  scope: WireApprovalScope = 'once',
): Promise<boolean> {
  const live = await session(id)
  const policy = live.approvals
  if (policy === undefined) return false
  const prompt = await policy.decide(callId, decision, scope)
  if (prompt === undefined) return false
  live.outbox.push({
    wire: { t: 'approval-resolved', callId, decision, scope },
    node: { ...prompt, kind: 'approval', id: callId, decision, scope },
  })
  live.notify?.()
  return true
}

/**
 * Steer the run in flight.
 *
 * The message joins the agent's history immediately, so the next model round
 * of the turn already in progress reads it — the user does not have to stop
 * the agent and start again to correct its course. It is queued for the
 * transcript the same way a permission answer is, because the run generator
 * owns the order the client sees.
 * @param id - Conversation id.
 * @param text - What the user typed while the agent was working.
 * @returns Whether a run was there to receive it.
 */
export async function steer(id: string, text: string): Promise<boolean> {
  const live = await session(id)
  const trimmed = text.trim()
  if (live.steerRun === undefined || trimmed === '') return false
  if (!live.steerRun(trimmed)) return false
  live.outbox.push({ node: { kind: 'user', id: `u_${String(live.seq)}_steer`, text: trimmed } })
  live.notify?.()
  return true
}

/**
 * The permission prompts this conversation is still waiting on.
 *
 * A pending prompt is never written to the transcript, so this is how a page
 * reload finds the card it has to re-render.
 * @param id - Conversation id.
 * @returns The open prompts.
 */
export async function pendingApprovals(id: string): Promise<readonly WireApproval[]> {
  const live = await session(id)
  return live.approvals?.pending() ?? []
}

/**
 * Cancel the session's in-flight run, if any.
 * @param id - Conversation id.
 * @returns Whether a run was cancelled.
 */
export async function abortRun(id: string): Promise<boolean> {
  const live = await session(id)
  if (live.abort === undefined) return false
  live.abort.abort(new Error('cancelled by the user'))
  live.abort = undefined
  live.broker.abortAll()
  // A parked approval holds the run open on its own promise; cancelling the
  // signal is not enough to settle it.
  live.approvals?.broker.abortAll()
  return true
}


/**
 * Run one prompt and project the SDK's event stream into wire events.
 *
 * Deltas are folded into settled nodes as they close, and each settled node is
 * appended to the conversation's stored transcript, so a reload replays the
 * same rendering without re-running the model.
 * @param id - Conversation id.
 * @param prompt - The user's message.
 * @returns An async iterable of wire events, ending with `run-end` or `error`.
 */
export async function* runPrompt(
  id: string,
  prompt: string,
  groupId?: string,
): AsyncGenerator<WireEvent> {
  const live = await session(id, groupId)
  const conversation = await getConversation(id)
  const group = await getGroup(conversation?.groupId)
  // The conversation's own workspace wins; a conversation created before the
  // group existed falls back to the group's directory.
  const workspaceRoot = conversation?.workspaceRoot ?? group.workspaceRoot
  const agent = conversation?.agentId == null ? undefined : await getAgent(conversation.agentId)
  const mode = ((conversation?.mode ?? agent?.mode ?? 'basic')) as RunMode
  const selection: ModelSelection | undefined =
    conversation?.provider != null && conversation.model != null
      ? { provider: conversation.provider, model: conversation.model }
      : agent?.provider != null && agent.model != null
        ? { provider: agent.provider, model: agent.model }
        : undefined
  const effort = conversation?.reasoningEffort ?? agent?.reasoningEffort ?? undefined

  const controller = new AbortController()
  live.abort = controller
  const runId = `run_${Date.now().toString(36)}`

  const persist = async (node: StoredNode): Promise<void> => {
    await appendMessage(id, live.seq, node.kind, node)
    live.seq += 1
  }

  let model
  try {
    model = await resolveModel(selection)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'run-start', runId, members: [] }
    yield { t: 'error', message }
    return
  }

  await persist({ kind: 'user', id: `u_${String(live.seq)}`, text: prompt })
  if (conversation?.title === 'New chat') {
    await updateConversation(id, { title: prompt.slice(0, 60) })
  }

  // Member events arrive through a callback rather than the lead's stream, so
  // they are queued here and drained into the same wire order.
  const queued: WireEvent[] = []
  // One gate per run, over grants that outlive the run: the broker only has to
  // survive the calls it parks, while the session's answers must not be
  // re-asked on the next prompt.
  const policy = createApprovalPolicy({ workspaceRoot, sessionGrants: live.sessionGrants })
  live.approvals = policy
  const project = new EventProjector({ approval: callId => policy.prompt(callId) })

  const wake = createDoorbell()

  const feed = createMemberFeed(project, (event) => { queued.push(event) })
  const onMemberEvent = (member: string, event: AgentRunEvent): void => {
    if (member === LEAD_NAME) {
      // The agent the user is talking to, reporting a turn it was woken for
      // after a worker finished. Projected as the lead so its synthesis reads
      // at the top level rather than inside a subagent panel.
      for (const wire of project.forLead(event)) queued.push(wire)
    } else {
      feed.handle(member, event)
    }
    // Wake the generator itself. A member's permission prompt must reach the
    // browser while its lead is blocked waiting for that very member.
    wake.ring()
  }

  let handles
  try {
    handles = await startRun(prompt, {
      registry: model.registry,
      provider: model.config.provider,
      model: model.config.model,
      effort: effort ?? undefined,
      mode,
      workspaceRoot,
      groupId: group.id,
      workspaceTools: toolsFor(workspaceRoot),
      userInput: live.broker,
      // A retry the user cannot see is indistinguishable from a hang, which is
      // the thing the retry is supposed to fix.
      onRetry: (notice) => {
        const message = `${notice.failure.message} — retrying (${String(notice.attempt)}/${String(notice.maxAttempts)}) in ${String(Math.round(notice.delayMs / 100) / 10)}s`
        live.outbox.push({
          wire: { t: 'notice', level: 'warn', message },
          node: { kind: 'notice', id: `n_${String(live.seq)}`, level: 'warn', message },
        })
        wake.ring()
      },
      approvals: policy.broker,
      ...live.managed === undefined ? {} : { managedTeam: live.managed },
      // One stable indirection for the harness to capture, so a worker
      // reporting during a LATER prompt is not delivered to this run.
      onWorkerEvent: (member, event) => { live.workerSink?.(member, event) },
      interceptors: [policy.interceptor],
      agent,
      history: live.history,
      signal: controller.signal,
    }, onMemberEvent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'run-start', runId, members: [] }
    yield { t: 'error', message }
    return
  }

  if (handles.result !== undefined) project.deferOutcomeToHandle()
  // Open the steering channel only once the run exists, so a message typed
  // between prompts is a new prompt rather than a silent no-op.
  live.steerRun = handles.steer
  live.notify = () => { wake.ring() }
  if (handles.managedTeam !== undefined) live.managed = handles.managedTeam
  live.workerSink = onMemberEvent
  yield { t: 'run-start', runId, members: handles.members }

  // A permission answer arrives on its own HTTP request while this generator
  // is parked on the tool call it releases, so it is folded in here — the
  // approved call's own result is the next lead event, which puts the decision
  // row immediately before it.
  const drainOutbox = async function* (): AsyncGenerator<WireEvent> {
    while (live.outbox.length > 0) {
      const entry = live.outbox.shift() as OutboxEntry
      if (entry.node !== undefined) await persist(entry.node)
      if (entry.wire !== undefined) yield entry.wire
    }
  }

  // A quiet run is not a broken run — a reasoning model is silent before its
  // first token and a build is silent for minutes — so this reports what the
  // run is waiting on rather than accusing it of being stuck, and never ends
  // it. Every operation it could be inside is already bounded by the SDK; what
  // is missing is only the telling.
  const idle = createIdleWatch()
  /** Tools currently in flight, so the report can name what it is waiting on. */
  const inFlight = new Map<string, string>()
  let reporting = false
  const heartbeat = setInterval(() => { wake.ring() }, 5_000)
  // A timer must never be the reason a Node process stays alive.
  heartbeat.unref?.()

  // Live command output. The bus is module-wide because tool registries are
  // shared per workspace, so this filters to the calls THIS run has open —
  // another conversation in the same folder must not have its build narrated
  // into this transcript.
  const unwatchOutput = onCommandOutput((callId, chunk) => {
    if (!inFlight.has(callId)) return
    queued.push({ t: 'tool-output', id: callId, chunk })
    wake.ring()
  })

  /** Note activity and, on a wake with nothing new, what is still running. */
  // Says WHAT, never how long: the client owns elapsed time, because a
  // number that only moves when the server speaks looks frozen between
  // reports, and two clocks in one line would disagree.
  const progress = (): WireEvent => {
    const running = [...inFlight.values()]
    const what = running.length === 0
      ? 'Thinking'
      : `Running ${running.map(name => TOOL_LABELS[name] ?? name).join(', ')}`
    return { t: 'progress', message: what }
  }

  try {
    for await (const step of runSteps(handles.events[Symbol.asyncIterator](), wake)) {
      // Activity is recorded BEFORE the silence is judged. The other order
      // measures the gap the arriving event just ended and reports it as a
      // problem, which warns precisely when the run is working again.
      // A member reporting counts too: a team run is alive as long as ANY of
      // its agents is producing, not only the one the user talks to.
      const active = 'lead' in step || queued.length > 0 || live.outbox.length > 0
      if (active) {
        idle.touch(Date.now())
        if (reporting) {
          reporting = false
          yield { t: 'progress', message: null }
        }
      }
      // Whatever another producer queued goes out first, in arrival order.
      while (queued.length > 0) {
        const pending = queued.shift() as WireEvent
        yield pending
      }
      yield* drainOutbox()
      if ('lead' in step) {
        for (const wire of project.forLead(step.lead)) {
          if (wire.t === 'tool-call') inFlight.set(wire.id, wire.name)
          if (wire.t === 'tool-result') inFlight.delete(wire.id)
          yield wire
        }
      }
      if (!active) {
        const waitingOnUser = policy.pending().length > 0 || live.broker.pending().length > 0
        const verdict = idle.check(Date.now(), waitingOnUser)
        if (verdict.kind === 'report') {
          reporting = true
          void verdict.silentMs
          yield progress()
        }
      }
    }
    if (reporting) yield { t: 'progress', message: null }
    while (queued.length > 0) {
      const pending = queued.shift() as WireEvent
      yield pending
    }
    yield* drainOutbox()
    for (const node of project.flush()) await persist(node)
    // The session shapes report their outcome once the stream ends; the
    // single-agent loop already emitted `agent-end`, which the projector turned
    // into `run-end`.
    if (handles.result !== undefined) {
      const response = await handles.result
      const reason = response.outcome.reason
      if (reason.kind === 'error') {
        const message = reason.failure.message
        await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
        yield { t: 'error', message }
      }
      yield { t: 'run-end', reason: reason.kind, text: response.text }
    }

    // The lead can answer while its workers are still going — that is what a
    // non-blocking spawn buys. The stream stays open until they settle so the
    // user watches them finish instead of finding out on the next prompt. The
    // harness is not disposed either way; this only decides how long anyone is
    // listening.
    yield* followWorkers(live, controller, wake, queued, project, persist, drainOutbox)

    // Only members still open here — one cancelled, or one whose `agent-end`
    // never arrived. The rest closed when they actually finished.
    for (const member of feed.open) yield { t: 'member-end', member }
    feed.open.clear()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'error', message }
  } finally {
    clearInterval(heartbeat)
    unwatchOutput()
    // An answer that landed as the run was tearing down still belongs in the
    // transcript, even though there is no longer a stream to yield it on.
    for (const entry of live.outbox.splice(0)) {
      if (entry.node !== undefined) await persist(entry.node)
    }
    for (const node of project.flush()) await persist(node)
    for (const node of project.settled()) await persist(node)
    await saveHistory(id, live.history)
    await handles.close()
    live.steerRun = undefined
    live.notify = undefined
    // Reached only when a worker is STILL going after all that — the client
    // disconnected, or a new prompt took the conversation over. Its report is
    // written to the transcript so a reload shows it; it is deliberately not
    // queued for the next stream, where it would arrive out of order among
    // that run's own events.
    live.workerSink = (member, event) => {
      const closing = new EventProjector()
      void closing.forMember(member, event)
      for (const node of closing.flush()) void persist(node)
    }
    if (live.abort === controller) live.abort = undefined
  }
}
