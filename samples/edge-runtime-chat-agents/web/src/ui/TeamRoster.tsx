'use client'

/**
 * The team roster strip, above the composer.
 *
 * During a team run the lead delegates to peers; this shows who exists, who is
 * working right now, and how many tools each has run. Clicking a member filters
 * the transcript to that member, which is how a delegated stretch is read back
 * without the lead's own output between every line.
 */

import clsx from 'clsx'
import { StateDot } from './primitives'
import type { MemberState } from './types'
import css from './TeamRoster.module.css'

export interface TeamRosterProps {
  members: readonly MemberState[]
  /** Filter the transcript to one member; null shows everyone. */
  focused: string | null
  onFocus: (member: string | null) => void
  /** Opens the roster editor. Absent for a model-created Team Auto roster. */
  onEdit?: () => void
}

/**
 * Render the roster.
 * @param props - Members, the focus filter, and the editor action.
 * @returns The strip, or null when there is no team.
 */
export function TeamRoster({ members, focused, onFocus, onEdit }: TeamRosterProps) {
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
          <StateDot
            state={member.status === 'running'
              ? 'ongoing'
              : member.status === 'failed' ? 'warning' : 'done'}
          />
          <span className={css.name}>{member.name}</span>
          {member.model !== undefined && <span className={css.model}>{member.model}</span>}
          {member.toolCalls > 0 && <span className={css.count}>{member.toolCalls}</span>}
        </button>
      ))}
      {onEdit !== undefined && (
        <button type="button" className={clsx(css.chip, css.edit)} onClick={onEdit}>
          Edit
        </button>
      )}
    </div>
  )
}
