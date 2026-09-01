/** Pinned skills.sh sources used by the progressive-disclosure stress harness. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_SKILL_SOURCE_LOCK_PATH = resolve(
  process.cwd(), 'test-human', 'skill-stress', 'skill-sources.lock.json',
)

const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const REVISION_PATTERN = /^[a-f0-9]{40}$/

export interface SkillStressSource {
  /** Installed directory name and skill id. */
  readonly id: string
  /** Name passed to `skills add --skill`. */
  readonly skill: string
  /** Immutable archive URL or a tagged Git source accepted by the skills CLI. */
  readonly source: string
  /** Resolved upstream commit, retained even when the CLI source uses a tag. */
  readonly revision: string
  readonly registry: string
  /** Hash of every installed file and relative path, verified by this harness. */
  readonly computedHash: string
  readonly fileCount: number
}

export interface SkillStressSourceLock {
  readonly version: 1
  readonly cli: {
    readonly package: 'skills'
    readonly version: string
  }
  readonly sources: readonly SkillStressSource[]
}

export async function readSkillStressSourceLock(
  path = DEFAULT_SKILL_SOURCE_LOCK_PATH,
): Promise<SkillStressSourceLock> {
  const text = await readFile(path, 'utf8')
  return parseSkillStressSourceLock(JSON.parse(text) as unknown)
}

export function parseSkillStressSourceLock(value: unknown): SkillStressSourceLock {
  const root = record(value, 'skill source lock')
  if (root.version !== 1) throw new Error('skill source lock version must be 1')

  const cli = record(root.cli, 'skill source lock cli')
  if (cli.package !== 'skills') throw new Error('skill source lock cli.package must be "skills"')
  const cliVersion = nonEmptyString(cli.version, 'skill source lock cli.version')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cliVersion)) {
    throw new Error('skill source lock cli.version must be an exact semver')
  }

  if (!Array.isArray(root.sources) || root.sources.length === 0) {
    throw new Error('skill source lock sources must be a non-empty array')
  }

  const ids = new Set<string>()
  const sources = root.sources.map((source, index) => {
    const parsed = parseSource(source, index)
    if (ids.has(parsed.id)) throw new Error(`duplicate skill source id: ${parsed.id}`)
    ids.add(parsed.id)
    return parsed
  })

  return Object.freeze({
    version: 1,
    cli: Object.freeze({ package: 'skills', version: cliVersion }),
    sources: Object.freeze(sources),
  })
}

export function skillsCliSpecifier(lock: SkillStressSourceLock): string {
  return `${lock.cli.package}@${lock.cli.version}`
}

export function skillsCliAddArguments(
  lock: SkillStressSourceLock,
  source: SkillStressSource,
): readonly string[] {
  return Object.freeze([
    '--yes',
    skillsCliSpecifier(lock),
    'add',
    source.source,
    '--skill',
    source.skill,
    '--agent',
    'codex',
    '--copy',
    '-y',
  ])
}

function parseSource(value: unknown, index: number): SkillStressSource {
  const source = record(value, `skill source at index ${index}`)
  const id = nonEmptyString(source.id, `skill source ${index}.id`)
  if (!SKILL_ID_PATTERN.test(id)) throw new Error(`invalid skill source id: ${id}`)

  const skill = nonEmptyString(source.skill, `skill source ${id}.skill`)
  if (skill !== id) throw new Error(`skill source ${id}.skill must match its id`)

  const installSource = nonEmptyString(source.source, `skill source ${id}.source`)
  assertPinnedGitHubSource(installSource, id)

  const revision = nonEmptyString(source.revision, `skill source ${id}.revision`)
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`skill source ${id}.revision must be a 40-character Git commit`)
  }
  const archiveRevision = /\/archive\/([a-f0-9]{40})\.zip$/.exec(installSource)?.[1]
  if (archiveRevision !== undefined && archiveRevision !== revision) {
    throw new Error(`skill source ${id}.revision must match its archive URL`)
  }
  const gitRef = /\.git#([^#]+)$/.exec(installSource)?.[1]
  const isVersionTag = gitRef !== undefined && /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(gitRef)
  if (gitRef !== undefined && !isVersionTag && !gitRef.includes(revision)) {
    throw new Error(`skill source ${id}.source Git ref must be a version tag or contain its commit`)
  }

  const registry = nonEmptyString(source.registry, `skill source ${id}.registry`)
  if (!registry.startsWith('https://skills.sh/')) {
    throw new Error(`skill source ${id}.registry must be a skills.sh URL`)
  }

  const computedHash = nonEmptyString(source.computedHash, `skill source ${id}.computedHash`)
  if (!SHA256_PATTERN.test(computedHash)) {
    throw new Error(`skill source ${id}.computedHash must be a SHA-256 digest`)
  }

  const fileCount = source.fileCount
  if (typeof fileCount !== 'number' || !Number.isSafeInteger(fileCount) || fileCount < 1) {
    throw new Error(`skill source ${id}.fileCount must be a positive integer`)
  }

  return Object.freeze({
    id,
    skill,
    source: installSource,
    revision,
    registry,
    computedHash,
    fileCount,
  })
}

function assertPinnedGitHubSource(source: string, id: string): void {
  if (!source.startsWith('https://github.com/')) {
    throw new Error(`skill source ${id}.source must use HTTPS GitHub`)
  }

  const archiveCommit = /\/archive\/([a-f0-9]{40})\.zip$/.exec(source)?.[1]
  const taggedGitSource = /\.git#([^#]+)$/.exec(source)?.[1]
  if (archiveCommit === undefined && taggedGitSource === undefined) {
    throw new Error(`skill source ${id}.source must use a commit archive or explicit Git tag`)
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}
