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
import { createSampleTools } from './tools'
import { EventProjector } from './event-projection'
import type { StoredNode } from './event-projection'
import type { WireEvent } from './wire'

export interface ChatSession {
  readonly id: string
  readonly history: History
  readonly broker: InteractiveUserInputBroker
  abort: AbortController | undefined
  /** Transcript position for the next persisted node. */
  seq: number
}

interface SessionStore {
  readonly sessions: Map<string, ChatSession>
}

/**
 * One tool registry per workspace root, at MODULE scope on purpose: a hot
 * reload must rebuild tool definitions, while live sessions (below) must
 * survive it.
 */
const toolsByRoot = new Map<string, ToolRegistry>()

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
 * @param id - Conversation id.
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
  const memberOpen = new Set<string>()
  const project = new EventProjector()

  const onMemberEvent = (member: string, event: AgentRunEvent): void => {
    if (!memberOpen.has(member)) {
      memberOpen.add(member)
      queued.push({ t: 'member-start', member })
    }
    queued.push(...project.forMember(member, event))
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
  yield { t: 'run-start', runId, members: handles.members }

  try {
    for await (const event of handles.events) {
      // Drain anything a member produced since the last lead event.
      while (queued.length > 0) {
        const pending = queued.shift() as WireEvent
        yield pending
      }
      for (const wire of project.forLead(event)) yield wire
    }
    for (const node of project.flush()) await persist(node)
    for (const member of memberOpen) yield { t: 'member-end', member }
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await persist({ kind: 'error', id: `e_${String(live.seq)}`, message })
    yield { t: 'error', message }
  } finally {
    for (const node of project.flush()) await persist(node)
    for (const node of project.settled()) await persist(node)
    await saveHistory(id, live.history)
    await handles.close()
    if (live.abort === controller) live.abort = undefined
  }
}
