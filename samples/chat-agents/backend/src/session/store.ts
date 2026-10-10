import { createUserInputBroker } from '@alvin0/ai-agent-sdk-core'
import { ensureConversation, loadHistory, nextSeq } from '../conversations'
import { getGroup } from '../groups'
import type { ChatSession, SessionStore } from './types'

export const STORE_KEY = Symbol.for('@chat-agents/backend.sessions')

/** Module-level store that survives Next.js dev hot reloads. */
export function store(): SessionStore {
  const holder = globalThis as unknown as Record<symbol, SessionStore | undefined>
  const existing = holder[STORE_KEY]
  if (existing !== undefined) return existing
  const created: SessionStore = { sessions: new Map() }
  holder[STORE_KEY] = created
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
  const state = store()
  const { sessions } = state
  const existing = sessions.get(id)
  if (existing !== undefined) return existing
  const pending = state.pending ??= new Map()
  const opening = pending.get(id)
  if (opening !== undefined) return opening
  const hydration: Promise<ChatSession> = Promise.resolve().then(async () => {
    if (pending.get(id) !== hydration) throw new Error('conversation closed during hydration')
    const group = await getGroup(groupId)
    await ensureConversation(id, {
      mode: 'basic',
      workspaceRoot: group.workspaceRoot,
      groupId: group.id,
    })
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
    if (pending.get(id) !== hydration) throw new Error('conversation closed during hydration')
    sessions.set(id, created)
    return created
  })
  pending.set(id, hydration)
  try { return await hydration }
  finally { if (pending.get(id) === hydration) pending.delete(id) }
}

/**
 * Drop a session's live state, so the next touch re-reads SQLite.
 * @param id - Conversation id.
 */
export function forgetSession(id: string): void {
  const state = store()
  const { sessions } = state
  state.pending?.delete(id)
  const live = sessions.get(id)
  live?.abort?.abort(new Error('conversation closed'))
  live?.approvals?.broker.abortAll()
  // Nothing else ends a detached worker: the run it came from is long over.
  void live?.managed?.dispose(new Error('conversation closed'))
  sessions.delete(id)
}
