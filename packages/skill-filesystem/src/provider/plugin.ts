import { createHash } from 'node:crypto'
import type { JsonValue } from '@alvin0/ai-agent-sdk-core'
import {
  defineSkillProviderPlugin,
  type RuntimeSkillCandidate,
  type RuntimeSkillLookupOptions,
  type SkillCandidate,
  type SkillProviderPlugin,
  type SkillReference,
} from '@alvin0/ai-agent-sdk-core/skills'
import {
  fileSystemSkills,
  type FileSystemSkillsOptions,
} from './filesystem-provider.ts'

/** Versioned, lazy adapter used by the high-level runtime composition slot. */
export function fileSystemSkillProviderPlugin(
  options: FileSystemSkillsOptions = {},
): SkillProviderPlugin {
  const provider = fileSystemSkills(options)
  return defineSkillProviderPlugin({
    id: provider.id,
    async list(lookup) {
      const candidates = await provider.list(markerFreeLookup(lookup))
      const rows = Object.freeze(candidates.map(candidate => runtimeCandidate(candidate)))
      return Object.freeze({ revision: catalogRevision(rows), candidates: rows })
    },
    async load(reference, lookup) {
      const candidate = await resolveReference(provider, reference, lookup)
      return candidate === undefined ? undefined : provider.load(candidate, markerFreeLookup(lookup))
    },
    async readResource(reference, path, lookup) {
      const candidate = await resolveReference(provider, reference, lookup)
      return candidate === undefined || provider.readResource === undefined
        ? undefined
        : provider.readResource(candidate, path, markerFreeLookup(lookup))
    },
  })
}

function runtimeCandidate(candidate: SkillCandidate): RuntimeSkillCandidate {
  return Object.freeze({
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider,
    ...(candidate.locator === undefined ? {} : { locator: jsonLocator(candidate.locator) }),
  })
}

async function resolveReference(
  provider: ReturnType<typeof fileSystemSkills>,
  reference: SkillReference,
  lookup: RuntimeSkillLookupOptions,
): Promise<SkillCandidate | undefined> {
  if (reference.provider !== provider.id) return undefined
  const candidates = await provider.list({
    ...markerFreeLookup(lookup), allowedSkillIds: [reference.id],
  })
  return candidates.find(candidate => candidate.id === reference.id
    && candidate.source === reference.source
    && sameJson(candidate.locator, reference.locator))
}

function markerFreeLookup(
  lookup: RuntimeSkillLookupOptions & { readonly allowedSkillIds?: readonly string[] },
) {
  return {
    ...(lookup.cwd === undefined ? {} : { cwd: lookup.cwd }),
    signal: lookup.signal,
    ...(lookup.allowedSkillIds === undefined ? {} : { allowedSkillIds: lookup.allowedSkillIds }),
  }
}

function catalogRevision(candidates: readonly RuntimeSkillCandidate[]): string {
  return createHash('sha256').update(JSON.stringify(candidates)).digest('hex')
}

function jsonLocator(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('filesystem skill locator must be JSON serializable')
  return JSON.parse(serialized) as JsonValue
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) }
  catch { return false }
}
