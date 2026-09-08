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
  ConversationRow, GroupRow, WireApproval, WireApprovalScope, WireEvent, WireQuestion,
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

function reduce(nodes: readonly ChatNode[], event: WireEvent): readonly ChatNode[] {
  switch (event.t) {
    case 'text-delta': {
      const index = nodes.findIndex(node => node.kind === 'text' && node.id === event.id)
      if (index === -1) {
        return [...nodes, {
          kind: 'text',
          id: event.id,
          text: event.text,
          phase: event.phase,
          streaming: true,
          ...event.member === undefined ? {} : { member: event.member },
        }]
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
      if (index === -1) return nodes
      const next = [...nodes]
      next[index] = { ...(nodes[index] as Extract<ChatNode, { kind: 'text' }>), streaming: false }
      return next
    }
    case 'reasoning-delta': {
      const index = nodes.findIndex(node => node.kind === 'reasoning' && node.id === event.id)
      if (index === -1) {
        return [...nodes, {
          kind: 'reasoning',
          id: event.id,
          text: event.text,
          ...event.member === undefined ? {} : { member: event.member },
        }]
      }
      const current = nodes[index] as Extract<ChatNode, { kind: 'reasoning' }>
      const next = [...nodes]
      next[index] = { ...current, text: current.text + event.text }
      return next
    }
    case 'tool-call':
      return [...nodes, {
        kind: 'tool',
        id: event.id,
        name: event.name,
        args: event.args,
        state: 'running',
        ...event.member === undefined ? {} : { member: event.member },
      }]
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
        ...current,
        state: event.ok ? (event.declined === true ? 'declined' : 'ok') : 'error',
        ...event.shortened === undefined ? {} : { shortened: event.shortened },
        output: event.output,
        ...event.card === undefined ? {} : { card: event.card },
        ...event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage },
      }
      return next
    }
    case 'question':
      return [...nodes, {
        kind: 'question',
        id: event.requestId,
        requestId: event.requestId,
        questions: event.questions,
        answered: false,
      }]
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
      const node = {
        kind: 'approval' as const,
        id: event.callId,
        ...approval,
        ...member === undefined ? {} : { member },
      }
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
      return [...nodes, {
        kind: 'notice',
        id: `n_${String(nodes.length)}`,
        level: event.level,
        message: event.message,
      }]
    case 'error':
      return [...nodes, { kind: 'error', id: `e_${String(nodes.length)}`, message: event.message }]
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

export interface ChatController extends ChatState {
  /** The open conversation; empty until the first client render resolves it. */
  readonly sessionId: string
  readonly conversations: readonly ConversationRow[]
  readonly groups: readonly GroupRow[]
  /** The open group; conversations and tools are scoped to it. */
  readonly groupId: string
  openGroup: (id: string) => void
  /** Create a project from a folder; its name defaults to the folder name. */
  createGroup: (workspaceRoot: string) => Promise<GroupRow | undefined>
  deleteGroup: (id: string) => Promise<void>
  refreshGroups: () => Promise<void>
  send: (prompt: string) => Promise<void>
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
  const aborter = useRef<AbortController | null>(null)
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

  const send = useCallback(async (prompt: string) => {
    // The group has to be resolved: a run started without one creates the
    // conversation in the default project, and the agent then writes into the
    // sample's own sandbox instead of the folder on screen.
    if (sessionId === '' || groupId === '' || prompt.trim() === '') return
    const controller = new AbortController()
    aborter.current = controller
    setState(previous => ({
      ...previous,
      running: true,
      members: [],
      nodes: [...previous.nodes, { kind: 'user', id: `u_${String(Date.now())}`, text: prompt }],
    }))

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, prompt, groupId }),
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
          setState(previous => ({
            ...previous,
            nodes: reduce(previous.nodes, event),
            members: reduceMembers(previous.members, event),
            // Live status, deliberately not a transcript node: it is true only
            // while it is on screen.
            progress: event.t === 'progress' ? event.message : previous.progress,
            usage: event.t === 'usage'
              ? {
                  inputTokens: previous.usage.inputTokens + event.inputTokens,
                  outputTokens: previous.usage.outputTokens + event.outputTokens,
                }
              : previous.usage,
          }))
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const message = error instanceof Error ? error.message : String(error)
        setState(previous => ({
          ...previous,
          nodes: [...previous.nodes, { kind: 'error', id: `e_${String(Date.now())}`, message }],
        }))
      }
    } finally {
      aborter.current = null
      // The run is over, so whatever it was waiting on is no longer true.
      setState(previous => ({ ...previous, running: false, progress: null }))
      void refreshConversations()
    }
  }, [sessionId, groupId, refreshConversations])

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
      setState((previous) => {
        const index = previous.nodes.findIndex(
          node => node.kind === 'approval' && node.callId === callId,
        )
        if (index === -1) return previous
        const nodes = [...previous.nodes]
        const { decision: _was, scope: _reach, ...pending }
          = nodes[index] as Extract<ChatNode, { kind: 'approval' }>
        nodes[index] = answer === undefined ? pending : { ...pending, ...answer }
        return { ...previous, nodes }
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
  }, [sessionId])

  const steer = useCallback(async (prompt: string) => {
    const text = prompt.trim()
    if (sessionId === '' || text === '') return
    // Shown immediately: the message is already in the agent's history, and
    // the run's own stream carries no echo of it.
    setState(previous => ({
      ...previous,
      nodes: [...previous.nodes, { kind: 'user', id: `u_${String(Date.now())}_steer`, text }],
    }))
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
      setState(previous => ({
        ...previous,
        nodes: previous.nodes.filter(node => !(node.kind === 'user' && node.text === text
          && node.id.endsWith('_steer'))),
      }))
      await send(text)
    }
  }, [sessionId, send])

  const stop = useCallback(() => {
    void fetch('/api/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    aborter.current?.abort()
  }, [sessionId])

  /** Switch the open conversation without touching history. */
  const applyConversation = useCallback((id: string) => {
    aborter.current?.abort()
    window.localStorage.setItem(CURRENT_KEY, id)
    setSessionId(id)
    setState({
      nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 },
      progress: null, members: [],
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
