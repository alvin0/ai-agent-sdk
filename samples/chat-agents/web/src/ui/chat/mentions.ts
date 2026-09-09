/**
 * Reading and completing a `/skill` mention.
 *
 * The pure half of the composer's `/` menu: no React, no DOM, no CSS — which is
 * also what lets the rules the UI applies be tested against the rules the
 * backend applies, in one place, without a browser.
 */

import type { SkillMention } from '@chat-agents/backend'

/** A `/` trigger under the caret, and what has been typed after it. */
export interface SkillTrigger {
  /** Index of the `/` in the draft. */
  readonly at: number
  /** Index just past the typed word — where the caret is. */
  readonly end: number
  /** The word after `/`, lower-cased. */
  readonly query: string
}

/**
 * Find the `/` mention the caret is inside, if any.
 *
 * Anchored to the start of the draft or to whitespace, so a path being typed
 * (`src/ui`, `/usr/bin`) never opens the menu. The word may only contain the
 * characters a skill id can, which also closes the menu the moment the user
 * types a `/` of a path after it.
 * @param draft - The composer's current text.
 * @param caret - The caret offset within it.
 * @returns The trigger, or undefined when the caret is not in one.
 */
export function skillTriggerAt(draft: string, caret: number): SkillTrigger | undefined {
  const before = draft.slice(0, caret)
  const slash = before.lastIndexOf('/')
  if (slash === -1) return undefined
  const preceding = slash === 0 ? '' : before.charAt(slash - 1)
  if (preceding !== '' && !/\s/.test(preceding)) return undefined
  const word = before.slice(slash + 1)
  if (!/^[A-Za-z0-9._-]*$/.test(word)) return undefined
  return { at: slash, end: caret, query: word.toLowerCase() }
}

/**
 * The skills a query matches, best first.
 *
 * An id prefix ranks above a word inside the name or description: a user who
 * typed `/rev` means the skill called `review`, not the one whose description
 * happens to mention reviewing.
 * @param skills - The catalogue.
 * @param query - The word typed after `/`, lower-cased.
 * @returns At most eight matches — a menu longer than the composer is a list to
 *   read rather than a completion to accept.
 */
export function matchSkills(
  skills: readonly SkillMention[],
  query: string,
): readonly SkillMention[] {
  if (query === '') return skills.slice(0, 8)
  const ranked = skills
    .map((skill) => {
      const id = skill.id.toLowerCase()
      const haystack = `${skill.name} ${skill.description}`.toLowerCase()
      const rank = id.startsWith(query) ? 0
        : id.includes(query) ? 1
          : haystack.includes(query) ? 2
            : 3
      return { skill, rank }
    })
    .filter(entry => entry.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.skill.id.localeCompare(right.skill.id))
  return ranked.slice(0, 8).map(entry => entry.skill)
}

/**
 * Take the half-typed trigger back out of the draft.
 *
 * Picking from the menu attaches the skill as a chip, so the `/word` that
 * opened the menu has done its job and has to go: left in place it would attach
 * the same skill a second time, through the text.
 * @param draft - The composer's current text.
 * @param trigger - The trigger that was picked from.
 * @returns The new draft and where the caret belongs in it.
 */
export function detachTrigger(
  draft: string,
  trigger: SkillTrigger,
): { readonly draft: string; readonly caret: number } {
  const rest = draft.slice(trigger.end)
  // A space the trigger was separated by is not wanted twice; one that follows
  // real text is left alone.
  const trimmed = draft.slice(0, trigger.at).endsWith(' ') && rest.startsWith(' ')
    ? rest.slice(1)
    : rest
  return { draft: draft.slice(0, trigger.at) + trimmed, caret: trigger.at }
}

/**
 * A skill's display name.
 *
 * Discovery reports whatever `SKILL.md` declared, which is usually the folder's
 * kebab id repeated. A row of `web-design-guidelines` reads as a path; the same
 * words as words read as a name, which is what a menu of them needs.
 * @param skill - The skill.
 * @returns Its name, title-cased when it is only the id in disguise.
 */
export function skillTitle(skill: SkillMention): string {
  const name = skill.name.trim()
  const source = name === '' ? skill.id : name
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(source)) return source
  return source
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * The `/mention` spans of a draft that name a skill that exists.
 *
 * The same rule the backend applies — start of line or whitespace, then a word
 * that matches the catalogue — so what is highlighted is exactly what will be
 * acted on. A word that looks like a mention but matches nothing stays plain
 * text, which is the honest signal: it is not going to load anything.
 * @param draft - The composer's text.
 * @param skills - The catalogue.
 * @returns Half-open `[start, end)` ranges, in order, never overlapping.
 */
export function mentionRanges(
  draft: string,
  skills: readonly SkillMention[],
): readonly (readonly [number, number])[] {
  if (draft === '' || skills.length === 0) return []
  const ids = new Set(skills.map(skill => skill.id.toLowerCase()))
  const ranges: [number, number][] = []
  const pattern = /(^|\s)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g
  for (const match of draft.matchAll(pattern)) {
    const word = match[2] ?? ''
    if (!ids.has(word.toLowerCase())) continue
    const start = (match.index ?? 0) + (match[1] ?? '').length
    ranges.push([start, start + word.length + 1])
  }
  return ranges
}

