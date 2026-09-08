'use client'

/**
 * Chat transport, transcript state, and conversation switching.
 *
 * The SSE body is read with `fetch` rather than `EventSource` because the run
 * is started by a POST that carries the prompt, and because an aborted reader
 * is the cancellation signal the backend listens for.
 *
 * Transcripts are cached in IndexedDB for instant repaint and re-read from the
 * server, which is the authority.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConversationRow, GroupRow, WireApproval, WireApprovalScope, WireAttachment, WireEvent,
  WireQuestion,
} from '@chat-agents/backend'
import { deleteTranscript, readTranscript, writeTranscript } from './idb'
import type { ChatNode, ChatState, MemberState } from './types'

const CURRENT_KEY = 'chat-agents.conversation'
const GROUP_KEY = 'chat-agents.group'

/** Longest tail of live command output kept on screen, in characters. */
const LIVE_OUTPUT_CAP = 20_000

function newConversationId(): string {
  return `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/** Query keys that mirror the open conversation and project into the URL. */
const CONVERSATION_PARAM = 'c'
const GROUP_PARAM = 'g'

function urlParam(key: string): string | null {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get(key)
  return value === null || value === '' ? null : value
}

/**
 * Mirror the open conversation and project into the address bar.
 *
 * `history` is written directly rather than through the router so switching
 * conversations stays a client-side state change with no navigation.
 */
function writeUrl(
  ids: { readonly sessionId?: string, readonly groupId?: string },
  mode: 'push' | 'replace',
): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (ids.sessionId !== undefined && ids.sessionId !== '') {
    url.searchParams.set(CONVERSATION_PARAM, ids.sessionId)
  }
  if (ids.groupId !== undefined && ids.groupId !== '') {
    url.searchParams.set(GROUP_PARAM, ids.groupId)
  }
  if (url.href === window.location.href) return
  if (mode === 'push') window.history.pushState(null, '', url)
  else window.history.replaceState(null, '', url)
}

/**
 * Stamp a row with the moment it appeared or settled.
 *
 * The transcript carries no clock of its own, and the collapsed turn summary
 * needs one to say "worked for 2m 41s". Written here rather than on the wire
 * because the browser's clock is the one the elapsed counter already uses, so
 * the two never disagree by the server's skew.
 */
function stamped<T extends ChatNode>(node: T): T {
  return { ...node, at: Date.now() }
}

function reduce(nodes: readonly ChatNode[], event: WireEvent): readonly ChatNode[] {
  switch (event.t) {
    case 'text-delta': {
      const index = nodes.findIndex(node => node.kind === 'text' && node.id === event.id)
      if (index === -1) {
        return [...nodes, stamped({
          kind: 'text' as const,
          id: event.id,
          text: event.text,
          phase: event.phase,
          streaming: true,
          ...event.member === undefined ? {} : { member: event.member },
        })]
      }
      const current = nodes[index] as Extract<ChatNode, { kind: 'text' }>
      const next = [...nodes]
      next[index] = {
        ...current,
        text: current.text + event.text,
        // A phase is only known once the provider classifies the block; the
        // last classification for a block wins.
        phase: event.phase === 'unknown' ? current.phase : event.phase,
      }
      return next
    }
    case 'text-end': {
      const index = nodes.findIndex(node => node.kind === 'text' && node.id === event.id)
      if (index === -1) return event.text === undefined ? nodes : [...nodes, stamped({
        kind: 'text', id: event.id, text: event.text, phase: event.phase ?? 'unknown', streaming: false,
        ...event.incomplete ? { incomplete: true as const } : {},
        ...event.member === undefined ? {} : { member: event.member },
      })]
      const next = [...nodes]
      // Re-stamped as it closes: a turn ends when its last block finishes
      // streaming, not when its first delta arrived.
      next[index] = stamped({
        ...(nodes[index] as Extract<ChatNode, { kind: 'text' }>),
        ...event.text === undefined ? {} : { text: event.text },
        ...event.phase === undefined ? {} : { phase: event.phase },
        ...event.incomplete ? { incomplete: true as const } : {},
        streaming: false,
      })
      return next
    }
    case 'reasoning-delta': {
      const index = nodes.findIndex(node => node.kind === 'reasoning' && node.id === event.id)
      if (index === -1) {
        return [...nodes, stamped({
          kind: 'reasoning' as const,
          id: event.id,
          text: event.text,
          ...event.member === undefined ? {} : { member: event.member },
        })]
      }
      const current = nodes[index] as Extract<ChatNode, { kind: 'reasoning' }>
      const next = [...nodes]
      next[index] = { ...current, text: current.text + event.text }
      return next
    }
    case 'tool-call':
      return [...nodes, stamped({
        kind: 'tool' as const,
        id: event.id,
        name: event.name,
        args: event.args,
        state: 'running' as const,
        ...event.member === undefined ? {} : { member: event.member },
      })]
    case 'tool-output': {
      const index = nodes.findIndex(node => node.kind === 'tool' && node.id === event.id)
      if (index === -1) return nodes
      const current = nodes[index] as Extract<ChatNode, { kind: 'tool' }>
      const next = [...nodes]
      // Capped from the front: a long build's tail is what a watcher needs,
      // and the settled result carries the server's own capped copy anyway.
      const grown = (current.liveOutput ?? '') + event.chunk
      next[index] = { ...current, liveOutput: grown.slice(-LIVE_OUTPUT_CAP) }
      return next
    }
    case 'tool-result': {
      const index = nodes.findIndex(node => node.kind === 'tool' && node.id === event.id)
      if (index === -1) return nodes
      const current = nodes[index] as Extract<ChatNode, { kind: 'tool' }>
      const next = [...nodes]
      next[index] = {
        ...stamped(current),
        state: event.ok ? (event.declined === true ? 'declined' : 'ok') : 'error',
        ...event.shortened === undefined ? {} : { shortened: event.shortened },
        output: event.output,
        ...event.card === undefined ? {} : { card: event.card },
        ...event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage },
      }
      return next
    }
    case 'question':
      return [...nodes, stamped({
        kind: 'question' as const,
        id: event.requestId,
        requestId: event.requestId,
        questions: event.questions,
        answered: false,
      })]
    case 'question-answered': {
      const index = nodes.findIndex(node => node.kind === 'question' && node.requestId === event.requestId)
      if (index === -1) return nodes
      const next = [...nodes]
      next[index] = { ...(nodes[index] as Extract<ChatNode, { kind: 'question' }>), answered: true }
      return next
    }
    case 'approval': {
      const { t, member, ...approval } = event
      void t
      // A reload re-renders the same pending prompt from the live broker, so
      // an id already on screen is refreshed rather than duplicated.
      const index = nodes.findIndex(node => node.kind === 'approval' && node.callId === event.callId)
      const node = stamped({
        kind: 'approval' as const,
        id: event.callId,
        ...approval,
        ...member === undefined ? {} : { member },
      })
      if (index === -1) return [...nodes, node]
      const next = [...nodes]
      next[index] = node
      return next
    }
    case 'approval-resolved': {
      const index = nodes.findIndex(node => node.kind === 'approval' && node.callId === event.callId)
      if (index === -1) return nodes
      const next = [...nodes]
      next[index] = {
        ...(nodes[index] as Extract<ChatNode, { kind: 'approval' }>),
        decision: event.decision,
        scope: event.scope,
      }
      return next
    }
    case 'notice':
      return [...nodes, stamped({
        kind: 'notice' as const,
        id: `n_${String(nodes.length)}`,
        level: event.level,
        message: event.message,
        ...(event.member === undefined ? {} : { member: event.member }),
      })]
    case 'error':
      return [...nodes, stamped({
        kind: 'error' as const,
        id: `e_${String(nodes.length)}`,
        message: event.message,
      })]
    default:
      return nodes
  }
}

/** Track the team roster across a run: who exists, who is working. */
function reduceMembers(members: readonly MemberState[], event: WireEvent): readonly MemberState[] {
  const upsert = (name: string, patch: Partial<MemberState>): readonly MemberState[] => {
    const index = members.findIndex(member => member.name === name)
    if (index === -1) return [...members, { name, status: 'idle', toolCalls: 0, ...patch }]
    const next = [...members]
    next[index] = { ...members[index] as MemberState, ...patch }
    return next
  }
  switch (event.t) {
    case 'run-start':
      return event.members.map(name => ({ name, status: 'idle' as const, toolCalls: 0 }))
    case 'member-start':
      return upsert(event.member, { status: 'running' })
    case 'member-end':
      return upsert(event.member, { status: 'done' })
    case 'tool-call': {
      if (event.member === undefined) return members
      const current = members.find(member => member.name === event.member)
      return upsert(event.member, { status: 'running', toolCalls: (current?.toolCalls ?? 0) + 1 })
    }
    default:
      return members
  }
}

/** One run in flight, and everything it has produced so far. */
interface LiveRun {
  readonly controller: AbortController
  nodes: readonly ChatNode[]
  members: readonly MemberState[]
  usage: { inputTokens: number, outputTokens: number }
  progress: string | null
}

export interface ChatController extends ChatState {
  /** The open conversation; empty until the first client render resolves it. */
  readonly sessionId: string
  /** Conversations with a run in flight, this one or any other. */
  readonly runningIds: readonly string[]
  readonly conversations: readonly ConversationRow[]
  readonly groups: readonly GroupRow[]
  /** The open group; conversations and tools are scoped to it. */
  readonly groupId: string
  openGroup: (id: string) => void
  /** Create a project from a folder; its name defaults to the folder name. */
  createGroup: (workspaceRoot: string) => Promise<GroupRow | undefined>
  deleteGroup: (id: string) => Promise<void>
  refreshGroups: () => Promise<void>
  /**
   * Start a turn.
   * @param prompt - What the user typed; may be empty when files carry it.
   * @param attachments - Records for the message row, in pick order.
   */
  send: (prompt: string, attachments?: readonly WireAttachment[]) => Promise<void>
  answer: (requestId: string, answers: Record<string, string>) => Promise<void>
  /** Add a message to the run in flight, instead of waiting for it to end. */
  steer: (prompt: string) => Promise<void>
  /** Answer a parked permission prompt; `scope` decides how long it lasts. */
  approve: (callId: string, decision: 'allow' | 'deny', scope: WireApprovalScope) => Promise<void>
  stop: () => void
  newConversation: () => void
  openConversation: (id: string) => void
  removeConversation: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  refreshConversations: () => Promise<void>
}

/**
 * Drive one chat session.
 * @returns The transcript, the conversation list, and the actions the UI calls.
 */
export function useChat(): ChatController {
  const [sessionId, setSessionId] = useState('')
  const [conversations, setConversations] = useState<readonly ConversationRow[]>([])
  const [groups, setGroups] = useState<readonly GroupRow[]>([])
  const [groupId, setGroupId] = useState('')
  const [state, setState] = useState<ChatState>({
    nodes: [],
    running: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    progress: null,
    members: [],
  })
  /**
   * Runs in flight, keyed by conversation.
   *
   * A run used to belong to the VIEW of it: switching conversations aborted
   * the reader, and the backend treats a dropped reader as cancellation — so
   * looking at another chat killed the work you were waiting for. A run now
   * outlives the view, accumulating into its own buffer; the screen mirrors
   * whichever one is open.
   */
  const runs = useRef(new Map<string, LiveRun>())
  /**
   * The conversation on screen.
   *
   * A ref, not state: a background run's events arrive inside a closure that
   * has to know what is showing NOW, and state read there would be whatever
   * it was when the run started.
   */
  const shown = useRef('')
  /**
   * Which conversations are working, as state rather than as the ref above.
   *
   * The sidebar has to repaint when a run it is not showing starts or ends,
   * and a ref read during render cannot cause that.
   */
  const [runningIds, setRunningIds] = useState<readonly string[]>([])
  /**
   * Calls already answered.
   *
   * A permission prompt is answerable exactly once: the second answer would be
   * refused by the broker, and treating that refusal as a failure would put
   * the prompt back on screen for a call that is already running.
   */
  const answered = useRef(new Set<string>())

  const refreshConversations = useCallback(async () => {
    if (groupId === '') return
    const response = await fetch(`/api/conversations?groupId=${encodeURIComponent(groupId)}`)
    if (!response.ok) return
    const body = await response.json() as { conversations: ConversationRow[] }
    setConversations(body.conversations)
  }, [groupId])

  const refreshGroups = useCallback(async () => {
    const response = await fetch('/api/groups')
    if (!response.ok) return
    const body = await response.json() as { groups: GroupRow[] }
    setGroups(body.groups)
    // Resolve the stored group only against groups that still exist.
    setGroupId((current) => {
      if (current !== '' && body.groups.some(group => group.id === current)) return current
      // The URL wins over the stored group so a pasted link opens its project.
      const requested = urlParam(GROUP_PARAM) ?? window.localStorage.getItem(GROUP_KEY)
      const resolved = requested !== null && body.groups.some(group => group.id === requested)
        ? requested
        : body.groups[0]?.id ?? ''
      return resolved
    })
  }, [])

  useEffect(() => {
    // A conversation id in the URL wins, so a pasted link reopens that chat.
    const requested = urlParam(CONVERSATION_PARAM) ?? window.localStorage.getItem(CURRENT_KEY)
    const id = requested ?? newConversationId()
    window.localStorage.setItem(CURRENT_KEY, id)
    shown.current = id
    setSessionId(id)
    writeUrl({ sessionId: id }, 'replace')
    void refreshGroups()
  }, [refreshGroups])

  useEffect(() => { void refreshConversations() }, [refreshConversations])

  // Keep the project id visible once it resolves, without adding history.
  useEffect(() => {
    if (groupId === '') return
    writeUrl({ groupId }, 'replace')
  }, [groupId])

  // Paint the cached transcript first, then reconcile with the server copy.
  useEffect(() => {
    if (sessionId === '') return
    // A conversation still running is already on screen from its own buffer,
    // which is ahead of both the cache and the server's settled copy. Reading
    // either one here would rewind it.
    if (runs.current.has(sessionId)) return
    let cancelled = false
    void (async () => {
      const cached = await readTranscript(sessionId)
      if (!cancelled && cached !== undefined) {
        setState(previous => ({ ...previous, nodes: cached }))
      }
      const response = await fetch(`/api/conversations/${sessionId}`)
      if (!response.ok || cancelled) return
      const body = await response.json() as {
        messages: ChatNode[]
        pendingApprovals?: readonly WireApproval[]
        pendingQuestions?: readonly { requestId: string; questions: readonly WireQuestion[] }[]
      }
      // Neither a waiting permission prompt nor an open question is in the
      // transcript — both live in the run — so they are appended rather than
      // replayed, and deliberately kept out of the local cache. Without the
      // questions a reload left the run parked on an answer the user could no
      // longer give, because the card it needed was gone.
      const parked: ChatNode[] = [
        ...(body.pendingApprovals ?? [])
          .map(approval => ({ kind: 'approval' as const, id: approval.callId, ...approval })),
        ...(body.pendingQuestions ?? []).map(open => ({
          kind: 'question' as const,
          id: open.requestId,
          requestId: open.requestId,
          questions: open.questions,
          answered: false,
        })),
      ]
      if (body.messages.length === 0 && cached !== undefined) {
        if (parked.length > 0) setState(previous => ({ ...previous, nodes: [...cached, ...parked] }))
        return
      }
      setState(previous => ({ ...previous, nodes: [...body.messages, ...parked] }))
      await writeTranscript(sessionId, body.messages)
    })()
    return () => { cancelled = true }
  }, [sessionId])

  // Keep the local cache in step with what is on screen.
  useEffect(() => {
    if (sessionId === '' || state.running) return
    void writeTranscript(sessionId, state.nodes)
  }, [sessionId, state.nodes, state.running])

  const send = useCallback(async (prompt: string, attachments: readonly WireAttachment[] = []) => {
    // The group has to be resolved: a run started without one creates the
    // conversation in the default project, and the agent then writes into the
    // sample's own sandbox instead of the folder on screen.
    //
    // Attachments are a message of their own: dropping a screenshot in and
    // pressing Enter with nothing typed is a complete thing to say.
    if (sessionId === '' || groupId === '') return
    if (prompt.trim() === '' && attachments.length === 0) return
    // Captured now: every update below belongs to THIS conversation, whatever
    // the user is looking at by the time the event arrives.
    const id = sessionId
    const controller = new AbortController()
    const run: LiveRun = {
      controller,
      nodes: [...state.nodes, {
        kind: 'user',
        id: `u_${String(Date.now())}`,
        text: prompt,
        at: Date.now(),
        ...attachments.length === 0 ? {} : { attachments },
      }],
      members: [],
      usage: state.usage,
      progress: null,
    }
    runs.current.set(id, run)
    setRunningIds([...runs.current.keys()])
    /** Mirror the run onto the screen, but only while it is the one open. */
    const show = (): void => {
      if (shown.current !== id) return
      setState({
        nodes: run.nodes,
        running: true,
        members: run.members,
        usage: run.usage,
        progress: run.progress,
      })
    }
    show()
    // The row exists the moment the run does — the server creates it before
    // its first event — but the sidebar only ever refreshed at the END of a
    // run, so a conversation started and left to work was invisible for as
    // long as it took.
    void refreshConversations()

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: id,
          prompt,
          groupId,
          ...attachments.length === 0 ? {} : { attachmentIds: attachments.map(item => item.id) },
        }),
        signal: controller.signal,
      })
      if (response.body === null) throw new Error('the server returned no stream')

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += chunk.value
        // SSE frames are separated by a blank line; a partial tail stays buffered.
        let separator = buffer.indexOf('\n\n')
        while (separator !== -1) {
          const frame = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          separator = buffer.indexOf('\n\n')
          const payload = frame.startsWith('data: ') ? frame.slice(6) : ''
          if (payload === '') continue
          const event = JSON.parse(payload) as WireEvent
          run.nodes = reduce(run.nodes, event)
          run.members = reduceMembers(run.members, event)
          // Live status, deliberately not a transcript node: it is true only
          // while it is on screen.
          if (event.t === 'progress') run.progress = event.message
          if (event.t === 'usage') {
            run.usage = {
              inputTokens: run.usage.inputTokens + event.inputTokens,
              outputTokens: run.usage.outputTokens + event.outputTokens,
            }
          }
          show()
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const message = error instanceof Error ? error.message : String(error)
        run.nodes = [...run.nodes, {
          kind: 'error',
          id: `e_${String(Date.now())}`,
          message,
          at: Date.now(),
        }]
        show()
      }
    } finally {
      const settled = run.nodes
      runs.current.delete(id)
      setRunningIds([...runs.current.keys()])
      // The run is over, so whatever it was waiting on is no longer true.
      if (shown.current === id) {
        setState(previous => ({ ...previous, nodes: settled, running: false, progress: null }))
      } else {
        // Nobody was watching, so nothing wrote the cache: do it here, or
        // coming back would show the transcript as it was before the run.
        void writeTranscript(id, settled)
      }
      void refreshConversations()
    }
  }, [sessionId, groupId, state.nodes, state.usage, refreshConversations])

  /**
   * Edit one conversation's rows, in the live buffer and on screen alike.
   *
   * A run's buffer is the authority while it lasts — every event repaints the
   * screen from it — so an edit written only to the screen (an answered
   * permission prompt, a steering message) is erased by the next event.
   * @param id - The conversation to edit.
   * @param edit - Receives the current rows, returns the new ones.
   */
  const editNodes = useCallback((
    id: string,
    edit: (nodes: readonly ChatNode[]) => readonly ChatNode[],
  ) => {
    const live = runs.current.get(id)
    if (live !== undefined) live.nodes = edit(live.nodes)
    if (shown.current !== id) return
    setState(previous => ({ ...previous, nodes: live === undefined ? edit(previous.nodes) : live.nodes }))
  }, [])

  const answer = useCallback(async (requestId: string, answers: Record<string, string>) => {
    await fetch('/api/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, requestId, answers }),
    })
  }, [sessionId])

  const approve = useCallback(async (
    callId: string,
    decision: 'allow' | 'deny',
    scope: WireApprovalScope,
  ) => {
    if (answered.current.has(callId)) return
    answered.current.add(callId)

    // Settle the node here, not on the server's confirmation. The released
    // call reports back through the run's own stream, which does not emit
    // again until the tool FINISHES — an `npm install` would leave the prompt
    // on screen for a minute after it was answered.
    const settle = (answer: { decision: 'allow' | 'deny'; scope: WireApprovalScope } | undefined) => {
      editNodes(sessionId, (previous) => {
        const index = previous.findIndex(
          node => node.kind === 'approval' && node.callId === callId,
        )
        if (index === -1) return previous
        const nodes = [...previous]
        const { decision: _was, scope: _reach, ...pending }
          = nodes[index] as Extract<ChatNode, { kind: 'approval' }>
        nodes[index] = answer === undefined ? pending : { ...pending, ...answer }
        return nodes
      })
    }

    settle({ decision, scope })
    try {
      const response = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, callId, decision, scope }),
      })
      const body = await response.json() as { resolved?: boolean }
      // Nothing was released — the run ended or the server restarted while the
      // card was open. Put the prompt back rather than leaving a decision on
      // screen that never reached the call.
      if (!response.ok || body.resolved !== true) {
        answered.current.delete(callId)
        settle(undefined)
      }
    } catch {
      answered.current.delete(callId)
      settle(undefined)
    }
  }, [sessionId, editNodes])

  const steer = useCallback(async (prompt: string) => {
    const text = prompt.trim()
    if (sessionId === '' || text === '') return
    // Shown immediately: the message is already in the agent's history, and
    // the run's own stream carries no echo of it.
    editNodes(sessionId, previous => [...previous, {
      kind: 'user',
      id: `u_${String(Date.now())}_steer`,
      text,
      at: Date.now(),
    }])
    const response = await fetch('/api/steer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, prompt: text }),
    })
    const body = await response.json().catch(() => ({})) as { steered?: boolean }
    // The run ended between the keystroke and the request. The message would
    // otherwise be silently dropped, so send it as an ordinary prompt — minus
    // the user node just added, which `send` appends again.
    if (body.steered !== true) {
      editNodes(sessionId, previous => previous.filter(
        node => !(node.kind === 'user' && node.text === text && node.id.endsWith('_steer')),
      ))
      await send(text)
    }
  }, [sessionId, send, editNodes])

  const stop = useCallback(() => {
    void fetch('/api/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    runs.current.get(sessionId)?.controller.abort()
  }, [sessionId])

  /**
   * Switch the open conversation without touching history.
   *
   * Deliberately does NOT abort: a run belongs to its conversation, not to the
   * window on it. Switching back to a conversation still working shows it
   * still working, from the buffer the run has been filling all along.
   */
  const applyConversation = useCallback((id: string) => {
    window.localStorage.setItem(CURRENT_KEY, id)
    shown.current = id
    setSessionId(id)
    const live = runs.current.get(id)
    setState(live === undefined
      ? {
          nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 },
          progress: null, members: [],
        }
      : {
          nodes: live.nodes, running: true, usage: live.usage,
          progress: live.progress, members: live.members,
        })
  }, [])

  const openConversation = useCallback((id: string) => {
    applyConversation(id)
    writeUrl({ sessionId: id }, 'push')
  }, [applyConversation])

  // Back and forward move between the conversations already visited.
  useEffect(() => {
    const onPop = (): void => {
      const id = urlParam(CONVERSATION_PARAM)
      if (id === null || id === sessionId) return
      applyConversation(id)
    }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop) }
  }, [applyConversation, sessionId])

  const newConversation = useCallback(() => {
    openConversation(newConversationId())
  }, [openConversation])

  const removeConversation = useCallback(async (id: string) => {
    // The one case where a run really is over: its conversation is gone, so
    // nothing is left for it to write into.
    runs.current.get(id)?.controller.abort()
    await fetch('/api/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id }),
    })
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' })
    await deleteTranscript(id)
    await refreshConversations()
    if (id === sessionId) openConversation(newConversationId())
  }, [openConversation, refreshConversations, sessionId])

  const renameConversation = useCallback(async (id: string, title: string) => {
    await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    await refreshConversations()
  }, [refreshConversations])

  const openGroup = useCallback((id: string) => {
    window.localStorage.setItem(GROUP_KEY, id)
    setGroupId(id)
    // A conversation belongs to one group, so switching group starts a new one.
    const fresh = newConversationId()
    window.localStorage.setItem(CURRENT_KEY, fresh)
    shown.current = fresh
    setSessionId(fresh)
    setState({
      nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 },
      progress: null, members: [],
    })
    writeUrl({ sessionId: fresh, groupId: id }, 'push')
  }, [])

  const createGroup = useCallback(async (workspaceRoot: string) => {
    const response = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceRoot }),
    })
    if (!response.ok) return undefined
    const body = await response.json() as { group: GroupRow }
    await refreshGroups()
    openGroup(body.group.id)
    return body.group
  }, [openGroup, refreshGroups])

  const deleteGroup = useCallback(async (id: string) => {
    await fetch(`/api/groups/${id}`, { method: 'DELETE' })
    await refreshGroups()
    // Deleting the open project drops back to whichever project remains.
    if (id === groupId) setGroupId('')
  }, [groupId, refreshGroups])

  return {
    ...state,
    sessionId,
    runningIds,
    conversations,
    groups,
    groupId,
    openGroup,
    createGroup,
    deleteGroup,
    refreshGroups,
    send,
    answer,
    steer,
    approve,
    stop,
    newConversation,
    openConversation,
    removeConversation,
    renameConversation,
    refreshConversations,
  }
}
