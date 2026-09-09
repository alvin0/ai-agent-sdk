'use client'

/**
 * The `/` menu over the composer.
 *
 * A skill is advertised to the MODEL by name and description and loaded when
 * the model decides it applies — which leaves the user with no way to say "use
 * the review skill, now" short of describing it in prose and hoping. `/` is
 * that way: it names the skill in the message, and the backend asks the model
 * to load it before acting.
 *
 * Presentation only. The pick writes text into the draft; nothing is executed
 * here, and a skill named by mistake is a sentence in a prompt rather than
 * instructions already spliced into the model's context.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { SkillMention } from '@chat-agents/backend'
import { IconCloseFill14, IconSkillOutline16 } from '../primitives/icons'
import { mentionRanges, skillTitle } from './mentions'
import css from './SkillMenu.module.css'

/** Where each skill came from, in the words a person uses about it. */
const PROVIDERS: Readonly<Record<string, string>> = {
  project: 'Project',
  global: 'Global',
}

/**
 * Render the open menu.
 * @param props - The matches, the highlighted index, and the pick callback.
 * @returns The menu, or null when there is nothing to offer.
 */
export function SkillMenu({
  skills,
  active,
  onPick,
  onHover,
}: {
  skills: readonly SkillMention[]
  active: number
  onPick: (skill: SkillMention) => void
  onHover: (index: number) => void
}) {
  if (skills.length === 0) return null
  return (
    <div className={css.menu} role="listbox" aria-label="Skills">
      {skills.map((skill, index) => (
        <button
          type="button"
          key={skill.id}
          role="option"
          aria-selected={index === active}
          className={clsx(css.row, index === active && css.rowActive)}
          // The composer keeps focus: a pick on mousedown means the textarea is
          // never blurred, so the caret is still where the completion goes.
          onMouseDown={(event) => {
            event.preventDefault()
            onPick(skill)
          }}
          onMouseEnter={() => { onHover(index) }}
        >
          <IconSkillOutline16 className={css.icon} />
          <span className={css.name}>{skillTitle(skill)}</span>
          <span className={css.description}>{skill.whenToUse ?? skill.description}</span>
          <span className={css.provider}>{PROVIDERS[skill.provider] ?? skill.provider}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * The skills attached to the message being composed.
 *
 * A mention picked from the menu leaves the text and becomes one of these: the
 * message reads as a sentence again, and what is attached is a thing you can
 * see and remove rather than a word you have to notice and edit out.
 * @param props - The picked skills and the removal callback.
 * @returns The chips, or null when nothing is attached.
 */
export function SkillChips({
  skills,
  onRemove,
}: {
  skills: readonly SkillMention[]
  onRemove: (id: string) => void
}) {
  if (skills.length === 0) return null
  return (
    <>
      {skills.map(skill => (
        <span key={skill.id} className={css.chip}>
          <IconSkillOutline16 className={css.chipIcon} />
          <span className={css.chipLabel}>{skillTitle(skill)}</span>
          <button
            type="button"
            className={css.chipRemove}
            aria-label={`Remove ${skillTitle(skill)}`}
            // Mousedown, not click: the composer must not lose the caret to a
            // button that removes something next to it.
            onMouseDown={(event) => {
              event.preventDefault()
              onRemove(skill.id)
            }}
          >
            <IconCloseFill14 />
          </button>
        </span>
      ))}
    </>
  )
}

/**
 * Draw the composer's text with its mentions coloured.
 *
 * Rendered only while the draft HAS a mention: without one the textarea draws
 * its own text exactly as it always did, so the ordinary case carries none of
 * this layer's risk. With one, the textarea's glyphs go transparent (its caret
 * does not) and this layer draws them instead.
 * @param props - The draft, the catalogue, and the textarea's scroll offset.
 * @returns The drawn layer, or null when there is no mention to colour.
 */
export function MentionHighlights({
  draft,
  skills,
  scrollTop,
}: {
  draft: string
  skills: readonly SkillMention[]
  scrollTop: number
}) {
  const ranges = useMemo(() => mentionRanges(draft, skills), [draft, skills])
  if (ranges.length === 0) return null
  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(draft.slice(cursor, start))
    parts.push(<span key={start} className={css.mention}>{draft.slice(start, end)}</span>)
    cursor = end
  }
  // The trailing newline keeps a draft that ENDS in a newline the same height
  // here as in the textarea, which is what keeps the last line aligned.
  parts.push(`${draft.slice(cursor)}\n`)
  return (
    <div className={css.highlights} aria-hidden="true" style={{ transform: `translateY(${String(-scrollTop)}px)` }}>
      {parts}
    </div>
  )
}

/**
 * Keep the highlight inside the match list.
 *
 * The list is re-filtered on every keystroke, so an index that pointed at the
 * fourth match can outlive it. Clamping in a hook rather than at the call sites
 * keeps "Enter picks what is highlighted" true after every edit.
 * @param length - How many matches there are now.
 * @returns The active index and its setter.
 */
export function useActiveIndex(length: number): [number, (index: number) => void] {
  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [length])
  const bounded = length === 0 ? 0 : Math.min(active, length - 1)
  return [bounded, setActive]
}

/**
 * The skills a group offers, fetched once per group.
 * @param groupId - The open conversation's project.
 * @returns The catalogue; empty until it has loaded.
 */
export function useSkillCatalogue(groupId: string, open: boolean): readonly SkillMention[] {
  const [skills, setSkills] = useState<readonly SkillMention[]>([])
  // Re-fetched when the menu OPENS, not on every keystroke: a skill folder
  // added while the tab was open would otherwise be missing from the menu until
  // the page was reloaded, and the user has no way to know the list is stale.
  const [generation, setGeneration] = useState(0)
  useEffect(() => { if (open) setGeneration(count => count + 1) }, [open])
  useEffect(() => {
    if (groupId === '') {
      setSkills([])
      return
    }
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(`/api/groups/${groupId}/skills/available`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const body = await response.json() as { skills: SkillMention[] }
        setSkills(body.skills)
      } catch {
        // The menu is a convenience; a project whose skill roots cannot be read
        // still has a working composer.
      }
    })()
    return () => { controller.abort() }
  }, [groupId, generation])
  return useMemo(() => skills, [skills])
}
