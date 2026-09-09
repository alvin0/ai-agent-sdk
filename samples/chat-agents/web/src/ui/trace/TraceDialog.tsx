'use client'

/**
 * The trace view: this conversation's runs, step by step.
 *
 * The transcript says what the agent produced. This says how it got there —
 * every turn, model round, tool call, compaction and delegation, nested the way
 * they actually called one another, with the time each one took and the tokens
 * it spent.
 *
 * Runs are listed in the order they happened and start folded, because a
 * conversation's tenth prompt is not asking about the first nine: a folded run
 * is one line saying what was asked, how long it took, what it cost, and which
 * agents worked on it. The newest is at the BOTTOM, where the transcript puts
 * it too, and the view opens scrolled to it. The run in flight is unfolded on
 * arrival and streams its steps as they happen.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TraceSummary, WireSpan } from '@chat-agents/backend'
import {
  IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconRefreshOutline16, Modal,
} from '../primitives'
import { SpanDetails } from './SpanDetails'
import { SpanTree } from './SpanTree'
import { duration, memberColors, tokens } from './spans'
import { useTraces } from './useTraces'
import css from './TraceDialog.module.css'

/** What the status pill says for each run state. */
const STATUS_LABELS: Readonly<Record<WireSpan['status'], string>> = {
  success: 'Success',
  error: 'Error',
  aborted: 'Stopped',
  unknown: 'Running',
}

/** Clock time, which is how a run is recognised hours later. */
function clock(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * One run: its folded summary line, and its steps when open.
 * @param props.trace - The run's summary.
 * @param props.open - Whether its steps are showing.
 * @param props.live - Whether this is the run still working.
 * @param props.spans - Its spans; empty until it has been read.
 * @param props.selected - The span whose details are showing.
 * @param props.onToggle - Fold or unfold this run.
 * @param props.onSelect - Select a span.
 * @returns The run's section of the list.
 */
function Run({ trace, open, live, spans, selected, onToggle, onSelect }: {
  trace: TraceSummary
  open: boolean
  live: boolean
  spans: readonly WireSpan[]
  selected: string | undefined
  onToggle: () => void
  onSelect: (spanId: string) => void
}) {
  // Named from the SUMMARY, not from the spans: a folded run has no spans yet,
  // and its colours must not change when opening it reveals them.
  const colors = useMemo(() => memberColors(trace.members), [trace.members])
  return (
    <section className={css.run} data-open={open || undefined} data-live={live || undefined}>
      <button type="button" className={css.runHead} onClick={onToggle} aria-expanded={open}>
        <span className={css.runFold}>
          {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        </span>
        <span className={css.runTitle}>
          <span className={css.runPrompt}>
            {trace.prompt === '' ? trace.runId : trace.prompt}
          </span>
          <span className={css.runFacts}>
            <span className={css.status} data-status={trace.status}>
              {live ? 'Running' : STATUS_LABELS[trace.status]}
            </span>
            <span>{clock(trace.startedAt)}</span>
            <span>{duration(trace.durationMs)}</span>
            <span>{`${String(trace.spans)} steps`}</span>
            {/* The run's own total, so a folded run says what it cost before
                anyone opens it and reads the same numbers step by step. */}
            <span className={css.runTokens}>
              {`${tokens(trace.usage.inputTokens)} in`}
              {trace.usage.cacheReadTokens > 0 && ` · ${tokens(trace.usage.cacheReadTokens)} cached`}
              {` · ${tokens(trace.usage.outputTokens)} out`}
            </span>
          </span>
        </span>
        {/* The roster, in the colours its rows are drawn in, so a team run can
            be recognised before it is even opened. */}
        {trace.members.length > 0 && (
          <span className={css.roster}>
            {trace.members.map(member => (
              <span
                key={member}
                className={css.rosterChip}
                style={{ ['--member' as string]: colors.get(member) as string }}
              >
                {member}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <SpanTree spans={spans} selected={selected} onSelect={onSelect} colors={colors} />
      )}
    </section>
  )
}

/**
 * Show the traces of one conversation.
 * @param props.open - Whether the view is showing.
 * @param props.onClose - Close it.
 * @param props.conversationId - The conversation whose runs are listed.
 * @param props.liveRunId - The run in flight, or an empty string.
 * @param props.liveSpans - Spans the run in flight has reported so far.
 * @returns The trace dialog, or null while closed.
 */
export function TraceDialog({ open, onClose, conversationId, liveRunId, liveSpans }: {
  open: boolean
  onClose: () => void
  conversationId: string
  liveRunId: string
  liveSpans: readonly WireSpan[]
}) {
  const trace = useTraces({
    conversationId,
    open,
    live: { runId: liveRunId, spans: liveSpans },
  })
  const [selectedSpan, setSelectedSpan] = useState<string | undefined>(undefined)
  const list = useRef<HTMLDivElement | null>(null)

  /** Every span currently on screen, so a selection can be resolved to one. */
  const shown = trace.traces.flatMap(row => (
    trace.isOpen(row.runId) ? trace.spansOf(row.runId) : []
  ))
  const selected = shown.find(span => span.spanId === selectedSpan)

  /**
   * Follow the live run.
   *
   * With nothing selected, the details pane would sit empty through the whole
   * run; landing on the turn's own span puts the prompt there, and the answer
   * in it when the run ends.
   */
  useEffect(() => {
    if (liveRunId === '' || liveSpans.length === 0) return
    setSelectedSpan((current) => {
      if (current !== undefined) return current
      return liveSpans.find(span => span.parentSpanId === null)?.spanId ?? liveSpans[0]?.spanId
    })
  }, [liveRunId, liveSpans])

  // A conversation switch leaves a span id that belongs to another chat.
  useEffect(() => { setSelectedSpan(undefined) }, [conversationId])

  /**
   * Open on the newest run.
   *
   * The list runs oldest to newest, so the interesting end is the bottom one.
   * Only on open and when a run is ADDED: re-scrolling as the live run streams
   * would fight anyone reading further up.
   */
  useEffect(() => {
    if (!open) return
    const node = list.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [open, trace.traces.length])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trace"
      // The dialog draws its own header: the run list's controls belong beside
      // the title, which the default chrome has no room for.
      headless
      className={css.dialog}
    >
      <header className={css.head}>
        <h2 className={css.title}>Trace</h2>
        <p className={css.subtitle}>
          {trace.traces.length === 0
            ? 'No runs traced yet'
            : `${String(trace.traces.length)} run${trace.traces.length === 1 ? '' : 's'} in this conversation`}
        </p>
        <div className={css.actions}>
          <button type="button" className={css.action} onClick={trace.openAll}>Expand all</button>
          <button type="button" className={css.action} onClick={trace.closeAll}>Collapse all</button>
          <button
            type="button"
            className={css.iconButton}
            title="Reload from the server"
            aria-label="Reload from the server"
            onClick={() => { void trace.refresh() }}
          >
            <IconRefreshOutline16 />
          </button>
          <button
            type="button"
            className={css.iconButton}
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <IconCloseOutline16 />
          </button>
        </div>
      </header>

      <div className={css.panes}>
        <div className={css.left} ref={list}>
          {trace.traces.length === 0
            ? (
              <p className={css.empty}>
                {trace.loading
                  ? 'Reading traces…'
                  : 'Nothing traced yet. Send a prompt and its steps appear here as they happen.'}
              </p>
            )
            : trace.traces.map(row => (
              <Run
                key={row.runId}
                trace={row}
                open={trace.isOpen(row.runId)}
                live={row.runId === trace.liveRunId}
                spans={trace.spansOf(row.runId)}
                selected={selectedSpan}
                onToggle={() => { trace.toggle(row.runId) }}
                onSelect={setSelectedSpan}
              />
            ))}
        </div>
        <div className={css.right}>
          <SpanDetails span={selected} />
        </div>
      </div>
    </Modal>
  )
}
