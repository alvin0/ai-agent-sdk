/**
 * Finding the inodes a path boundary cannot see.
 *
 * A hard link gives one inode two names. The kernel profiles bind paths, so a
 * name inside the workspace and a name outside it are two grants over one file:
 * writing through the inside name reaches the outside one, and no mount in the
 * profile disagrees. Measured on both backends, that write landed.
 *
 * The fence refuses such a file because it can ask how many names the inode
 * has. The profile can be given the same answer — but only if someone looks
 * first, which is what this does: walk the granted roots, and report every file
 * whose inode is reachable under a name this policy never examined.
 */

import { readdir, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'

/** What a scan found, and whether it finished. */
export interface AliasScan {
  /** Files inside the granted roots whose inode carries another name. */
  readonly aliased: readonly string[]
  /**
   * Whether every file under the roots was examined. A scan that stopped at its
   * bound cannot prove the absence of an alias, so enforcement is reported as
   * partial rather than claimed complete.
   */
  readonly complete: boolean
  /** How many entries were examined, so a caller can see what a scan costs. */
  readonly examined: number
}

/** How far a scan may go before it gives up rather than stall a spawn. */
export interface AliasScanOptions {
  /** Maximum entries to examine across all roots. */
  readonly maxEntries?: number
  /** Maximum directory depth below each root. */
  readonly maxDepth?: number
}

/**
 * Walk the granted roots for files with more than one name.
 *
 * Symlinked directories are not followed: what they point at is judged by the
 * layer that named it, and following them would walk the whole filesystem from
 * inside a workspace.
 */
export async function findAliasedPaths(
  roots: readonly string[],
  options: AliasScanOptions = {},
): Promise<AliasScan> {
  const maxEntries = options.maxEntries ?? 50_000
  const maxDepth = options.maxDepth ?? 24
  const aliased: string[] = []
  let examined = 0
  let complete = true

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) { complete = false; return }
    let entries: string[]
    try { entries = await readdir(directory, { encoding: 'utf8' }) }
    catch { complete = false; return }
    for (const name of entries) {
      if (examined >= maxEntries) { complete = false; return }
      examined += 1
      const path = join(directory, name)
      let stats: Awaited<ReturnType<typeof lstat>>
      try { stats = await lstat(path) }
      catch { complete = false; continue }
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) { await walk(path, depth + 1); continue }
      if (stats.isFile() && stats.nlink > 1) aliased.push(path)
    }
  }

  const canonicalRoots = new Set<string>()
  for (const root of roots) {
    try { canonicalRoots.add(await realpath(root)) }
    catch { complete = false }
  }
  for (const root of canonicalRoots) {
    let stats: Awaited<ReturnType<typeof lstat>>
    try { stats = await lstat(root) }
    catch { complete = false; continue }
    examined += 1
    if (stats.isDirectory()) await walk(root, 0)
    else if (stats.isFile() && stats.nlink > 1) aliased.push(root)
  }
  return Object.freeze({ aliased: Object.freeze(aliased), complete, examined })
}
