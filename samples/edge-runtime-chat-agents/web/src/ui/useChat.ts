'use client'

/**
 * Chat transport, transcript state, and conversation switching.
 *
 * The SSE body is read with `fetch` rather than `EventSource` because the run
 * is started by a POST that carries the prompt, and because an aborted reader
 * is the cancellation signal the backend listens for.
 *
 * Transcripts are held in `localStorage`, which is the only durable store this
 * sample has: an Edge isolate keeps the model-side history in memory only, so
 * a cold start resumes the browser's view of a conversation the server has
 * already forgotten. The header says so rather than hiding it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  API_KEY_HEADER,
  type RunMode, type WireEvent, type WireMember, type WireModel, type WireUsage,
} from '../server/wire'
import type { ChatNode, ConversationRow, MemberState } from './types'

/** What the page has chosen to run: the model, the mode, and the roster. */
export interface RunChoice {
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly mode: RunMode
  readonly team: readonly WireMember[]
  /** Capacities for every model this browser knows about. */
  readonly catalog: readonly WireModel[]
}

const LIST_KEY = 'edge-chat-agents.conversations'
const CURRENT_KEY = 'edge-chat-agents.current'
const TRANSCRIPT_PREFIX = 'edge-chat-agents.transcript.'
/** Conversations kept in the browser before the oldest is dropped. */
const MAX_CONVERSATIONS = 30

function newConversationId(): string {
  return `c${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function nodeId(): string {
  return `n${Math.random().toString(36).slice(2, 10)}`
}

/** Read JSON out of `localStorage`, treating any damage as absence. */
function readStore<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch { return fallback }
}

function writeStore(key: string, value: unknown): void {
  // A full or disabled store must not take the conversation down with it.
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* best effort */ }
}

/** Stamp a transcript row with the browser clock used by Process summaries. */
function stamped<T extends ChatNode>(node: T): T {
  return { ...node, at: Date.now() }
}

/** The first line of the first prompt, which is what the sidebar can show. */
function titleOf(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? ''
  if (line === '') return 'New chat'
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

export interface ChatController {
  readonly conversationId: string
  readonly conversations: readonly ConversationRow[]
  readonly nodes: readonly ChatNode[]
  /** The team as the roster strip draws it; empty in a single-agent run. */
  readonly members: readonly MemberState[]
  readonly running: boolean
  /** Conversations whose SSE runs are still active, including background runs. */
  readonly runningIds: readonly string[]
  readonly usage: WireUsage | undefined
  readonly liveRunId: string
  readonly liveSpans: readonly import('../server/traces').WireSpan[]
  send: (text: string) => void
  stop: () => void
  newConversation: () => void
  openConversation: (id: string) => void
  deleteConversation: (id: string) => void
}

/** The browser-side buffer for one conversation that is still streaming. */
interface LiveRun {
  readonly controller: AbortController
  runId: string
  nodes: readonly ChatNode[]
  spans: readonly import('../server/traces').WireSpan[]
  usage: WireUsage | undefined
  discarded: boolean
}

/**
 * Drive one conversation against the Edge backend.
 * @param apiKey - The visitor's own key, when the browser holds one. It rides
 *   on a header rather than in the body, so it stays out of anything that logs
 *   or replays a request payload.
 * @param choice - Model and effort the page picked, when it picked either.
 * @returns The transcript, the conversation list, and the actions over both.
 */
export function useChat(apiKey: string | undefined, choice: RunChoice): ChatController {
  const [conversationId, setConversationId] = useState('')
  const [conversations, setConversations] = useState<readonly ConversationRow[]>([])
  const [nodes, setNodes] = useState<readonly ChatNode[]>([])
  const [running, setRunning] = useState(false)
  const [runningIds, setRunningIds] = useState<readonly string[]>([])
  const [usage, setUsage] = useState<WireUsage | undefined>(undefined)
  const [liveRunId, setLiveRunId] = useState('')
  const [liveSpans, setLiveSpans] = useState<readonly import('../server/traces').WireSpan[]>([])
  /** One live stream per conversation; switching views must not cancel these. */
  const runs = useRef(new Map<string, LiveRun>())
  /** The conversation whose buffer is currently attached to the view. */
  const shown = useRef('')
  /** The key as of the latest render, so a stale closure never sends the old one. */
  const key = useRef<string | undefined>(apiKey)
  key.current = apiKey
  /** The model choice as of the latest render, for the same reason. */
  const picked = useRef(choice)
  picked.current = choice

  /** Request headers for one call, carrying the key only when there is one. */
  const headers = useCallback((): Record<string, string> => ({
    'content-type': 'application/json',
    ...(key.current === undefined ? {} : { [API_KEY_HEADER]: key.current }),
  }), [])

  // First paint: restore the conversation list and the last open conversation.
  useEffect(() => {
    const rows = readStore<readonly ConversationRow[]>(LIST_KEY, [])
    const last = readStore<string>(CURRENT_KEY, '')
    const id = last !== '' && rows.some(row => row.id === last)
      ? last
      : rows[0]?.id ?? newConversationId()
    shown.current = id
    setConversations(rows)
    setConversationId(id)
    setNodes(readStore<readonly ChatNode[]>(`${TRANSCRIPT_PREFIX}${id}`, []))
    setLiveRunId('')
    setLiveSpans([])
  }, [])

  const touch = useCallback((id: string, title: string) => {
    setConversations((rows) => {
      const existing = rows.find(row => row.id === id)
      const next = [
        { id, title: existing?.title ?? title, updatedAt: Date.now() },
        ...rows.filter(row => row.id !== id),
      ].slice(0, MAX_CONVERSATIONS)
      writeStore(LIST_KEY, next)
      return next
    })
  }, [])

  const openConversation = useCallback((id: string) => {
    if (id === shown.current) return

    // A run continues in the background, but persist its current buffer before
    // replacing the visible conversation. This also makes a reload while the
    // user is looking at another chat retain the latest received rows.
    const previous = runs.current.get(shown.current)
    if (previous !== undefined && !previous.discarded) {
      writeStore(`${TRANSCRIPT_PREFIX}${shown.current}`, previous.nodes)
    }

    shown.current = id
    setConversationId(id)
    const live = runs.current.get(id)
    if (live === undefined) {
      setRunning(false)
      setUsage(undefined)
      setLiveRunId('')
      setLiveSpans([])
      setNodes(readStore<readonly ChatNode[]>(`${TRANSCRIPT_PREFIX}${id}`, []))
    } else {
      setRunning(true)
      setUsage(live.usage)
      setLiveRunId(live.runId)
      setLiveSpans(live.spans)
      setNodes(live.nodes)
    }
    writeStore(CURRENT_KEY, id)
  }, [])

  const newConversation = useCallback(() => {
    openConversation(newConversationId())
  }, [openConversation])

  const deleteConversation = useCallback((id: string) => {
    const live = runs.current.get(id)
    if (live !== undefined) {
      live.discarded = true
      live.controller.abort()
      runs.current.delete(id)
      setRunningIds([...runs.current.keys()])
    }
    try { window.localStorage.removeItem(`${TRANSCRIPT_PREFIX}${id}`) } catch { /* best effort */ }
    // The isolate that holds this conversation may not be the one that answers,
    // so a miss here is normal rather than a failure worth reporting.
    void fetch('/api/close', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ conversationId: id }),
    }).catch(() => undefined)
    setConversations((rows) => {
      const next = rows.filter(row => row.id !== id)
      writeStore(LIST_KEY, next)
      return next
    })
    if (id === shown.current) newConversation()
  }, [headers, newConversation])

  const stop = useCallback(() => {
    runs.current.get(shown.current)?.controller.abort()
  }, [])

  const send = useCallback((text: string) => {
    const prompt = text.trim()
    if (prompt === '' || conversationId === '' || runs.current.has(conversationId)) return
    const id = conversationId
    const run: LiveRun = {
      controller: new AbortController(),
      runId: '',
      nodes: [...nodes, stamped({ kind: 'user', id: nodeId(), text: prompt })],
      spans: [],
      usage: undefined,
      discarded: false,
    }
    touch(id, titleOf(prompt))
    writeStore(CURRENT_KEY, id)
    setUsage(undefined)
    setLiveRunId('')
    setLiveSpans([])
    runs.current.set(id, run)
    setRunningIds([...runs.current.keys()])
    setNodes(run.nodes)
    setRunning(true)

    void (async () => {
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({
            conversationId: id,
            message: prompt,
            // Omitted rather than sent as null, so the server falls back to its
            // own default instead of being told to use nothing.
            ...(picked.current.model === undefined ? {} : { model: picked.current.model }),
            ...(picked.current.effort === undefined ? {} : { effort: picked.current.effort }),
            mode: picked.current.mode,
            ...(picked.current.mode === 'team' ? { team: picked.current.team } : {}),
            ...(picked.current.catalog.length === 0 ? {} : { catalog: picked.current.catalog }),
          }),
          signal: run.controller.signal,
        })
        if (!response.ok || response.body === null) {
          const detail: unknown = await response.json().catch(() => undefined)
          run.nodes = [...run.nodes, stamped({
            kind: 'error', id: nodeId(), message: describe(response.status, detail),
          })]
          if (shown.current === id) setNodes(run.nodes)
          return
        }
        for await (const event of readEvents(response.body, run.controller.signal)) {
          if (event.t === 'start') {
            run.runId = event.runId
            if (shown.current === id) setLiveRunId(run.runId)
          }
          if (event.t === 'span') {
            run.spans = upsertSpan(run.spans, event.span)
            if (shown.current === id) setLiveSpans(run.spans)
          }
          if (event.t === 'done') run.usage = event.usage
          run.nodes = reduce(run.nodes, event)
          if (shown.current === id) {
            if (event.t === 'done') setUsage(run.usage)
            setNodes(run.nodes)
          }
        }
      } catch (error) {
        if (!run.controller.signal.aborted) {
          run.nodes = [...run.nodes, stamped({
            kind: 'error', id: nodeId(), message: error instanceof Error ? error.message : String(error),
          })]
          if (shown.current === id) setNodes(run.nodes)
        }
      } finally {
        const settled = run.nodes.map(node => (
          node.kind === 'assistant' && node.live
            ? { ...node, live: false, at: Date.now() }
            : node
        ))
        run.nodes = settled
        runs.current.delete(id)
        setRunningIds([...runs.current.keys()])
        // The live assistant node settles here, so the stored copy never
        // reopens as a half-finished stream on the next visit. A deleted chat
        // is intentionally not resurrected by a late fetch finalizer.
        if (!run.discarded) writeStore(`${TRANSCRIPT_PREFIX}${id}`, settled)
        if (shown.current === id) {
          setRunning(false)
          setUsage(run.usage)
          setLiveRunId('')
          setLiveSpans([])
          setNodes(settled)
        }
      }
    })()
  }, [conversationId, headers, nodes, touch])

  return {
    conversationId,
    conversations,
    nodes,
    members: rosterState(choice, nodes, running),
    running,
    runningIds,
    usage,
    liveRunId,
    liveSpans,
    send,
    stop,
    newConversation,
    openConversation,
    deleteConversation,
  }
}

/**
 * The roster as the strip draws it, folded out of the transcript.
 *
 * Derived rather than tracked in state: the transcript already records every
 * start, end and tool call, and a second copy of that would be one more thing
 * to keep in step with it.
 * @param choice - The configured roster, which is who exists.
 * @param nodes - The transcript, which is what they have done.
 * @returns One entry per member, in roster order.
 */
function rosterState(
  choice: RunChoice,
  nodes: readonly ChatNode[],
  running: boolean,
): readonly MemberState[] {
  if (choice.mode === 'single') return []
  const members: WireMember[] = choice.mode === 'team'
    ? [...choice.team]
    : [{
        name: 'lead', role: 'lead',
        ...(choice.model === undefined ? {} : { model: choice.model }),
      }]
  if (choice.mode === 'team-auto') {
    const known = new Set(members.map(member => member.name))
    for (const node of nodes) {
      const name = 'member' in node ? node.member : undefined
      if (name === undefined || known.has(name)) continue
      known.add(name)
      members.push({
        name,
        role: 'peer',
        ...(choice.model === undefined ? {} : { model: choice.model }),
      })
    }
  }
  return members.map((member) => {
    let status: MemberState['status'] = 'idle'
    let toolCalls = 0
    for (const node of nodes) {
      if (node.kind === 'tool' && node.member === member.name) toolCalls += 1
      if (node.kind !== 'member-mark' || node.member !== member.name) continue
      if (node.phase === 'start') status = 'running'
      else status = node.failed === true ? 'failed' : 'done'
    }
    // The lead never appears in the team's member events — it is the agent this
    // host runs directly — so its state comes from whether it has spoken.
    if (member.role === 'lead' && status === 'idle') {
      status = running
        ? 'running'
        : nodes.some(node => node.kind === 'assistant' && node.member === member.name) ? 'done' : 'idle'
    }
    return {
      name: member.name,
      status,
      toolCalls,
      ...(member.role === undefined ? {} : { role: member.role }),
      ...(member.model === undefined ? {} : { model: member.model }),
    }
  })
}

/** Fold one wire event into the transcript. */
function reduce(nodes: readonly ChatNode[], event: WireEvent): readonly ChatNode[] {
  if (event.t === 'text-delta') {
    return appendText(nodes, 'assistant', event.text, event.member, event.blockId)
  }
  if (event.t === 'reasoning-delta') {
    return appendText(nodes, 'reasoning', event.text, event.member, event.blockId)
  }
  if (event.t === 'member-start') {
    return [...nodes, stamped({
      kind: 'member-mark', id: nodeId(), member: event.member, phase: 'start',
    })]
  }
  if (event.t === 'member-end') {
    return [...nodes, stamped({
      kind: 'member-mark', id: nodeId(), member: event.member, phase: 'end',
      ...(event.failed === true ? { failed: true as const } : {}),
    })]
  }
  if (event.t === 'member-message') {
    // A peer's text arrives whole rather than as deltas, so it is appended as a
    // settled block instead of opening a live one.
    return [...nodes, stamped({
      kind: 'assistant', id: nodeId(), text: event.text, live: false, member: event.member,
    })]
  }
  if (event.t === 'tool-call') {
    return [...nodes, stamped({
      kind: 'tool', id: event.callId, name: event.name, input: event.input,
      status: 'running', family: 'host',
      ...(event.member === undefined ? {} : { member: event.member }),
    })]
  }
  if (event.t === 'tool-result') {
    return nodes.map(node => (
      node.kind === 'tool' && node.id === event.callId
        ? {
            ...node,
            status: event.isError ? ('failed' as const) : ('completed' as const),
            at: Date.now(),
          }
        : node
    ))
  }
  if (event.t === 'native-tool') {
    const settled = event.status === 'completed'
    if (nodes.some(node => node.kind === 'tool' && node.id === event.callId)) {
      return nodes.map(node => (
        node.kind === 'tool' && node.id === event.callId
          ? {
              ...node,
              status: settled ? ('completed' as const) : ('running' as const),
              ...(settled ? { at: Date.now() } : {}),
            }
          : node
      ))
    }
    return [...nodes, stamped({
      kind: 'tool', id: event.callId, name: event.name, input: undefined,
      status: settled ? 'completed' : 'running', family: 'provider-native',
    })]
  }
  if (event.t === 'error') {
    // The provider's own words come first when there are any: "model X does not
    // exist" is what the reader can act on, and the SDK's code is context.
    const headline = event.detail ?? event.message
    const where = [
      event.code,
      event.status === undefined ? undefined : `HTTP ${String(event.status)}`,
      event.stage,
    ].filter(part => part !== undefined).join(' · ')
    return [...nodes, stamped({ kind: 'error', id: nodeId(), message: headline, detail: where })]
  }
  return nodes
}

/** Replace the open copy of a span when its end event arrives. */
function upsertSpan(
  spans: readonly import('../server/traces').WireSpan[],
  span: import('../server/traces').WireSpan,
): readonly import('../server/traces').WireSpan[] {
  const index = spans.findIndex(current => current.spanId === span.spanId)
  if (index === -1) return [...spans, span]
  const next = [...spans]
  next[index] = span
  return next
}

/**
 * Append streamed text to the open block of that kind, or open a new one.
 *
 * A tool call between two deltas closes the block: text before the call and
 * text after it are separate thoughts, and merging them would put the tool
 * card after prose it actually preceded.
 */
function appendText(
  nodes: readonly ChatNode[],
  kind: 'assistant' | 'reasoning',
  text: string,
  member: string | undefined,
  blockId: string | undefined,
): readonly ChatNode[] {
  // A team event can arrive between two deltas from the same model block.
  // Upsert by block id first, as chat-agents does, so those events do not turn
  // one sentence into a column of one-word speaker badges.
  if (blockId !== undefined) {
    const index = nodes.findIndex(node => (
      node.kind === kind && node.blockId === blockId && node.member === member
    ))
    if (index !== -1) {
      const current = nodes[index] as Extract<ChatNode, { kind: typeof kind }>
      const next = [...nodes]
      next[index] = { ...current, text: current.text + text }
      return next
    }
  }
  const last = nodes.at(-1)
  // A block belongs to one speaker: text from a different member opens its own
  // block even when it follows text of the same kind.
  if (last?.kind === kind && last.member === member) {
    return [...nodes.slice(0, -1), { ...last, text: last.text + text }]
  }
  const from = member === undefined ? {} : { member }
  const identified = blockId === undefined ? {} : { blockId }
  return kind === 'assistant'
    ? [...nodes, stamped({ kind, id: nodeId(), text, live: true, ...identified, ...from })]
    : [...nodes, stamped({ kind, id: nodeId(), text, ...identified, ...from })]
}

/** Parse the SSE body into wire events. */
async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<WireEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal.aborted) return
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const payload = frame.split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('')
        if (payload !== '') {
          try { yield JSON.parse(payload) as WireEvent } catch { /* a torn frame is dropped */ }
        }
        split = buffer.indexOf('\n\n')
      }
    }
  } finally { await reader.cancel().catch(() => undefined) }
}

/** Turn a failed response into a sentence the composer can show. */
function describe(status: number, detail: unknown): string {
  const code = detail === null || typeof detail !== 'object' ? undefined : Reflect.get(detail, 'error')
  if (code === 'not_configured') return 'No API key. Add one from the key button in the sidebar.'
  if (code === 'invalid_api_key') return 'The stored key is not a usable header value. Enter it again.'
  if (code === 'conversation_busy') return 'This conversation is already running a turn.'
  if (code === 'session_capacity') return 'The server is holding as many conversations as it may. Try again shortly.'
  if (code === 'invalid_message') return 'The prompt is empty or too long.'
  if (code === 'invalid_model') return 'That model id is not a usable one. Pick another.'
  if (code === 'invalid_effort') return 'That reasoning level is not supported by this model.'
  return `Request failed with status ${String(status)}.`
}
