'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_KEY_HEADER } from '../server/wire'
import type { TraceSummary, WireSpan } from '../server/traces'

export interface TraceController {
  readonly traces: readonly TraceSummary[]
  readonly loading: boolean
  readonly liveRunId: string
  isOpen: (runId: string) => boolean
  spansOf: (runId: string) => readonly WireSpan[]
  toggle: (runId: string) => void
  openAll: () => void
  closeAll: () => void
  refresh: () => Promise<void>
}

function summaryOf(live: { runId: string; spans: readonly WireSpan[] }): TraceSummary | undefined {
  if (live.runId === '' || live.spans.length === 0) return undefined
  const root = live.spans.find(span => span.parentSpanId === null)
  return {
    runId: live.runId,
    traceId: live.spans[0]?.traceId ?? '',
    startedAt: Math.min(...live.spans.map(span => span.startedAt)),
    durationMs: root?.durationMs ?? null,
    status: root === undefined || root.durationMs === null ? 'unknown' : root.status,
    spans: live.spans.length,
    prompt: typeof root?.input === 'string' ? root.input : '',
    members: [...new Set(live.spans.flatMap(span => span.member === undefined ? [] : [span.member]))],
    usage: usageOf(live.spans),
  }
}

function usageOf(spans: readonly WireSpan[]): TraceSummary['usage'] {
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

export function useTraces({
  conversationId, open, live, apiKey,
}: {
  conversationId: string
  open: boolean
  live: { runId: string; spans: readonly WireSpan[] }
  apiKey?: string
}): TraceController {
  const [stored, setStored] = useState<readonly TraceSummary[]>([])
  const [spansByRun, setSpansByRun] = useState<Readonly<Record<string, readonly WireSpan[]>>>({})
  const [loading, setLoading] = useState(false)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const requested = useRef(new Set<string>())
  const headers = useMemo(() => apiKey === undefined ? {} : { [API_KEY_HEADER]: apiKey }, [apiKey])

  const refresh = useCallback(async () => {
    if (conversationId === '') return
    const response = await fetch(`/api/conversations/${conversationId}/traces`, { headers })
    if (!response.ok) return
    const body = await response.json() as { traces: readonly TraceSummary[] }
    setStored(body.traces)
  }, [conversationId, headers])

  useEffect(() => {
    setStored([])
    setSpansByRun({})
    setOpened(new Set())
    requested.current.clear()
  }, [conversationId])

  useEffect(() => {
    if (!open || conversationId === '') return
    setLoading(true)
    void refresh().finally(() => { setLoading(false) })
  }, [open, conversationId, refresh])

  useEffect(() => {
    if (live.runId === '') return
    setOpened(current => current.has(live.runId) ? current : new Set([...current, live.runId]))
  }, [live.runId])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, live.runId, refresh])

  const traces = useMemo(() => {
    const current = summaryOf(live)
    const merged = current === undefined
      ? stored
      : [current, ...stored.filter(trace => trace.runId !== current.runId)]
    return [...merged].sort((left, right) => left.startedAt - right.startedAt)
  }, [live, stored])

  useEffect(() => {
    if (!open) return
    for (const runId of opened) {
      if (runId === live.runId || requested.current.has(runId)) continue
      requested.current.add(runId)
      void fetch(`/api/traces/${runId}`, { headers })
        .then(async response => {
          if (!response.ok) throw new Error('trace request failed')
          return await response.json() as { spans: readonly WireSpan[] }
        })
        .then(body => { setSpansByRun(previous => ({ ...previous, [runId]: body.spans })) })
        .catch(() => { requested.current.delete(runId) })
    }
  }, [open, opened, live.runId, headers])

  return {
    traces,
    loading,
    liveRunId: live.runId,
    isOpen: runId => opened.has(runId),
    spansOf: runId => runId === live.runId ? live.spans : spansByRun[runId] ?? [],
    toggle: runId => setOpened(current => {
      const next = new Set(current)
      if (!next.delete(runId)) next.add(runId)
      return next
    }),
    openAll: () => setOpened(new Set(traces.map(trace => trace.runId))),
    closeAll: () => setOpened(new Set()),
    refresh: async () => {
      requested.current.clear()
      setSpansByRun({})
      await refresh()
    },
  }
}
