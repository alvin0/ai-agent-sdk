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
import type { ConversationRow, GroupRow, WireEvent } from '@chat-agents/backend'
import { deleteTranscript, readTranscript, writeTranscript } from './idb'
import type { ChatNode, ChatState, MemberState } from './types'

const CURRENT_KEY = 'chat-agents.conversation'
const GROUP_KEY = 'chat-agents.group'

function newConversationId(): string {
  return `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
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
    case 'tool-result': {
      const index = nodes.findIndex(node => node.kind === 'tool' && node.id === event.id)
      if (index === -1) return nodes
      const current = nodes[index] as Extract<ChatNode, { kind: 'tool' }>
      const next = [...nodes]
      next[index] = {
        ...current,
        state: event.ok ? 'ok' : 'error',
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
    members: [],
  })
  const aborter = useRef<AbortController | null>(null)

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
      const stored = window.localStorage.getItem(GROUP_KEY)
      const resolved = stored !== null && body.groups.some(group => group.id === stored)
        ? stored
        : body.groups[0]?.id ?? ''
      return resolved
    })
  }, [])

  useEffect(() => {
    const stored = window.localStorage.getItem(CURRENT_KEY)
    const id = stored ?? newConversationId()
    if (stored === null) window.localStorage.setItem(CURRENT_KEY, id)
    setSessionId(id)
    void refreshGroups()
  }, [refreshGroups])

  useEffect(() => { void refreshConversations() }, [refreshConversations])

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
      const body = await response.json() as { messages: ChatNode[] }
      if (body.messages.length === 0 && cached !== undefined) return
      setState(previous => ({ ...previous, nodes: body.messages }))
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
    if (sessionId === '' || prompt.trim() === '') return
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
      setState(previous => ({ ...previous, running: false }))
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

  const stop = useCallback(() => {
    void fetch('/api/abort', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    aborter.current?.abort()
  }, [sessionId])

  const openConversation = useCallback((id: string) => {
    aborter.current?.abort()
    window.localStorage.setItem(CURRENT_KEY, id)
    setSessionId(id)
    setState({ nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 }, members: [] })
  }, [])

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
    setState({ nodes: [], running: false, usage: { inputTokens: 0, outputTokens: 0 }, members: [] })
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
    stop,
    newConversation,
    openConversation,
    removeConversation,
    renameConversation,
    refreshConversations,
  }
}
