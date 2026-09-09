'use client'

/**
 * The traces of one conversation, and which of them are open.
 *
 * Two sources, one list. A finished run's spans are read back from the server,
 * which stores every span of every run; the run in flight is read from the
 * stream the chat is already consuming, so the waterfall grows while the agent
 * works instead of appearing once it stops.
 *
 * Runs are collapsed by default — a conversation's tenth prompt is not asking
 * about the first nine — and a run is fetched only when it is opened. The run
 * in flight is the exception: it opens itself, because watching it is the whole
 * reason to have this view open while an agent is working.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TraceSummary, WireSpan } from '@chat-agents/backend'

export interface TraceController {
  /**
   * Runs of this conversation in the order they happened, oldest first.
   *
   * The server answers newest-first, because a cap on how many runs it reports
   * has to keep the RECENT ones. The view reads the other way round: a run
   * follows the prompt that caused it, so the newest — the one still working —
   * is at the bottom, where the transcript also puts it.
   */
  readonly traces: readonly TraceSummary[]
  /** True while the first fetch for this conversation is outstanding. */
  readonly loading: boolean
  /** The run in flight, or an empty string. */
  readonly liveRunId: string
  /** Whether this run's steps are showing. */
  isOpen: (runId: string) => boolean
  /** Spans of one run, empty when it has not been read yet. */
  spansOf: (runId: string) => readonly WireSpan[]
  toggle: (runId: string) => void
  openAll: () => void
  closeAll: () => void
  refresh: () => Promise<void>
}

/**
 * Sum what the run's model rounds spent.
 *
 * The server sums a stored run the same way, but that code is server-only —
 * importing a VALUE from the backend package drags Node-only modules into the
 * browser bundle, and the app deliberately takes only types from it.
 * @param spans - The run's spans.
 * @returns Fresh input, cached input, and output, from the model rounds alone:
 * a turn span reports the turn's aggregate and would double the count.
 */
function sumUsage(spans: readonly WireSpan[]): TraceSummary['usage'] {
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  for (const span of spans) {
    if (span.kind !== 'chat' || span.usage === undefined) continue
    inputTokens += span.usage.inputTokens ?? 0
    cacheReadTokens += span.usage.cacheReadTokens ?? 0
    outputTokens += span.usage.outputTokens ?? 0
  }
  return { inputTokens, cacheReadTokens, outputTokens }
}

/** Everything a live run gives the trace view before its spans are stored. */
interface Live {
  readonly runId: string
  readonly spans: readonly WireSpan[]
}

/**
 * Describe the run in flight the way a stored one is described.
 *
 * The list comes from the database, so a run whose first span was written
 * after the fetch would be missing from it — and the run the user most wants
 * to watch is exactly the one that is still going.
 * @param live - The run in flight and the spans it has reported.
 * @returns A summary, or undefined when nothing is running.
 */
function liveSummary(live: Live): TraceSummary | undefined {
  if (live.runId === '' || live.spans.length === 0) return undefined
  const root = live.spans.find(span => span.parentSpanId === null)
  const input = root?.input
  return {
    runId: live.runId,
    traceId: live.spans[0]?.traceId ?? '',
    startedAt: Math.min(...live.spans.map(span => span.startedAt)),
    durationMs: root?.durationMs ?? null,
    status: root === undefined || root.durationMs === null ? 'unknown' : root.status,
    spans: live.spans.length,
    prompt: typeof input === 'string' ? input : '',
    members: [...new Set(live.spans.flatMap(span => span.member === undefined ? [] : [span.member]))],
    usage: sumUsage(live.spans),
  }
}

/**
 * Follow one conversation's traces.
 * @param options.conversationId - The conversation to read.
 * @param options.open - Whether the view is showing; nothing is fetched while closed.
 * @param options.live - The run in flight, from the chat stream.
 * @returns The list, what is open, and each open run's spans.
 */
export function useTraces({ conversationId, open, live }: {
  conversationId: string
  open: boolean
  live: Live
}): TraceController {
  const [stored, setStored] = useState<readonly TraceSummary[]>([])
  const [spansByRun, setSpansByRun] = useState<Readonly<Record<string, readonly WireSpan[]>>>({})
  const [loading, setLoading] = useState(false)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  /**
   * Runs whose fetch is in flight or done.
   *
   * A ref, not state: it exists to keep one request per run, and re-rendering
   * on it would be a render caused by bookkeeping alone.
   */
  const requested = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    if (conversationId === '') return
    const response = await fetch(`/api/conversations/${conversationId}/traces`)
    if (!response.ok) return
    const body = await response.json() as { traces: readonly TraceSummary[] }
    setStored(body.traces)
  }, [conversationId])

  useEffect(() => {
    if (!open || conversationId === '') return
    let cancelled = false
    setLoading(true)
    void (async () => {
      await refresh()
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [open, conversationId, refresh])

  // A conversation switch invalidates everything: another conversation's runs
  // are not this one's, and neither is what was open in it.
  useEffect(() => {
    setSpansByRun({})
    setOpened(new Set())
    requested.current.clear()
  }, [conversationId])

  // A run that ends while the view is open has more to say than the stream
  // delivered — its own duration and status — so the list is re-read when the
  // live run changes identity.
  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, live.runId, refresh])

  // The run in flight opens itself, once.
  useEffect(() => {
    if (live.runId === '') return
    setOpened((current) => {
      if (current.has(live.runId)) return current
      const next = new Set(current)
      next.add(live.runId)
      return next
    })
  }, [live.runId])

  const traces = useMemo(() => {
    const running = liveSummary(live)
    const merged = running === undefined
      ? stored
      : [running, ...stored.filter(trace => trace.runId !== running.runId)]
    return [...merged].sort((left, right) => left.startedAt - right.startedAt)
  }, [stored, live])

  // Read what has been opened and not yet read. The live run needs no request:
  // its spans arrive on the stream, ahead of the database.
  useEffect(() => {
    if (!open) return
    for (const runId of opened) {
      if (runId === live.runId || requested.current.has(runId)) continue
      requested.current.add(runId)
      void (async () => {
        const response = await fetch(`/api/traces/${runId}`)
        if (!response.ok) {
          requested.current.delete(runId)
          return
        }
        const body = await response.json() as { spans: readonly WireSpan[] }
        setSpansByRun(previous => ({ ...previous, [runId]: body.spans }))
      })()
    }
  }, [open, opened, live.runId])

  const spansOf = useCallback((runId: string): readonly WireSpan[] => (
    runId === live.runId ? live.spans : spansByRun[runId] ?? []
  ), [live.runId, live.spans, spansByRun])

  return {
    traces,
    loading,
    liveRunId: live.runId,
    isOpen: (runId: string) => opened.has(runId),
    spansOf,
    toggle: (runId: string) => {
      setOpened((current) => {
        const next = new Set(current)
        if (!next.delete(runId)) next.add(runId)
        return next
      })
    },
    openAll: () => { setOpened(new Set(traces.map(trace => trace.runId))) },
    closeAll: () => { setOpened(new Set()) },
    refresh: async () => {
      // Whatever was read may have grown since; the open runs are read again.
      requested.current.clear()
      setSpansByRun({})
      await refresh()
    },
  }
}
