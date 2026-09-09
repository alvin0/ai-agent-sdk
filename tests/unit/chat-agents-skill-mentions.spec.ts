import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

process.env.CHAT_AGENTS_DB ??= join(await mkdtemp(join(tmpdir(), 'mentions-db-')), 'test.db')
process.env.CHAT_AGENTS_MIGRATIONS ??= join(process.cwd(), 'samples/chat-agents/backend/drizzle')

const { listAvailableSkills, resolveSkillMentions } =
  await import('../../samples/chat-agents/backend/src/skill-catalog.ts')
// The pure half of the menu: the trigger rules, the ranking, the completion,
// and the mention spans. Imported from `mentions.ts` rather than through the
// React component, so this spec needs neither a DOM nor a JSX-capable project.
const { detachTrigger, matchSkills, mentionRanges, skillTitle, skillTriggerAt } =
  await import('../../samples/chat-agents/web/src/ui/chat/mentions.ts')

/** A workspace with one `.agents/skills/<id>/SKILL.md` per entry. */
async function workspaceWithSkills(
  skills: Record<string, { description: string; body?: string }>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mentions-'))
  for (const [id, skill] of Object.entries(skills)) {
    const directory = join(root, '.agents', 'skills', id)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${skill.description}\n---\n\n${skill.body ?? 'Do the thing.'}\n`,
      'utf8',
    )
  }
  return root
}

const catalogue = [
  { id: 'code-review', name: 'code-review', description: 'Review a diff for defects.', provider: 'project' },
  { id: 'release-notes', name: 'release-notes', description: 'Draft release notes.', provider: 'global' },
] as const

/**
 * Naming a skill with `/`.
 *
 * A skill is advertised to the model and loaded when the MODEL decides it
 * applies, which left the user no way to say "use the review skill, now" short
 * of describing it in prose and hoping. `/` is that way — and it is a mention,
 * not an execution: the model still calls `load_skill`, so a skill picked by
 * mistake is a sentence it can disregard rather than instructions already in
 * its context.
 */
describe('reading the skills a prompt names', () => {
  it('matches a skill that exists', () => {
    const found = resolveSkillMentions('/code-review the diff please', catalogue)
    expect(found.skills.map(skill => skill.id)).toEqual(['code-review'])
    expect(found.directive).toContain('`code-review`')
    expect(found.directive).toContain('load_skill')
  })

  it('takes the catalogue as the allowlist', () => {
    // The alternative — trusting the text — makes every prompt able to invent a
    // skill, and every path look like one.
    expect(resolveSkillMentions('/not-a-skill do it', catalogue).skills).toEqual([])
    expect(resolveSkillMentions('/code-review-extended', catalogue).skills).toEqual([])
  })

  it('does not read a path as a mention', () => {
    for (const prompt of [
      'read /etc/passwd',
      'open src/code-review/notes.md',
      'the file is at /Users/me/code-review',
      'a//code-review',
    ]) {
      expect(resolveSkillMentions(prompt, catalogue).skills).toEqual([])
    }
  })

  it('takes each skill once, in the order they were typed', () => {
    const found = resolveSkillMentions(
      'first /release-notes then /code-review, and /release-notes again',
      catalogue,
    )
    expect(found.skills.map(skill => skill.id)).toEqual(['release-notes', 'code-review'])
  })

  it('takes the ids the composer attached, not only the words', () => {
    // A mention picked from the menu leaves the text and arrives as a chip, so
    // the prompt itself can be an ordinary sentence.
    const found = resolveSkillMentions('review my diff', catalogue, ['code-review'])
    expect(found.skills.map(skill => skill.id)).toEqual(['code-review'])
    expect(found.directive).toContain('load_skill')
  })

  it('reconciles chips against the catalogue rather than trusting them', () => {
    // The ids come from the browser. An id no project has must not become an
    // instruction to load something.
    expect(resolveSkillMentions('do it', catalogue, ['made-up']).skills).toEqual([])
  })

  it('merges chips with words, chips first, once each', () => {
    const found = resolveSkillMentions('and /code-review too', catalogue, ['release-notes', 'code-review'])
    expect(found.skills.map(skill => skill.id)).toEqual(['release-notes', 'code-review'])
  })

  it('says nothing when there is nothing to say', () => {
    expect(resolveSkillMentions('just a question', catalogue).directive).toBeUndefined()
    expect(resolveSkillMentions('/code-review', []).skills).toEqual([])
  })
})

describe('the catalogue the menu offers', () => {
  it('finds a project’s own skills', async () => {
    const root = await workspaceWithSkills({
      'code-review': { description: 'Review a diff for defects.' },
    })
    const found = await listAvailableSkills({ groupId: 'default', workspaceRoot: root })
    expect(found.map(skill => skill.id)).toEqual(['code-review'])
    expect(found[0]?.description).toBe('Review a diff for defects.')
    expect(found[0]?.provider).toBe('project')
  })

  it('is empty, not broken, for a project with no skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mentions-'))
    expect(await listAvailableSkills({ groupId: 'default', workspaceRoot: root })).toEqual([])
  })

  it('reads back exactly what a mention needs to match', async () => {
    // The menu inserts `/<id>` and the backend matches on `id`. If discovery
    // reported a display name here, every pick would silently stop matching.
    const root = await workspaceWithSkills({ 'release-notes': { description: 'Draft notes.' } })
    const found = await listAvailableSkills({ groupId: 'default', workspaceRoot: root })
    expect(resolveSkillMentions('/release-notes', found).skills.map(skill => skill.id))
      .toEqual(['release-notes'])
  })
})

describe('what a mention looks like once it is in the draft', () => {
  it('marks the span of a mention that will actually be acted on', () => {
    // The pill is painted over these ranges, and the backend acts on the same
    // rule — so what is highlighted is what will load. A word that looks like a
    // mention but matches nothing stays plain, which is the honest signal.
    expect(mentionRanges('/code-review the diff', catalogue)).toEqual([[0, 12]])
    expect(mentionRanges('please /code-review it', catalogue)).toEqual([[7, 19]])
    expect(mentionRanges('/not-a-skill', catalogue)).toEqual([])
    expect(mentionRanges('read /etc/passwd', catalogue)).toEqual([])
    expect(mentionRanges('src/code-review', catalogue)).toEqual([])
  })

  it('marks each mention separately, in order', () => {
    const draft = '/code-review then /release-notes'
    expect(mentionRanges(draft, catalogue)).toEqual([[0, 12], [18, 32]])
    // The ranges are what the layer slices the draft with, so they have to
    // reconstruct it exactly.
    const [first, second] = mentionRanges(draft, catalogue)
    expect(draft.slice(first![0], first![1])).toBe('/code-review')
    expect(draft.slice(second![0], second![1])).toBe('/release-notes')
  })

  it('reads a kebab id as a name', () => {
    // `web-design-guidelines` in a menu row reads as a path. The same words as
    // words read as a name, which is what a list of them needs.
    expect(skillTitle({ id: 'web-design-guidelines', name: 'web-design-guidelines', description: '', provider: 'project' }))
      .toBe('Web Design Guidelines')
    // A name that was written for people is left exactly as it was written.
    expect(skillTitle({ id: 'code-review', name: 'Review a PR (fast)', description: '', provider: 'project' }))
      .toBe('Review a PR (fast)')
  })
})

describe('the composer actually wires the pieces together', () => {
  /**
   * Reported from the running app: picking a skill did nothing visible. The
   * state was set, the chip component existed and was imported — and the JSX
   * that renders it had been lost in an edit. Nothing caught it: a component
   * that is imported and never rendered typechecks, and this project has no DOM
   * harness to render the composer in.
   *
   * So the wiring is asserted against the source. It is a blunt test and it is
   * the one that would have failed.
   */
  const composer = readFileSync(
    join(process.cwd(), 'samples/chat-agents/web/src/ui/chat/ChatView.tsx'),
    'utf8',
  )

  it('renders the chips for the skills that are attached', () => {
    expect(composer).toMatch(/<SkillChips\s+skills=\{attached\}\s+onRemove=\{detach\}/)
  })

  it('sends the attached ids with the message, on both paths', () => {
    // A chip that never reaches the request is a chip that lies about what the
    // model was asked to load.
    expect(composer).toContain('chat.steer(text, skillIds)')
    expect(composer).toContain('chat.send(text, ready, skillIds)')
    expect(composer).toContain('const skillIds = attached.map(skill => skill.id)')
  })

  it('clears them once the message is away', () => {
    // Left behind, the next message silently loads the same skill again.
    expect(composer).toContain('setAttached([])')
  })
})

describe('the `/` trigger under the caret', () => {
  it('opens at the start of a line and after whitespace', () => {
    expect(skillTriggerAt('/rev', 4)).toMatchObject({ at: 0, end: 4, query: 'rev' })
    expect(skillTriggerAt('review this /co', 15)).toMatchObject({ at: 12, query: 'co' })
    // Bare `/` offers the whole list, which is how a user discovers what exists.
    expect(skillTriggerAt('/', 1)).toMatchObject({ query: '' })
  })

  it('stays shut while a path is typed', () => {
    expect(skillTriggerAt('src/ui', 6)).toBeUndefined()
    expect(skillTriggerAt('/etc/passwd', 11)).toBeUndefined()
    expect(skillTriggerAt('read a file', 11)).toBeUndefined()
  })

  it('depends on the caret, not only on the text', () => {
    // Same draft, caret moved past the word: the completion no longer applies.
    expect(skillTriggerAt('/rev and more', 4)).toMatchObject({ query: 'rev' })
    expect(skillTriggerAt('/rev and more', 13)).toBeUndefined()
  })

  it('ranks an id prefix above a description hit', () => {
    const ranked = matchSkills([
      { id: 'notes', name: 'notes', description: 'Anything.', provider: 'project' },
      { id: 'review', name: 'review', description: 'Review code.', provider: 'project' },
      { id: 'lint', name: 'lint', description: 'Runs a review of style.', provider: 'project' },
    ], 'rev')
    expect(ranked.map(skill => skill.id)).toEqual(['review', 'lint'])
  })

  it('takes the half-typed trigger back out of the draft', () => {
    // Picking attaches the skill as a chip, so the `/word` has done its job.
    // Left in place it would attach the same skill a second time through the
    // text, and the message would read `/code-review review my diff`.
    const draft = 'please /rev the diff'
    const trigger = skillTriggerAt(draft, 11)
    expect(trigger).toBeDefined()
    const next = detachTrigger(draft, trigger!)
    expect(next.draft).toBe('please the diff')
    // Caret where the trigger was, so typing continues the sentence there.
    expect(next.draft.slice(0, next.caret)).toBe('please ')
  })

  it('does not leave a double space behind', () => {
    const draft = 'a /rev b'
    const next = detachTrigger(draft, skillTriggerAt(draft, 6)!)
    expect(next.draft).toBe('a b')
  })

  it('leaves a draft that was only the trigger empty', () => {
    const next = detachTrigger('/rev', skillTriggerAt('/rev', 4)!)
    expect(next.draft).toBe('')
    expect(next.caret).toBe(0)
  })
})
