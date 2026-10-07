import type { Dirent } from 'node:fs'
import { readDirectoryBounded, readTextFileBounded } from './filesystem-io.ts'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { type SkillResourceSummary } from '@alvin0/ai-agent-sdk-core/skills'
import { validateSkillResourcePath } from '@alvin0/ai-agent-sdk-core/skills'
import {
  TEXT_RESOURCE_EXTENSIONS, MAX_RESOURCES, MAX_MANIFEST_ENTRIES, MAX_MANIFEST_DEPTH,
  IGNORED_RESOURCE_DIRECTORIES, MAX_RESOURCE_FILE_BYTES,
} from './filesystem-constants.ts'
import type { FileSystemSkillsOptions, FileLocator, FileSystemIoOptions } from './filesystem-types.ts'
import { normalize, isInside, isMissing, throwIfAborted, emitIo } from './filesystem-support.ts'

export async function discoverResourceManifest(
  locator: FileLocator,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
  skillId: string,
): Promise<readonly SkillResourceSummary[]> {
  const resources: SkillResourceSummary[] = []
  const pending = [{ directory: locator.directory, depth: 0 }]
  let scannedEntries = 0
  try {
    while (pending.length > 0) {
      throwIfAborted(signal)
      const current = pending.pop()
      if (current === undefined) break
      const { directory, depth } = current
      const entries = await readDirectoryBounded(
        directory,
        MAX_MANIFEST_ENTRIES - scannedEntries,
        signal,
        `skill '${basename(locator.directory)}' resource tree`,
      )
      for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
        throwIfAborted(signal)
        scannedEntries++
        if (scannedEntries > MAX_MANIFEST_ENTRIES) {
          throw new RangeError(
            `skill '${basename(locator.directory)}' resource tree exceeds ${MAX_MANIFEST_ENTRIES} entries`,
          )
        }
        await scanResourceEntry(entry, { directory, depth }, { locator, pending, resources })
      }
    }
  } finally {
    emitIo(onIo, {
      phase: 'activation', operation: 'scan', path: locator.directory,
      skillId, bytesRead: 0, entriesScanned: scannedEntries,
    })
  }
  return Object.freeze(resources.sort((left, right) => left.path.localeCompare(right.path)))
}

export async function readResource(
  locator: FileLocator,
  skillId: string,
  resourcePath: string,
  io: FileSystemIoOptions,
): Promise<string | undefined> {
  const { signal, onIo } = io
  validateSkillResourcePath(resourcePath, skillId)
  if (!TEXT_RESOURCE_EXTENSIONS.has(extname(resourcePath).toLocaleLowerCase())) return undefined
  const requested = resolve(locator.directory, ...resourcePath.split('/'))
  if (!isInside(locator.directory, requested)) return undefined
  let canonical: string
  try { canonical = await realpath(requested) }
  catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (!isInside(locator.directory, canonical)) return undefined
  const info = await stat(canonical)
  if (!info.isFile()) return undefined
  return normalize(await readTextFileBounded(
    canonical,
    MAX_RESOURCE_FILE_BYTES,
    `skill resource '${resourcePath}'`,
    { signal, onIo, context: { phase: 'resource', skillId } },
  )).trim()
}

async function scanResourceEntry(
  entry: Dirent, current: { directory: string; depth: number },
  state: { locator: FileLocator; pending: { directory: string; depth: number }[]; resources: SkillResourceSummary[] },
): Promise<void> {
  const { directory, depth } = current
  const { locator, pending, resources } = state
  const path = join(directory, entry.name)
  if (entry.isDirectory()) {
    if (IGNORED_RESOURCE_DIRECTORIES.has(entry.name)) return
    if (depth >= MAX_MANIFEST_DEPTH) {
      throw new RangeError(
        `skill '${basename(locator.directory)}' resource tree exceeds depth ${MAX_MANIFEST_DEPTH}`,
      )
    }
    pending.push({ directory: path, depth: depth + 1 })
    return
  }
  if (!entry.isFile() || !TEXT_RESOURCE_EXTENSIONS.has(extname(entry.name).toLocaleLowerCase())) return
  const key = relative(locator.directory, path).split(sep).join('/')
  if (key === 'SKILL.md' || key === 'agents/openai.yaml') return
  if (resources.length >= MAX_RESOURCES) {
    throw new RangeError(`skill '${basename(locator.directory)}' has more than ${MAX_RESOURCES} text resources`)
  }
  const info = await stat(path)
  resources.push(Object.freeze({ path: key, sizeBytes: info.size }))
}
