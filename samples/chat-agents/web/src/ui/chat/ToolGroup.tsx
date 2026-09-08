'use client'

/**
 * A run of consecutive tool calls, folded behind one line.
 *
 * The transcript folds a finished turn, and every tool row already folds its
 * own output — but between those two sat a flat list of every call the agent
 * made, which is what a hundred-step run actually looks like. This is the
 * missing middle: the calls stay in the record, and the prose around them
 * becomes readable again.
 */

import { useState } from 'react'
import clsx from 'clsx'
import { IconChevronDownOutline14, IconChevronRightOutline14, StateDot } from '../primitives'
import { TITLES, ToolNode } from './ToolNode'
import { toolGroupSummary } from './toolDisplay'
import type { ChatNode } from './types'
import css from './ToolGroup.module.css'

type ToolChatNode = Extract<ChatNode, { kind: 'tool' }>

export interface ToolGroupProps {
  /** The run's calls, in order; all settled. */
  nodes: readonly ChatNode[]
}

/**
 * Render one folded run of calls.
 * @param props - The calls in the run.
 * @returns The summary row, and the calls when it is open.
 */
export function ToolGroup({ nodes }: ToolGroupProps) {
  const calls = nodes.filter((node): node is ToolChatNode => node.kind === 'tool')
  const failed = calls.filter(node => node.state === 'error').length
  // Open by default only when something in it failed: a fold that hides a
  // failure is hiding the one row the reader came for. `null` keeps that a
  // default rather than a decision, so a click still wins.
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? failed > 0

  return (
    <div className={css.group}>
      <button
        type="button"
        className={css.toggle}
        aria-expanded={expanded}
        onClick={() => { setOpen(!expanded) }}
      >
        {expanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
        {failed > 0 && <StateDot state="error" />}
        <span className={clsx(css.label, failed > 0 && css.failed)}>
          {toolGroupSummary(calls.map(node => TITLES[node.name] ?? node.name))}
          {failed > 0 && ` · ${String(failed)} failed`}
        </span>
      </button>
      {expanded && (
        <div className={css.rows}>
          {calls.map((node, index) => (
            <ToolNode key={`${node.id}-${String(index)}`} node={node} />
          ))}
        </div>
      )}
    </div>
  )
}
