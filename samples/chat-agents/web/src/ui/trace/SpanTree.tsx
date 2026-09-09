'use client'

/**
 * One run's steps: the call graph, drawn with connector lines and measured.
 *
 * The nesting is what called what — a turn holds the model rounds it made and
 * the tool calls those rounds asked for, a delegation holds the member's own
 * run, and a compaction sits beside them as maintenance. The elbows are load
 * bearing: four levels down, indentation alone stops saying which parent a row
 * belongs to.
 *
 * Each row carries its own numbers — how long the step took, and the fresh,
 * cached, and output tokens it spent — because that is what the question
 * "where did the ten seconds and the ten thousand tokens go" is actually
 * asking, and a row is where the answer can be read against the step that
 * caused it.
 */

import { useMemo, useState } from 'react'
import type { WireSpan } from '@chat-agents/backend'
import { IconChevronDownOutline14, IconChevronRightOutline14 } from '../primitives'
import { KIND_LABELS, duration, nest, place, spanLabel, tokens } from './spans'
import css from './SpanTree.module.css'

/**
 * What one step spent, as three counts.
 *
 * Fresh input, cached input, and output are kept apart because they are not
 * billed the same and they answer different questions: a step that reads as
 * expensive is often mostly cache, and one that is genuinely slow is usually
 * writing. A step that reported nothing — a tool call, a compaction — draws an
 * empty cell rather than three zeroes it would be lying about.
 * @param props.usage - The span's counters, when it has any.
 * @returns The counts, or nothing.
 */
function Tokens({ usage }: { usage: WireSpan['usage'] }) {
  if (usage === undefined) return <span className={css.tokens} />
  const cells: readonly { readonly key: string; readonly label: string; readonly count: number }[] = [
    { key: 'in', label: 'in', count: usage.inputTokens ?? 0 },
    { key: 'cache', label: 'cache', count: usage.cacheReadTokens ?? 0 },
    { key: 'out', label: 'out', count: usage.outputTokens ?? 0 },
  ]
  return (
    <span className={css.tokens}>
      {cells.map(cell => (
        <span key={cell.key} className={css.token} data-zero={cell.count === 0 || undefined}>
          <span className={css.tokenLabel}>{cell.label}</span>
          {tokens(cell.count)}
        </span>
      ))}
    </span>
  )
}


/**
 * Draw one run's span tree, with what each step took and spent.
 * @param props.spans - The run's spans.
 * @param props.selected - The span id whose details are showing.
 * @param props.onSelect - Called with a span id when a row is clicked.
 * @param props.colors - Member colours, so the run's header and its rows agree.
 * @returns The tree, or a note while the run has reported nothing.
 */
export function SpanTree({ spans, selected, onSelect, colors }: {
  spans: readonly WireSpan[]
  selected: string | undefined
  onSelect: (spanId: string) => void
  colors: ReadonlyMap<string, string>
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const nodes = useMemo(() => nest(spans), [spans])
  const rows = useMemo(() => place(nodes, collapsed), [nodes, collapsed])

  if (spans.length === 0) return <p className={css.empty}>No steps reported yet.</p>

  return (
    <div className={css.tree} role="tree" aria-label="Execution spans">
      {rows.map((row) => {
        const { span } = row
        const folded = collapsed.has(span.spanId)
        const label = spanLabel(span)
        const color = span.member === undefined ? undefined : colors.get(span.member)
        return (
          <div
            key={span.spanId}
            className={css.row}
            role="treeitem"
            aria-selected={span.spanId === selected}
            aria-expanded={row.children === 0 ? undefined : !folded}
            data-selected={span.spanId === selected || undefined}
            data-status={span.status}
            data-member={span.member === undefined ? undefined : ''}
            style={color === undefined ? undefined : { ['--member' as string]: color }}
          >
            {/*
              The fold sits in a gutter of its own, so every chevron in the tree
              lines up however deep its row is — which is what makes a long
              trace foldable without hunting for the control.
            */}
            <span className={css.gutter}>
              {row.children > 0 && (
                <button
                  type="button"
                  className={css.fold}
                  aria-label={folded ? `Expand ${span.name}` : `Collapse ${span.name}`}
                  onClick={() => {
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (!next.delete(span.spanId)) next.add(span.spanId)
                      return next
                    })
                  }}
                >
                  {folded ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
                </button>
              )}
            </span>
            <button type="button" className={css.label} onClick={() => { onSelect(span.spanId) }}>
              {row.guides.map((continues, level) => (
                <span
                  // The level IS the identity: a guide is a position, not a thing.
                  key={level}
                  className={css.guide}
                  data-line={continues || undefined}
                  aria-hidden="true"
                />
              ))}
              {row.guides.length > 0 && (
                <span className={css.elbow} data-tee={!row.last || undefined} aria-hidden="true" />
              )}
              <span className={css.kind} data-kind={span.kind}>{KIND_LABELS[span.kind]}</span>
              <span className={css.name}>{label.name}</span>
              {label.detail !== '' && <span className={css.detail}>{label.detail}</span>}
              {span.member !== undefined && <span className={css.member}>{span.member}</span>}
            </button>
            <Tokens usage={span.usage} />
            <span className={css.duration}>{duration(span.durationMs)}</span>
          </div>
        )
      })}
    </div>
  )
}
