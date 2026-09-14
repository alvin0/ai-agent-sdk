/**
 * The single source of writable roots.
 *
 * Both enforcement layers read this function: the process backends turn it into
 * bwrap binds or Seatbelt `subpath` grants, and the in-process fence turns it
 * into a containment check. Deriving them separately is how a kernel profile
 * and an application-level fence silently drift apart, so they never are.
 */

import type { FileSystemEntry } from './entries.ts'
import { entriesWithin, orderEntries } from './entries.ts'
import type { SandboxPolicy } from './policy.ts'
import { containsPath, dedupeRoots, joinPath, normalizePath } from './path.ts'

/**
 * Directory names never writable inside a granted root. Writing `.git` lets a
 * command rewrite history or install a hook that runs arbitrary code on the
 * next git invocation, which defeats the point of confining the command.
 */
export const PROTECTED_SUBPATHS: readonly string[] = Object.freeze([
  '.git', '.hg', '.svn', '.ssh', '.aws', '.npmrc', '.netrc',
])

/** The write grants and re-denials one policy resolves to. */
export interface WritableRootSet {
  /** Subtrees the backend should grant write access to. */
  readonly roots: readonly string[]
  /** Subtrees inside those roots that must be re-denied afterwards. */
  readonly denied: readonly string[]
}

/** Optional platform inputs the caller knows and this package must not guess. */
export interface WritableRootOptions {
  /** Temp directories `workspace-write` may also use (e.g. the OS temp root). */
  readonly tempRoots?: readonly string[]
  /** Whether to append {@link PROTECTED_SUBPATHS} under every granted root. */
  readonly protectSubpaths?: boolean
}

/**
 * Resolve the writable roots and their re-denials for one policy.
 * @param policy - the confining policy this execution runs under.
 * @param options - platform temp roots and protected-subpath behaviour.
 */
export function writableRoots(
  policy: SandboxPolicy,
  options: WritableRootOptions = {},
): WritableRootSet {
  const entries = orderEntries(policy.entries ?? [])
  const granted: string[] = []
  if (policy.mode === 'workspace-write') {
    granted.push(normalizePath(policy.workspaceRoot), ...(options.tempRoots ?? []).map(root => normalizePath(root)))
  }
  for (const entry of entries) {
    if (entry.access === 'write') granted.push(entry.path)
  }

  const roots = dedupeRoots(granted).filter(root => accessSurvives(root, entries))
  const denied = new Set<string>()
  for (const root of roots) {
    if (options.protectSubpaths !== false) {
      for (const name of PROTECTED_SUBPATHS) denied.add(joinPath(root, name))
    }
    for (const entry of entriesWithin(root, entries)) {
      if (entry.access !== 'write') denied.add(entry.path)
    }
  }
  // A narrower write grant reopens a denied parent, so it must not stay denied.
  for (const root of roots) denied.delete(root)

  return Object.freeze({ roots, denied: dedupeRoots([...denied]) })
}

/** Whether a granted root is not itself cancelled by a deeper deny entry. */
function accessSurvives(root: string, entries: readonly FileSystemEntry[]): boolean {
  let allowed = true
  for (const entry of entries) {
    if (!containsPath(entry.path, root)) continue
    allowed = entry.access === 'write'
  }
  return allowed
}

/** Subtrees whose contents must not be readable, for backends that can mask. */
export function unreadablePaths(policy: SandboxPolicy): readonly string[] {
  return dedupeRoots(orderEntries(policy.entries ?? []).filter(entry => entry.access === 'deny').map(entry => entry.path))
}
