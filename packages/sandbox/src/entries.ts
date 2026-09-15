/**
 * Nested filesystem carve-outs.
 *
 * A single writable root is not enough: an agent that may write in a repository
 * must still be kept out of `.git`, and an operator must be able to reopen one
 * directory beneath a denied parent. Entries express that as an overlapping
 * list resolved by path specificity — the deepest matching entry wins, so
 * `/repo = write`, `/repo/a = deny`, `/repo/a/b = write` behaves as written.
 */

import { containsPath, normalizePath, pathDepth } from './path.ts'

/** What one entry grants for the subtree it names. */
export type FileSystemAccess = 'write' | 'read' | 'deny'

/** One carve-out in a filesystem policy. */
export interface FileSystemEntry {
  /** Absolute path whose subtree this entry governs. */
  readonly path: string
  /** Access granted for that subtree, overriding any broader entry. */
  readonly access: FileSystemAccess
}

/**
 * Order entries from broadest to narrowest so a consumer can apply them in
 * sequence and let the most specific one win. Equal-depth entries keep a stable
 * lexical order so a policy always produces the same backend profile.
 */
export function orderEntries(entries: readonly FileSystemEntry[]): readonly FileSystemEntry[] {
  return Object.freeze(
    [...entries]
      .map(entry => Object.freeze({ path: normalizePath(entry.path), access: entry.access }))
      .sort((left, right) => pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path)),
  )
}

/**
 * Resolve the effective access for one target against an ordered entry list.
 * @param target - absolute path being evaluated.
 * @param entries - carve-outs, in any order.
 * @param fallback - access to use when no entry covers the target.
 */
export function accessFor(
  target: string,
  entries: readonly FileSystemEntry[],
  fallback: FileSystemAccess,
): FileSystemAccess {
  let effective = fallback
  for (const entry of orderEntries(entries)) {
    if (containsPath(entry.path, target)) effective = entry.access
  }
  return effective
}

/**
 * Entries that carve a narrower rule *inside* `root`. A backend that grants
 * `root` wholesale must re-apply these afterwards or the grant is too wide.
 */
export function entriesWithin(
  root: string,
  entries: readonly FileSystemEntry[],
): readonly FileSystemEntry[] {
  return Object.freeze(
    orderEntries(entries).filter(entry => containsPath(root, entry.path) && !containsPath(entry.path, root)),
  )
}
