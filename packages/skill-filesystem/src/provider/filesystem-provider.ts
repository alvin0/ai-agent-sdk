/** Node-only Agent Skills folder discovery. */

export type { FileSystemSkillRoot, FileSystemSkillIoPhase, FileSystemSkillIoEvent, FileSystemSkillsOptions }
  from './filesystem-types.ts'
import { resolveRoots, discoverRoot } from './filesystem-discovery.ts'
import { parseSkillFile, parseSkillMetadata } from './filesystem-metadata.ts'
import { readResource } from './filesystem-resources.ts'
import {
  defineSkill, defineSkillProvider, type SkillCandidate, type SkillDefinition, type SkillProvider,
  type SkillProviderListOptions,
} from '@alvin0/ai-agent-sdk-core/skills'
import { DEFAULT_MAX_CANDIDATES, DEFAULT_MAX_ROOT_ENTRIES } from './filesystem-constants.ts'
import type { FileSystemSkillsOptions } from './filesystem-types.ts'
import { asLocator, assertIssuedCandidate, boundedInteger } from './filesystem-support.ts'

/** Create a lazy filesystem provider, refreshed before each agent turn. */
export function fileSystemSkills(options: FileSystemSkillsOptions = {}): SkillProvider {
  const id = options.id ?? 'filesystem'
  const maxCandidates = boundedInteger(
    options.maxCandidates, DEFAULT_MAX_CANDIDATES, { min: 1, max: 10_000, name: 'maxCandidates' },
  )
  const maxRootEntries = boundedInteger(
    options.maxRootEntries, DEFAULT_MAX_ROOT_ENTRIES, { min: 1, max: 100_000, name: 'maxRootEntries' },
  )
  const issued = new WeakSet<object>()
  return defineSkillProvider({
    kind: 'skill-provider',
    id,
    async list(lookup) {
      const allowed = lookup.allowedSkillIds === undefined
        ? undefined
        : new Set(lookup.allowedSkillIds)
      if (allowed?.size === 0) return Object.freeze([])
      const roots = await resolveRoots(options, lookup)
      const candidates = new Map<string, SkillCandidate>()
      for (const root of roots) {
        for (const locator of await discoverRoot(root.path, maxRootEntries, lookup.signal, options.onIo)) {
          const candidate = await parseSkillMetadata(
            locator,
            { source: root.source, provider: id },
            { signal: lookup.signal, onIo: options.onIo },
          )
          if (allowed !== undefined && !allowed.has(candidate.id)) continue
          if (candidates.has(candidate.id)) continue
          if (candidates.size >= maxCandidates) {
            throw new RangeError(`skill provider '${id}' discovered more than ${maxCandidates} candidates`)
          }
          candidates.set(candidate.id, candidate)
          issued.add(candidate)
        }
      }
      return Object.freeze([...candidates.values()])
    },
    async load(candidate, lookup) {
      assertIssuedCandidate(issued, candidate, id)
      const locator = asLocator(candidate.locator, candidate.id)
      return (await parseSkillFile(
        locator,
        candidate.id,
        { source: candidate.source, provider: id },
        { signal: lookup.signal, onIo: options.onIo },
      )).input
    },
    async readResource(candidate, path, lookup) {
      assertIssuedCandidate(issued, candidate, id)
      const locator = asLocator(candidate.locator, candidate.id)
      return await readResource(locator,
        candidate.id,
        path,
        { signal: lookup.signal, onIo: options.onIo })
    },
  })
}

/** Eager convenience for CLIs that need definitions rather than a live provider. */
export async function discoverFileSystemSkills(
  options: FileSystemSkillsOptions & SkillProviderListOptions = {},
): Promise<readonly SkillDefinition[]> {
  const provider = fileSystemSkills(options)
  const lookup = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.allowedSkillIds === undefined ? {} : { allowedSkillIds: options.allowedSkillIds }),
  }
  const candidates = await provider.list(lookup)
  const definitions: SkillDefinition[] = []
  for (const candidate of candidates) {
    const input = await provider.load(candidate, lookup)
    if (input !== undefined) definitions.push(defineSkill(input))
  }
  return Object.freeze(definitions)
}
