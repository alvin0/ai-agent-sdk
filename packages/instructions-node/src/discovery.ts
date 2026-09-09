/**
 * Filesystem walk for instruction files: project root, ancestor chain, and the
 * descendant directories a tool call reached into.
 *
 * @module @alvin0/ai-agent-sdk-instructions-node/discovery
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ResolvedInstructionsConfig } from './config.ts'

/** One instruction file that exists and was read. */
export interface LoadedInstructionFile {
  readonly absolutePath: string
  /** Project-root-relative path shown to the model. */
  readonly displayPath: string
  readonly content: string
  readonly mtimeMs: number
  readonly size: number
}

async function isFile(path: string): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined
  } catch {
    // A missing candidate is the normal case; an unreadable one is skipped for
    // the same reason — assembled context must never fail a turn.
    return undefined
  }
}

async function hasMarker(dir: string, markers: readonly string[]): Promise<boolean> {
  for (const marker of markers) {
    try {
      await stat(join(dir, marker))
      return true
    } catch { /* keep looking */ }
  }
  return false
}

/**
 * Walk upward until a root marker is found.
 * @param cwd - absolute starting directory.
 * @param markers - directory entries that identify a root.
 * @returns the marked ancestor, or `cwd` when no marker exists above it.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  if (markers.length === 0) return resolve(cwd)
  let current = resolve(cwd)
  while (true) {
    signal?.throwIfAborted()
    if (await hasMarker(current, markers)) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Directories from the project root down to `cwd`, inclusive.
 * @param root - the project root.
 * @param cwd - the session working directory.
 * @returns root-first directory chain.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const resolvedRoot = resolve(root)
  const chain: string[] = []
  let current = resolve(cwd)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) return [resolvedRoot]
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * Directories crossed between `base` and a touched file, excluding `base`.
 * @param base - the directory the chain already covers.
 * @param touchedPath - absolute path, or one relative to `base`.
 * @returns shallowest-first descendant directories, empty when the path escapes `base`.
 */
export function descendantDirsBetween(base: string, touchedPath: string): string[] {
  const resolvedBase = resolve(base)
  const target = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedBase, touchedPath)
  const dir = dirname(target)
  const rel = relative(resolvedBase, dir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  const segments = rel.split(sep).filter(segment => segment.length > 0)
  return segments.map((_, index) => join(resolvedBase, ...segments.slice(0, index + 1)))
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Read the instruction candidates present in one directory.
 * @param dir - absolute directory to probe.
 * @param root - display base.
 * @param config - normalized configuration.
 * @returns the files that exist, in candidate precedence order.
 */
export async function directoryInstructionFiles(
  dir: string,
  root: string,
  config: ResolvedInstructionsConfig,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile[]> {
  const found: LoadedInstructionFile[] = []
  for (const name of config.fileNames) {
    signal?.throwIfAborted()
    const absolutePath = join(dir, name)
    const info = await isFile(absolutePath)
    if (info === undefined) continue
    const loaded = await readInstructionFile(absolutePath, root, config, info)
    if (loaded !== undefined) {
      found.push(loaded)
      if (config.perDirectory === 'first') break
    }
  }
  return found
}

/**
 * Read one instruction file, skipping it when it exceeds the per-file ceiling.
 * @param absolutePath - the file to read.
 * @param root - display base.
 * @param config - normalized configuration.
 * @param info - stat data already collected for the file.
 * @returns the loaded file, or undefined when it is empty, oversized, or unreadable.
 */
export async function readInstructionFile(
  absolutePath: string,
  root: string,
  config: ResolvedInstructionsConfig,
  info: { mtimeMs: number; size: number },
): Promise<LoadedInstructionFile | undefined> {
  // A file larger than the whole section can never be rendered usefully, and
  // reading it first would spend the memory to prove that. The section ceiling
  // bounds the per-file ceiling for exactly that reason.
  const ceiling = Math.min(config.maxFileBytes, config.maxBytes)
  if (info.size > ceiling) return undefined
  let content: string
  try {
    content = await readFile(absolutePath, 'utf8')
  } catch {
    return undefined
  }
  if (content.trim().length === 0) return undefined
  if (utf8Bytes(content) > ceiling) return undefined
  const displayPath = absolutePath.startsWith(resolve(root) + sep)
    ? relative(resolve(root), absolutePath)
    : absolutePath
  return { absolutePath, displayPath, content, mtimeMs: info.mtimeMs, size: info.size }
}

/**
 * Probe the configured global file, when one was supplied.
 * @param config - normalized configuration.
 * @returns the loaded global file, or undefined.
 */
export async function globalInstructionFile(
  config: ResolvedInstructionsConfig,
): Promise<LoadedInstructionFile | undefined> {
  if (config.globalFile === undefined) return undefined
  const absolutePath = resolve(config.globalFile)
  const info = await isFile(absolutePath)
  if (info === undefined) return undefined
  return readInstructionFile(absolutePath, dirname(absolutePath), config, info)
}

/**
 * Order directories shallowest-first, so a deeper file still reads as the more
 * specific one. Path length is not depth: `/a/bbbb` is shallower than `/a/b/c`.
 * @param left - first directory.
 * @param right - second directory.
 * @returns a comparator result usable with `Array#sort`.
 */
export function byDepthThenPath(left: string, right: string): number {
  const depth = left.split(sep).length - right.split(sep).length
  return depth !== 0 ? depth : (left < right ? -1 : left > right ? 1 : 0)
}
