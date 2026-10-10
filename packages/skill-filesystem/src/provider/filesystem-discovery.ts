import type { Dirent } from 'node:fs'
import { readDirectoryBounded } from './filesystem-io.ts'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type SkillLookupOptions } from '@alvin0/ai-agent-sdk-core/skills'
import type { FileSystemSkillsOptions, FileLocator, ResolvedRoot } from './filesystem-types.ts'
import { samePath, isInside, isMissing, throwIfAborted, emitIo } from './filesystem-support.ts'

export async function resolveRoots(
  options: FileSystemSkillsOptions,
  lookup: SkillLookupOptions,
): Promise<readonly ResolvedRoot[]> {
  if (options.roots !== undefined) {
    return Object.freeze(options.roots.map((root, index) => typeof root === 'string'
      ? { path: resolve(root), source: `custom-${index + 1}` }
      : { path: resolve(root.path), source: root.source ?? `custom-${index + 1}` }))
  }
  const cwd = resolve(lookup.cwd ?? options.cwd ?? process.cwd())
  const projectRoot = await findProjectRoot(cwd)
  const roots: ResolvedRoot[] = []
  if (options.includeProjectAgents ?? true) {
    roots.push(...ancestorSkillRoots(cwd, projectRoot, '.agents/skills', 'project-agents'))
  }
  if (options.includeProjectDsh ?? false) {
    roots.push(...ancestorSkillRoots(cwd, projectRoot, '.dsh/skills', 'project-dsh'))
  }
  if (options.includeUserAgents ?? false) {
    roots.push({ path: join(homedir(), '.agents', 'skills'), source: 'user-agents' })
  }
  return Object.freeze(roots)
}

export function ancestorSkillRoots(
  cwd: string,
  projectRoot: string,
  suffix: string,
  source: string,
): ResolvedRoot[] {
  const roots: ResolvedRoot[] = []
  let current = cwd
  while (true) {
    roots.push({ path: join(current, suffix), source })
    if (samePath(current, projectRoot)) break
    const parent = dirname(current)
    if (parent === current || !isInside(projectRoot, parent)) break
    current = parent
  }
  return roots
}

export async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  while (true) {
    try { await access(join(current, '.git')); return current }
    catch { /* keep walking */ }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

export async function discoverRoot(
  root: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
): Promise<FileLocator[]> {
  throwIfAborted(signal)
  let canonicalRoot: string
  try { canonicalRoot = await realpath(root) }
  catch (error: unknown) {
    if (isMissing(error)) return []
    throw error
  }
  const entries = await readDirectoryBounded(canonicalRoot, maxEntries, signal, 'skill discovery root')
  emitIo(onIo, {
    phase: 'discovery', operation: 'scan', path: canonicalRoot,
    bytesRead: 0, entriesScanned: entries.length,
  })
  const locators: FileLocator[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    throwIfAborted(signal)
    const locator = await discoverEntry(canonicalRoot, entry)
    if (locator !== undefined) locators.push(locator)
  }
  return locators
}

async function discoverEntry(canonicalRoot: string, entry: Dirent): Promise<FileLocator | undefined> {
  const entryPath = join(canonicalRoot, entry.name)
  let directory: string
  try {
    const info = entry.isDirectory() ? undefined : await stat(entryPath)
    if (!entry.isDirectory() && info?.isDirectory() !== true) return undefined
    directory = await realpath(entryPath)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
  const skillFile = join(directory, 'SKILL.md')
  try { await access(skillFile) }
  catch { return undefined }
  return { skillFile, directory }
}
