/**
 * The skills a project can reach, and the `/` mentions that name them.
 *
 * Two consumers need the same answer and used to have no way to agree on it:
 * the run, which hands `SkillSource`s to `defineAgent`, and the composer, which
 * has to offer the user a list before any run exists. The sources are built
 * here once so the menu can never advertise a skill the run would not find.
 *
 * A mention is deliberately NOT an execution. Picking `/code-review` puts the
 * words in the prompt and tells the model to load that skill first; the model
 * still calls `load_skill` itself, so a skill picked by mistake is a sentence
 * the model can disregard rather than a body of instructions already spliced
 * into its context.
 */

import { fileSystemSkills } from '@ai-agent-sdk/skill-filesystem'
import type { SkillSource } from '@ai-agent-sdk/core'
import { listSkills } from './agents'

/** One skill the composer can offer and the model can be asked to load. */
export interface SkillMention {
  /** The id `load_skill` takes, and the word typed after `/`. */
  readonly id: string
  readonly name: string
  readonly description: string
  /** The skill's own note on when it applies, when it declares one. */
  readonly whenToUse?: string
  /** Which provider found it — `project` or `global`, as named below. */
  readonly provider: string
}

/** What a group's runs and its composer both need to know about skills. */
export interface SkillScope {
  readonly groupId: string
  readonly workspaceRoot: string
}

/**
 * The skill providers one group's agents read.
 *
 * Two sources, because an explicit `roots` list turns the provider's own
 * project discovery off: the project's `.agents/skills` needs a provider of its
 * own, and the folders registered in Settings need another.
 * @param scope - The group and its workspace directory.
 * @returns The providers, project discovery first so it wins duplicate ids.
 */
export async function skillSourcesFor(scope: SkillScope): Promise<readonly SkillSource[]> {
  const roots = (await listSkills(scope.groupId))
    .filter(row => row.enabled === 1)
    .map(row => row.rootPath)
  return [
    fileSystemSkills({
      id: 'project',
      cwd: scope.workspaceRoot,
      includeProjectAgents: true,
      includeProjectDsh: true,
      // The user's own skills, shared across every project, mirroring
      // `CHAT_AGENTS_GLOBAL_INSTRUCTIONS`. Off by default: reading
      // `$HOME/.agents/skills` is the host's decision, not a library's.
      includeUserAgents: process.env.CHAT_AGENTS_USER_SKILLS === '1',
    }),
    ...roots.length === 0 ? [] : [fileSystemSkills({ id: 'global', roots })],
  ]
}

/**
 * Every skill a group's agents would discover right now.
 *
 * Metadata only — `list` is the providers' cheap path and reads no instruction
 * bodies, which is what makes it safe to call on a keystroke.
 * @param scope - The group and its workspace directory.
 * @param signal - Abort when the request that asked went away.
 * @returns The skills, project ones first, one row per id.
 */
export async function listAvailableSkills(
  scope: SkillScope,
  signal?: AbortSignal,
): Promise<readonly SkillMention[]> {
  const sources = await skillSourcesFor(scope)
  const found = new Map<string, SkillMention>()
  for (const source of sources) {
    if (source.kind !== 'skill-provider') continue
    let candidates
    try {
      candidates = await source.list({
        cwd: scope.workspaceRoot,
        ...signal === undefined ? {} : { signal },
      })
    } catch {
      // A missing or unreadable root is not an error the composer can act on;
      // the other providers still have something to offer.
      continue
    }
    for (const candidate of candidates) {
      // Earlier providers win, which is the same precedence the run applies.
      if (found.has(candidate.id)) continue
      found.set(candidate.id, {
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
        ...candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse },
        provider: source.id,
      })
    }
  }
  return [...found.values()]
}

/**
 * A `/word` token, where the word could be a skill id.
 *
 * Anchored to the start of the line or to whitespace, so a path (`/usr/bin`, or
 * `src/a/b`) never reads as a mention. The id itself must then match a skill
 * that exists — the catalogue is the allowlist, which is why no amount of
 * `/etc/passwd` in a prompt can invent one.
 */
const MENTION = /(?:^|\s)\/([A-Za-z0-9][A-Za-z0-9._-]*)/g

/** What a prompt's `/` mentions came to. */
export interface ResolvedMentions {
  /** The skills named, in the order the user typed them, no duplicates. */
  readonly skills: readonly SkillMention[]
  /**
   * The line to put in front of the model, or undefined when nothing matched.
   * Kept out of the transcript's user message: the user wrote a prompt, not an
   * instruction to themselves.
   */
  readonly directive?: string
}

/**
 * Read the `/` mentions of one prompt against a group's skills.
 * @param prompt - What the user typed.
 * @param catalogue - The skills that exist, from {@link listAvailableSkills}.
 * @returns The matched skills and the directive to prepend, if any.
 */
export function resolveSkillMentions(
  prompt: string,
  catalogue: readonly SkillMention[],
  /**
   * Ids the composer attached as chips, outside the text.
   *
   * Picked from the menu, a mention is a chip rather than a word in the
   * message, so the ids arrive beside the prompt. Typed by hand it is still a
   * word, and both are honoured: the chips first, in the order they were
   * picked, then anything the text names that they did not already cover.
   */
  attached: readonly string[] = [],
): ResolvedMentions {
  if (catalogue.length === 0) return { skills: [] }
  const byId = new Map(catalogue.map(skill => [skill.id.toLowerCase(), skill]))
  const picked = new Map<string, SkillMention>()
  for (const id of attached) {
    const found = byId.get(id.toLowerCase())
    if (found === undefined || picked.has(found.id)) continue
    picked.set(found.id, found)
  }
  for (const match of prompt.includes('/') ? prompt.matchAll(MENTION) : []) {
    const found = byId.get((match[1] ?? '').toLowerCase())
    if (found === undefined || picked.has(found.id)) continue
    picked.set(found.id, found)
  }
  const skills = [...picked.values()]
  if (skills.length === 0) return { skills: [] }
  const named = skills.map(skill => `\`${skill.id}\``).join(', ')
  return {
    skills,
    // Says what the user did and what to do about it, and no more: the skill's
    // own instructions are what `load_skill` returns, and asserting anything
    // about them here would be a second, stale copy of the skill.
    directive: `The user named ${skills.length === 1 ? 'a skill' : 'skills'} with \`/\` in the message below: ${named}. `
      + `Call \`load_skill\` for ${skills.length === 1 ? 'it' : 'each of them'} before acting, and follow what ${skills.length === 1 ? 'it says' : 'they say'}. `
      + 'If a loaded skill turns out not to apply to the request, say so instead of following it.',
  }
}
