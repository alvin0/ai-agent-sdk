'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TraceSummary, WireSpan } from '../server/traces'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconCloseOutline16, IconCopyOutline16, IconRefreshOutline16 } from './primitives'
import { duration, kindLabel, memberColors, spanDetail, tokens } from './traceView'
import { useTraces } from './useTraces'
import css from './TraceDialog.module.css'

type Tab = 'io' | 'metadata'

export function TraceDialog({ open, onClose, conversationId, apiKey, liveRunId, liveSpans }: {
  open: boolean
  onClose: () => void
  conversationId: string
  apiKey?: string
  liveRunId: string
  liveSpans: readonly WireSpan[]
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const traces = useTraces({ conversationId, open, live: { runId: liveRunId, spans: liveSpans }, ...apiKey === undefined ? {} : { apiKey } })
  const [selected, setSelected] = useState<string | undefined>()
  const shown = traces.traces.flatMap(row => traces.isOpen(row.runId) ? traces.spansOf(row.runId) : [])
  const selectedSpan = shown.find(span => span.spanId === selected)

  useEffect(() => {
    const node = dialog.current
    if (node === null) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])
  useEffect(() => {
    if (liveSpans.length === 0 || selected !== undefined) return
    setSelected(liveSpans.find(span => span.parentSpanId === null)?.spanId ?? liveSpans[0]?.spanId)
  }, [liveSpans, selected])
  useEffect(() => { setSelected(undefined) }, [conversationId])

  return (
    <dialog ref={dialog} className={css.dialog} onCancel={event => { event.preventDefault(); onClose() }}>
      <div className={css.shell}>
        <header className={css.head}>
          <h2 className={css.title}>Request trace</h2>
          <p className={css.subtitle}>{traces.traces.length === 0 ? 'No runs traced yet' : `${traces.traces.length} run${traces.traces.length === 1 ? '' : 's'}`}</p>
          <div className={css.actions}>
            <button type="button" className={css.action} onClick={traces.openAll}>Expand all</button>
            <button type="button" className={css.action} onClick={traces.closeAll}>Collapse all</button>
            <button type="button" className={css.iconButton} title="Refresh" onClick={() => { void traces.refresh() }}><IconRefreshOutline16 /></button>
            <button type="button" className={css.iconButton} title="Close" onClick={onClose}><IconCloseOutline16 /></button>
          </div>
        </header>
        <div className={css.panes}>
          <div className={css.left}>
            {traces.traces.length === 0
              ? <p className={css.empty}>{traces.loading ? 'Reading traces…' : 'Send a prompt to see its request lifecycle here.'}</p>
              : traces.traces.map(row => <Run key={row.runId} trace={row} open={traces.isOpen(row.runId)} live={row.runId === traces.liveRunId} spans={traces.spansOf(row.runId)} {...selected === undefined ? {} : { selected }} colors={memberColors(row.members)} onToggle={() => { traces.toggle(row.runId) }} onSelect={setSelected} />)}
          </div>
          <Details span={selectedSpan} />
        </div>
      </div>
    </dialog>
  )
}

function Run({ trace, open, live, spans, selected, colors, onToggle, onSelect }: {
  trace: TraceSummary; open: boolean; live: boolean; spans: readonly WireSpan[]; selected?: string
  colors: ReadonlyMap<string, string>; onToggle: () => void; onSelect: (id: string) => void
}) {
  return (
    <section className={css.run}>
      <button type="button" className={css.runHead} onClick={onToggle} aria-expanded={open}>
        <span className={css.fold}>{open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span className={css.prompt}>{trace.prompt || trace.runId}</span>
          <span className={css.facts}>
            <span className={css.status} data-status={live ? 'unknown' : trace.status}>{live ? 'Running' : trace.status}</span>
            <span>{new Date(trace.startedAt).toLocaleTimeString()}</span><span>{duration(trace.durationMs)}</span><span>{trace.spans} steps</span>
            <span>{tokens(trace.usage.inputTokens)} in · {tokens(trace.usage.outputTokens)} out</span>
          </span>
        </span>
        <span className={css.members}>{trace.members.map(member => <span key={member} className={css.member} style={{ ['--member' as string]: colors.get(member) }}>{member}</span>)}</span>
      </button>
      {open && <Tree spans={spans} {...selected === undefined ? {} : { selected }} colors={colors} onSelect={onSelect} />}
    </section>
  )
}

function Tree({ spans, selected, colors, onSelect }: { spans: readonly WireSpan[]; selected?: string; colors: ReadonlyMap<string, string>; onSelect: (id: string) => void }) {
  const children = useMemo(() => {
    const map = new Map<string | null, WireSpan[]>()
    for (const span of [...spans].sort((a, b) => a.seq - b.seq)) {
      const bucket = map.get(span.parentSpanId) ?? []
      bucket.push(span); map.set(span.parentSpanId, bucket)
    }
    return map
  }, [spans])
  const draw = (span: WireSpan, depth: number): ReactNode => (
    <div key={span.spanId}>
      <button type="button" className={css.treeRow} data-selected={span.spanId === selected} style={{ marginLeft: depth * 16, borderLeftColor: span.member === undefined ? undefined : colors.get(span.member) }} onClick={() => { onSelect(span.spanId) }}>
        <span className={css.kind}>{kindLabel(span.kind)}</span><span className={css.name}>{spanDetail(span).name}</span><span className={css.detail}>{spanDetail(span).detail}</span>{span.member !== undefined && <span className={css.memberName}>{span.member}</span>}<span className={css.rowFacts}>{duration(span.durationMs)} · {span.usage === undefined ? '' : `${tokens(span.usage.outputTokens ?? 0)} out`}</span>
      </button>
      {(children.get(span.spanId) ?? []).map(child => draw(child, depth + 1))}
    </div>
  )
  const roots = children.get(null) ?? spans.filter(span => span.parentSpanId !== null && !spans.some(parent => parent.spanId === span.parentSpanId))
  return <div className={css.tree}>{roots.length === 0 ? <p className={css.empty}>No steps reported yet.</p> : roots.map(span => draw(span, 0))}</div>
}

function Details({ span }: { span: WireSpan | undefined }) {
  const [tab, setTab] = useState<Tab>('io')
  if (span === undefined) return <div className={css.detailPane}><p className={css.empty}>Select a step to inspect its input, output and metadata.</p></div>
  const body = tab === 'metadata' ? JSON.stringify(span, null, 2) : span.input === undefined && span.output === undefined ? 'This step recorded no input or output.' : `INPUT\n${readable(span.input)}\n\nOUTPUT\n${readable(span.output)}`
  return <div className={css.detailPane}>
    <div className={css.detailHead}><h3 className={css.detailTitle}>{span.name}</h3><span className={css.rowFacts}>{duration(span.durationMs)}</span></div>
    <p className={css.stamp}>{new Date(span.startedAt).toLocaleString()} · {span.status}</p>
    <nav className={css.tabs}><button type="button" className={css.tab} data-active={tab === 'io'} onClick={() => { setTab('io') }}>Input + Output</button><button type="button" className={css.tab} data-active={tab === 'metadata'} onClick={() => { setTab('metadata') }}>Metadata</button></nav>
    <div className={css.body}>{span.error !== undefined && <p className={css.error}>{span.error.message}</p>}{span.usage !== undefined && <div className={css.usage}>{Object.entries(span.usage).map(([key, value]) => <div key={key} className={css.usageCell}><span className={css.usageKey}>{key}</span><span className={css.usageValue}>{String(value)}</span></div>)}</div>}<CopyBlock body={body} /></div>
  </div>
}

function CopyBlock({ body }: { body: string }) {
  const [copied, setCopied] = useState(false)
  return <section className={css.block}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h4 className={css.blockTitle}>Recorded data</h4><button type="button" className={css.iconButton} title="Copy" onClick={() => { const pending = navigator.clipboard?.writeText(body); void pending?.then(() => { setCopied(true); window.setTimeout(() => { setCopied(false) }, 1200) }) }}><IconCopyOutline16 /></button></div><pre className={css.code}>{copied ? 'Copied' : body}</pre></section>
}

function readable(value: unknown): string { if (value === undefined) return '(none)'; if (typeof value === 'string') return value; try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) } }
