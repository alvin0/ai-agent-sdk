/**
 * Session store and the SDK-event → wire-event projection.
 *
 * A "session" is the live half of a conversation: the hydrated agent history,
 * the user-input broker that lets a parked question be answered by a later
 * request, and the abort handle. Everything durable — history snapshot,
 * transcript, model, mode, workspace — lives in SQLite (`conversations.ts`).
 */

import { ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import type { AgentRunEvent, History } from '@alvin0/ai-agent-sdk-core/agent'
import { createUserInputBroker, createUserMessage } from '@alvin0/ai-agent-sdk-core'
import type { InteractiveUserInputBroker, UserInputResponse } from '@alvin0/ai-agent-sdk-core'
import type { AgentInput, ContentBlock, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { AttachmentRejected, projectAttachments } from './attachments'
import {
  appendMessage, ensureConversation, getConversation, loadHistory, nextSeq, saveHistory,
  updateConversation,
} from './conversations'
import { resolveModel, supportedEffort } from './registry'
import type { ModelSelection, ResolvedModel } from './registry'
import { getAgent, listAgents } from './agents'
import { listAvailableSkills, resolveSkillMentions } from './skill-catalog'
import { instructionsInForce, startRun } from './agent-runtime'
import type { RunMode } from './agent-runtime'
import { getGroup } from './groups'
import { createSampleTools, onCommandOutput, TOOL_LABELS } from './tools'
import { createApprovalPolicy } from './approvals'
import { createIdleWatch } from './resilience'
import type { ApprovalPolicy } from './approvals'
import type { ManagedAgentTeam } from '@alvin0/ai-agent-sdk-core/agent'
import { addToTally, recordUsage, turnShortfall, usageOf } from './usage'
import type { UsageTally } from './usage'
import { EventProjector } from './event-projection'
import { RunTrace } from './traces'
import { recordProviderCalls } from './provider-calls'
import type { CallFingerprint, CallSink } from './provider-calls'
import type { StoredNode } from './event-projection'
import type {
  WireApiCall, WireApproval, WireApprovalScope, WireAttachment, WireEvent, WireQuestion,
} from './wire'

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
  /**
   * Set when the user steered, cleared when a model round starts.
   *
   * Still set once the run has ended means the message arrived after the last
   * round: nothing read it, and nothing ever will unless the run is continued.
   */
  steerUnread: boolean
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
    if (busy.length === 0) {
      // Everyone LOOKS idle — but a worker's last event fires before its run
      // resolves, and the report that wakes the lead is delivered after that.
      // Believing the roster in that gap is what closed the stream one instant
      // before the synthesis, leaving the conversation ending on a worker.
      try {
        await managed.whenQuiet(controller.signal)
      } catch {
        // Aborted, or a harness without the wait: fall through and stop.
      }
      const stillBusy = managed.team.members()
        .some(member => member.status === 'running' || member.status === 'pending')
      if (!stillBusy) break
      continue
    }
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
    steerUnread: false,
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
 * @param scope - How long an `allow` lasts; ignored otherwise.
 * @param ruleKey - Which rule the prompt offered an `allow` is remembered
 *   under; ignored for scope `once`, and defaults to the narrowest rule.
 * @returns Whether a parked call was actually released.
 */
/**
 * Runs a newer prompt took over, marked at the moment of takeover.
 *
 * A `WeakSet` rather than a flag on the session: the displaced run needs the
 * answer about ITSELF, long after the session has moved on to another run.
 */
const displacedRuns = new WeakSet<AbortController>()
// Cancellation clears the public abort slot before its stream has unwound.
// Retain ownership independently so a subsequent prompt still supersedes it.
const runOwners = new WeakMap<ChatSession, AbortController>()

export async function approve(
  id: string,
  callId: string,
  decision: 'allow' | 'deny' | 'abort',
  scope: WireApprovalScope = 'once',
  ruleKey?: string,
): Promise<boolean> {
  const live = await session(id)
  const policy = live.approvals
  if (policy === undefined) return false
  const outcome = await policy.decide(callId, decision, scope, ruleKey)
  if (outcome === undefined) return false
  // The rule reported back is the one the POLICY settled on, not the one the
  // client asked for: the record has to say what was actually remembered.
  const settled = outcome.ruleKey
  const remembered = settled === undefined ? {} : { ruleKey: settled }
  live.outbox.push({
    wire: { t: 'approval-resolved', callId, decision, scope, ...remembered },
    node: { ...outcome.prompt, kind: 'approval', id: callId, decision, scope, ...remembered },
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
export async function steer(
  id: string,
  text: string,
  skillIds: readonly string[] = [],
): Promise<boolean> {
  const live = await session(id)
  const trimmed = text.trim()
  const steerRun = live.steerRun
  const owner = runOwners.get(live)
  if (steerRun === undefined || trimmed === '') return false
  // `/` means the same thing mid-run as it does at the start. Steering was the
  // one path where the composer offered the menu and the mention then arrived
  // as bare text the model had no reason to act on.
  const conversation = await getConversation(id)
  const group = await getGroup(conversation?.groupId)
  const workspaceRoot = conversation?.workspaceRoot ?? group.workspaceRoot
  const mentioned = trimmed.includes('/') || skillIds.length > 0
    ? resolveSkillMentions(
      trimmed,
      await listAvailableSkills({ groupId: group.id, workspaceRoot }),
      skillIds,
    )
    : { skills: [] as const, directive: undefined }
  const forModel = mentioned.directive === undefined
    ? trimmed
    : `${mentioned.directive}\n\n${trimmed}`
  if (live.steerRun !== steerRun || runOwners.get(live) !== owner || !steerRun(forModel)) return false
  live.steerUnread = true
  // The transcript shows what was typed; the directive was for the model.
  live.outbox.push({
    node: {
      kind: 'user',
      id: `u_${String(live.seq)}_steer`,
      text: trimmed,
      ...mentioned.skills.length === 0
        ? {}
        : { skills: mentioned.skills.map(skill => skill.id) },
    },
  })
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
 * The questions this conversation is still waiting on.
 *
 * The same reason as {@link pendingApprovals}: a question is written to the
 * transcript only once it has been answered, so a reload while one is open
 * would find no card — and the run stays parked on an answer the user has no
 * way to give. A count was not enough; the card needs the questions.
 * @param id - Conversation id.
 * @returns The open questions, shaped as the client renders them.
 */
export async function pendingQuestions(id: string): Promise<readonly {
  readonly requestId: string
  readonly questions: readonly WireQuestion[]
}[]> {
  const live = await session(id)
  return live.broker.pending().map(request => ({
    requestId: String(request.requestId),
    questions: request.questions.map(question => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map(option => ({
        label: option.label,
        description: option.description,
      })),
    })),
  }))
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
 * Refuse a prompt whose images the chosen model cannot see.
 *
 * The runtime already has an answer for this: it replaces images with an
 * "image omitted" note so the request still succeeds. That is right for a long
 * conversation being summarized by a cheaper text model, and wrong here — "read
 * the total on this receipt" does not become a different, answerable question
 * by removing the receipt. A request that runs is not the same as a request
 * that was understood, so the mismatch is reported to the user, who can pick a
 * model that takes images or drop the attachment.
 * @param model - The resolved route this turn would run on.
 * @param records - Attachments admitted for this prompt.
 * @throws Error naming the model when it declares no image input.
 */
async function refuseImagesOnTextOnlyModel(
  model: ResolvedModel,
  records: readonly WireAttachment[],
): Promise<void> {
  if (!records.some(record => record.kind === 'image')) return
  let modalities: readonly string[] | undefined
  try {
    modalities = (await model.registry.resolveModelInfo(model.config.provider, model.config.model))
      .inputModalities
  } catch {
    // A route whose metadata cannot be resolved is not evidence of anything.
    // Sending is the better failure: the provider says no in its own words.
    return
  }
  if (modalities === undefined || modalities.includes('image')) return
  throw new Error(
    `${model.config.model} does not accept images.`
    + ' Pick a model with vision, or remove the attached images before sending.',
  )
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
  attachmentIds: readonly string[] = [],
  skillIds: readonly string[] = [],
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
  const rememberedEffort = conversation?.reasoningEffort ?? agent?.reasoningEffort ?? undefined

  // A second prompt takes the conversation over rather than running beside the
  // first. Two runs on one conversation share its history and its transcript
  // counter, so leaving both alive splices two dialogues into one and neither
  // is readable afterwards — and the session shapes refuse the second outright.
  if (live.abort !== undefined) {
    // Marked HERE, where the displacement actually happens, and not inferred
    // later from whoever holds the slot: the displaced run can still be
    // unwinding after this one has finished and cleared the slot, and a check
    // made at that point sees an idle conversation and concludes, wrongly, that
    // nothing replaced it.
    displacedRuns.add(live.abort)
    live.abort.abort(new Error('a newer prompt took the conversation over'))
    // Tell the MODEL that the earlier request was withdrawn.
    //
    // Aborting ends the run, but the instruction it was carrying out stays in
    // history as the last thing the user asked for, and the next prompt lands
    // right after it. A model reading two consecutive user messages reasonably
    // does the first one — which is how "count to twenty", cancelled and
    // replaced, still came back as a count to twenty. The note is written once,
    // between the withdrawn request and the one replacing it, and is attributed
    // to the app rather than to the user, who did not type it.
    live.history.append({
      kind: 'user',
      message: createUserMessage({
        content: [{
          type: 'text',
          text: 'Note from the application: the user withdrew the previous request before it was '
            + 'answered, and replaced it with the message that follows. Do not carry out the '
            + 'withdrawn request. Answer only the new one.',
        }],
        source: { kind: 'app', producer: 'chat-agents.takeover' },
      }),
    })
  }
  const controller = new AbortController()
  const previousOwner = runOwners.get(live)
  if (previousOwner !== undefined) displacedRuns.add(previousOwner)
  runOwners.set(live, controller)
  live.abort = controller
  const runId = `run_${Date.now().toString(36)}`

  const persist = async (node: StoredNode): Promise<void> => {
    await appendMessage(id, live.seq, node.kind, node)
    live.seq += 1
  }

  /**
   * Where a finished provider call goes.
   *
   * The recorder has to be installed on the registry before the first call,
   * which is before the trace it feeds exists — so calls land in a buffer and
   * the sink is replaced once there is a trace and a stream to send on.
   */
  const recordedCalls: { call: WireApiCall; id: CallFingerprint }[] = []
  let onProviderCall: CallSink = (call, callId) => { recordedCalls.push({ call, id: callId }) }
  const recorder = recordProviderCalls((call, callId) => { onProviderCall(call, callId) })

  let model
  let effort: string | undefined
  try {
    model = await resolveModel(selection, recorder)
    // The conversation's remembered effort against the model it actually ran
    // on. Switching a conversation to a model with a different ladder — or
    // none — otherwise fails every later prompt with a provider rejection.
    effort = await supportedEffort(model.registry, model.config, rememberedEffort ?? undefined)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'run-start', runId, members: [] }
    yield { t: 'error', message }
    return
  }

  // Attachments are resolved BEFORE the turn starts, and a refusal ends it
  // here. A run that has already spent a model call cannot un-send it, and a
  // prompt whose picture was silently dropped is answered confidently about
  // something the model never saw.
  let attached: { records: readonly WireAttachment[]; blocks: readonly ContentBlock[] }
  try {
    attached = projectAttachments(attachmentIds)
    await refuseImagesOnTextOnlyModel(model, attached.records)
  } catch (error) {
    const message = error instanceof AttachmentRejected || error instanceof Error
      ? error.message
      : String(error)
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'run-start', runId, members: [] }
    yield { t: 'error', message }
    return
  }

  /**
   * The run's execution trace, for the trace view.
   *
   * Fed the same raw events as the transcript projector, and separately: a span
   * is not a transcript node, and the transcript is not a record of how long
   * each step took or what nested inside what.
   *
   * Built this early because the harness's own preparation — the instruction
   * files, the skill catalogue — happens before the loop starts and is part of
   * what explains the run.
   */
  const trace = new RunTrace(id, runId, prompt)

  // The project's conventions files. Recorded even when there are none: a run
  // that read no AGENTS.md is the answer to "why did it ignore our rules", and
  // an empty list says it where silence could not.
  const instructionsAt = Date.now()
  try {
    const instructions = await instructionsInForce(workspaceRoot)
    trace.note({
      name: 'instructions',
      startedAt: instructionsAt,
      durationMs: Date.now() - instructionsAt,
      attributes: {
        'agent.instructions.files': instructions.files.length,
        'agent.instructions.candidates': instructions.fileNames.join(', '),
        'agent.instructions.project_root': instructions.projectRoot,
      },
      output: {
        projectRoot: instructions.projectRoot,
        candidates: instructions.fileNames,
        files: instructions.files.map(file => ({
          path: file.path,
          bytes: file.bytes,
          firstLine: file.firstLine,
          ...file.global === true ? { global: true } : {},
        })),
      },
    })
  } catch (error) {
    trace.note({
      name: 'instructions',
      startedAt: instructionsAt,
      durationMs: Date.now() - instructionsAt,
      output: undefined,
      error: { type: 'InstructionsUnreadable', message: error instanceof Error ? error.message : String(error) },
    })
  }

  // Skills the user named with `/` in the composer, resolved against the
  // catalogue rather than by parsing alone, so `/etc/passwd` cannot invent one.
  //
  // The catalogue is scanned for EVERY run now, not only for a prompt with a
  // `/` in it: which skills a run could see is part of explaining what it did,
  // and the scan is the same directory walk the composer already does.
  const catalogueAt = Date.now()
  const catalogue = await listAvailableSkills({ groupId: group.id, workspaceRoot }, controller.signal)
  const mentioned = prompt.includes('/') || skillIds.length > 0
    ? resolveSkillMentions(prompt, catalogue, skillIds)
    : { skills: [] as const, directive: undefined }
  trace.note({
    name: 'skills',
    startedAt: catalogueAt,
    durationMs: Date.now() - catalogueAt,
    attributes: {
      'agent.skills.discovered': catalogue.length,
      'agent.skills.named': mentioned.skills.map(skill => skill.id).join(', '),
    },
    output: {
      named: mentioned.skills.map(skill => skill.id),
      discovered: catalogue.map(skill => ({
        id: skill.id,
        name: skill.name,
        provider: skill.provider,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
      })),
    },
  })

  await persist({
    kind: 'user',
    id: `u_${String(live.seq)}`,
    text: prompt,
    ...attached.records.length === 0 ? {} : { attachments: attached.records },
    // Recorded on the message rather than only acted on: a run that behaved
    // oddly is read back later, and "which skills did this prompt ask for" is
    // the first question about it.
    ...mentioned.skills.length === 0
      ? {}
      : { skills: mentioned.skills.map(skill => skill.id) },
  })
  if (conversation?.title === 'New chat') {
    // An attachment-only prompt has no words to name the conversation with, so
    // the first file's name stands in rather than leaving it "New chat".
    const title = prompt.trim() === '' && attached.records[0] !== undefined
      ? attached.records[0].name
      : prompt.slice(0, 60)
    await updateConversation(id, { title })
  }

  // The directive goes to the MODEL, not into the stored user message: the user
  // wrote a prompt, and a transcript that quoted an instruction back at them
  // would be putting words in their mouth. It leads the text so the model reads
  // "load this skill" before the request it applies to.
  const forModel = mentioned.directive === undefined
    ? prompt
    : `${mentioned.directive}\n\n${prompt}`

  // One text block plus the attachment blocks, in pick order. A prompt with
  // nothing attached stays a bare string, which is the shape every shape in
  // `startRun` already accepted.
  const input: AgentInput = attached.blocks.length === 0
    ? forModel
    : createUserMessage({
      content: [
        ...forModel.trim() === '' ? [] : [{ type: 'text', text: forModel } as const],
        ...attached.blocks,
      ],
      source: { kind: 'user' },
    })

  /**
   * What this run has already recorded, per member.
   *
   * Two sources report the same tokens — the per-call events and the turn's own
   * report — so the second only records what the first did not.
   */
  const tally: UsageTally = new Map()

  /**
   * Each team member's route, by member name.
   *
   * Filled once the roster is known — after `startRun` — which is before any
   * member can report usage, so a lookup here is never premature.
   */
  const memberRoutes = new Map<string, { provider: string; model: string; effort?: string }>()

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

  // The trace and the stream both exist now, so recorded calls can go where
  // they belong. Whatever the first rounds recorded while the buffer was in
  // place is drained through the same path.
  onProviderCall = (call, callId) => {
    for (const wire of trace.attachCall(call, callId)) queued.push(wire)
    wake.ring()
  }
  for (const buffered of recordedCalls.splice(0)) onProviderCall(buffered.call, buffered.id)

  const feed = createMemberFeed(project, (event) => { queued.push(event) })
  const onMemberEvent = (member: string, event: AgentRunEvent): void => {
    // A member's spend is the user's spend, and it is attributed to the route
    // the member actually ran on: a preset may override the conversation's
    // model, so charging its tokens to the lead's model would be a lie.
    const route = memberRoutes.get(member)
    const memberContext = {
      conversationId: id,
      groupId: group.id,
      runId,
      provider: route?.provider ?? model.config.provider,
      model: route?.model ?? model.config.model,
      effort: route?.effort ?? effort ?? undefined,
      // A turn the lead was woken for is still the lead, not a worker.
      ...member === LEAD_NAME ? {} : { member },
    }
    // The lead keeps ONE tally whichever path its events arrive on: a woken
    // turn counted under a second key would reconcile against an empty one.
    const tallyKey = member === LEAD_NAME ? undefined : member
    const streamed = usageOf(event)
    if (streamed !== undefined) {
      addToTally(tally, tallyKey, streamed)
      void recordUsage(streamed, memberContext)
    }
    void recordUsage(turnShortfall(event, tally, tallyKey), memberContext)
    // Spans first: the step that produced these events opened before them.
    for (const wire of trace.observe(event, member === LEAD_NAME ? undefined : member)) {
      queued.push(wire)
    }
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
    handles = await startRun(input, {
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
  // Now the roster exists, so a member's tokens can be charged to its own
  // route rather than to the conversation's.
  if (handles.members.length > 0) {
    for (const row of await listAgents(group.id)) {
      if (!handles.members.includes(row.name)) continue
      memberRoutes.set(row.name, {
        provider: row.provider ?? model.config.provider,
        model: row.model ?? model.config.model,
        ...row.reasoningEffort == null ? {} : { effort: row.reasoningEffort },
      })
    }
  }

  // A permission answer arrives on its own HTTP request while this generator
  // is parked on the tool call it releases, so it is folded in here — the
  // approved call's own result is the next lead event, which puts the decision
  // row immediately before it.
  const drainOutbox = async function* (): AsyncGenerator<WireEvent> {
    while (!displacedRuns.has(controller) && live.outbox.length > 0) {
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
    // A client may close immediately after this frame; cleanup must already own it.
    yield { t: 'run-start', runId, members: handles.members }
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
        // The round about to run rebuilds its request from history, so whatever
        // was steered before now is about to be read.
        if (step.lead.type === 'step-start') live.steerUnread = false
        // Per model call while the provider streams counters, and whatever the
        // turn's own report says is still unaccounted for when it ends. A route
        // that reports only on completion emits no per-call event at all, and
        // counting just those left this at zero through entire runs.
        const leadContext = {
          conversationId: id,
          groupId: group.id,
          runId,
          provider: model.config.provider,
          model: model.config.model,
          effort,
        }
        const streamed = usageOf(step.lead)
        if (streamed !== undefined) {
          addToTally(tally, undefined, streamed)
          void recordUsage(streamed, leadContext)
        }
        void recordUsage(turnShortfall(step.lead, tally), leadContext)
        for (const wire of trace.observe(step.lead)) yield wire
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
    // A correction typed after the last model round has nobody left to read it.
    // One more turn is what the user asked for by typing it.
    if (live.steerUnread && handles.continuePending !== undefined && !controller.signal.aborted) {
      live.steerUnread = false
      for await (const event of handles.continuePending()) {
        for (const wire of trace.observe(event)) yield wire
        for (const wire of project.forLead(event)) {
          if (wire.t === 'tool-call') inFlight.set(wire.id, wire.name)
          if (wire.t === 'tool-result') inFlight.delete(wire.id)
          yield wire
        }
      }
    }
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
    // A run the NEXT prompt ended is not a failure. Painting it red tells the
    // user something went wrong with a run they themselves replaced.
    if (live.abort !== controller) {
      await persist({ kind: 'notice', id: `n_${String(live.seq)}`, level: 'warn', message })
      yield { t: 'notice', level: 'warn', message }
      // Still terminal, and it has to SAY so. A displaced or cancelled run ends
      // here, and the notice alone leaves the stream stopping on an ordinary
      // mid-run frame: a reader that waits for an end frame waits forever, and
      // one that treats the closed connection as an end cannot tell a finished
      // run from a dropped one. The browser survives it because it clears its
      // own state when the body closes; nothing else should have to.
      yield { t: 'run-end', reason: 'aborted', text: '' }
    } else {
      await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
      yield { t: 'error', message }
    }
  } finally {
    clearInterval(heartbeat)
    unwatchOutput()
    // Whether a NEWER prompt displaced this run.
    //
    // Not the same as being cancelled: a cancel leaves the conversation idle,
    // so whatever this run had still belongs at the end of the transcript. A
    // displaced run's late content has nowhere to go. The transcript is append-only and the newer run has
    // already written into it, so persisting here files the answer to the
    // ABANDONED prompt underneath the answer to the current one, and the
    // conversation reads as though the assistant replied twice, second reply
    // first. The prompt it belonged to was withdrawn; the notice above already
    // records that this run was replaced, and usage is accounted separately, so
    // nothing billed is lost by dropping the text nobody asked for any more.
    const superseded = displacedRuns.has(controller)
    // An answer that landed as the run was tearing down still belongs in the
    // transcript, even though there is no longer a stream to yield it on.
    const outbox = superseded ? [] : live.outbox.splice(0)
    if (!superseded) {
      for (const entry of outbox) {
        if (entry.node !== undefined) await persist(entry.node)
      }
      for (const node of project.flush()) await persist(node)
      for (const node of project.settled()) await persist(node)
    }
    await saveHistory(id, live.history)
    await handles.close()
    if (!displacedRuns.has(controller)) {
      live.steerRun = undefined
      live.notify = undefined
    }
    // Reached only when a worker is STILL going after all that — the client
    // disconnected, or a new prompt took the conversation over. Its report is
    // written to the transcript so a reload shows it; it is deliberately not
    // queued for the next stream, where it would arrive out of order among
    // that run's own events.
    // ONE projector, not one per event: a projector accumulates deltas into a
    // settled node, and a fresh one per event turns a streamed answer into a
    // scatter of fragments.
    //
    // And the lead is projected AS THE LEAD. Routing everything through
    // `forMember` filed the lead's own woken turn — the synthesis — under a
    // subagent, which is what put a finished report inside a worker's panel
    // and made the run look abandoned.
    const closing = new EventProjector()
    if (!displacedRuns.has(controller)) live.workerSink = (member, event) => {
      if (member === LEAD_NAME) {
        for (const _wire of closing.forLead(event)) { /* nobody is listening */ }
      } else {
        void closing.forMember(member, event)
      }
      for (const node of closing.flush()) void persist(node)
    }
    if (live.abort === controller) live.abort = undefined
  }
}
