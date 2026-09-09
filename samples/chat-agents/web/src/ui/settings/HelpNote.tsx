'use client'

/**
 * A pane's one-line summary, with its full explanation folded behind a
 * question mark.
 *
 * The panes teach how the SDK behaves, which is worth keeping — but a wall of
 * prose above every list makes a settings dialog read like documentation. The
 * summary stays visible; the detail is one click away.
 */

import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconQuestionOutline14 } from '../primitives/icons/index'
import css from './HelpNote.module.css'

/**
 * Render the summary line, its toggle, and the collapsible note.
 * @param props.summary - The always-visible line describing the pane.
 * @param props.label - Accessible name for the toggle, naming what it explains.
 * @param props.children - The explanation, shown only while expanded.
 * @returns The summary row plus the note.
 */
export function HelpNote({
  summary,
  label,
  children,
}: {
  summary: string
  label: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const id = useId()

  return (
    <div className={css.root}>
      <div className={css.head}>
        <p className={css.summary}>{summary}</p>
        <button
          type="button"
          className={clsx(css.toggle, open && css.toggleOpen)}
          aria-expanded={open}
          aria-controls={id}
          aria-label={label}
          title={label}
          onClick={() => { setOpen(current => !current) }}
        >
          <IconQuestionOutline14 />
        </button>
      </div>
      <div className={css.note} id={id} hidden={!open}>{children}</div>
    </div>
  )
}
