import { createHash } from 'node:crypto'
import { lstat, opendir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  GENERATED_DIRECTORIES,
  MAX_SCANNED_FILES,
  MAX_STATIC_TEXT_BYTES,
  type SignalDeskFileChanges,
} from './contracts.ts'
import { SIGNAL_DESK_WORKSPACE_MARKER, type SignalDeskBaseline } from '../seed.ts'

export async function compareWorkspaceToBaseline(
  workspace: string,
  baseline: SignalDeskBaseline,
): Promise<SignalDeskFileChanges> {
  const baselineByPath = new Map(baseline.files.map(file => [file.path, file]))
  const currentPaths = await scanRelevantFiles(workspace)
  const currentSet = new Set(currentPaths)
  const modified: string[] = []
  const deleted: string[] = []
  const added: string[] = []

  for (const baselineFile of baseline.files) {
    if (!currentSet.has(baselineFile.path)) {
      deleted.push(baselineFile.path)
      continue
    }
    const currentHash = await hashFile(join(workspace, ...baselineFile.path.split('/')))
    if (currentHash !== baselineFile.sha256) modified.push(baselineFile.path)
  }
  for (const path of currentPaths) {
    if (!baselineByPath.has(path)) added.push(path)
  }
  modified.sort(ordinal)
  added.sort(ordinal)
  deleted.sort(ordinal)
  return Object.freeze({
    modified: Object.freeze(modified),
    added: Object.freeze(added),
    deleted: Object.freeze(deleted),
  })
}

export async function scanRelevantFiles(workspace: string): Promise<readonly string[]> {
  const output: string[] = []
  await walk(workspace, workspace, output)
  output.sort(ordinal)
  return output
}

async function walk(root: string, current: string, output: string[]): Promise<void> {
  const handle = await opendir(current)
  for await (const entry of handle) {
    if (current === root && GENERATED_DIRECTORIES.has(entry.name)) continue
    if (entry.name === SIGNAL_DESK_WORKSPACE_MARKER) continue
    const absolute = join(current, entry.name)
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`workspace contains a link: ${absolute}`)
    if (info.isDirectory()) {
      if (GENERATED_DIRECTORIES.has(entry.name)) continue
      await walk(root, absolute, output)
      continue
    }
    if (!info.isFile()) throw new Error(`workspace contains an unsupported entry: ${absolute}`)
    output.push(relative(root, absolute).split(sep).join('/'))
    if (output.length > MAX_SCANNED_FILES) {
      throw new RangeError(`workspace scan exceeds ${MAX_SCANNED_FILES} files`)
    }
  }
}

export async function findE2eSpecs(workspace: string): Promise<readonly string[]> {
  const directory = join(workspace, 'e2e')
  const info = await stat(directory).catch(() => undefined)
  if (!info?.isDirectory()) return []
  const files = await scanRelevantFiles(directory)
  return files
    .filter(path => /(?:\.spec|\.test)\.[cm]?[jt]sx?$/.test(path))
    .map(path => `e2e/${path}`)
    .sort(ordinal)
}

export async function firstExistingFile(
  workspace: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const info = await stat(join(workspace, candidate)).catch(() => undefined)
    if (info?.isFile()) return candidate
  }
  return undefined
}

export async function readBoundedText(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile() || info.size > MAX_STATIC_TEXT_BYTES) return undefined
  return readFile(path, 'utf8').catch(() => undefined)
}

export async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readBoundedText(path)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

export function objectProperty(
  value: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> | undefined {
  const property = value?.[name]
  return typeof property === 'object' && property !== null && !Array.isArray(property)
    ? property as Record<string, unknown>
    : undefined
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
