'use client'

/**
 * The team roster strip.
 *
 * During a team run the lead delegates to members; this shows who exists, who
 * is working right now, and how many tools each has run — the same read the
 * harness's team panel gives, without a task board the SDK does not have.
 */

import clsx from 'clsx'
import { StateDot } from '../primitives'
import type { MemberState } from './types'
import css from './TeamRoster.module.css'

export interface TeamRosterProps {
  members: readonly MemberState[]
  /** Filter the transcript to one member; null shows everyone. */
  focused: string | null
  onFocus: (member: string | null) => void
}

/**
 * Render the roster.
 * @param props - Members plus the focus filter.
 * @returns The strip, or null when no member has appeared.
 */
export function TeamRoster({ members, focused, onFocus }: TeamRosterProps) {
  if (members.length === 0) return null
  return (
    <div className={css.strip}>
      <button
        type="button"
        className={clsx(css.chip, focused === null && css.chipActive)}
        onClick={() => { onFocus(null) }}
      >
        Everyone
      </button>
      {members.map(member => (
        <button
          type="button"
          key={member.name}
          className={clsx(css.chip, focused === member.name && css.chipActive)}
          onClick={() => { onFocus(focused === member.name ? null : member.name) }}
        >
          <StateDot state={member.status === 'running' ? 'ongoing' : member.status === 'done' ? 'done' : 'warning'} />
          <span className={css.name}>{member.name}</span>
          {member.toolCalls > 0 && <span className={css.count}>{member.toolCalls}</span>}
        </button>
      ))}
    </div>
  )
}
