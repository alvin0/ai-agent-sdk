/**
 * The layered grant model — the single source of truth for file effects.
 *
 * A policy is not two sets of paths. It is an ordered stack of layers, broadest
 * first, each one overriding the layers beneath it for its own subtree. Order is
 * the semantics: `/repo` writable, `/repo/vendor` denied, `/repo/vendor/cache`
 * writable again is three layers, and flattening them into "granted roots" plus
 * "denied paths" loses the third — a narrower grant beneath a denial has no way
 * to survive a set that only records what is broadly writable.
 *
 * Every enforcement path reads this one function: the bubblewrap mounts, the
 * Seatbelt profile, and the in-process fence. Deriving them separately is how a
 * kernel profile and an application fence drift into disagreeing about what is
 * writable.
 */

import type { FileSystemAccess, FileSystemEntry } from './entries.ts'
import { orderEntries } from './entries.ts'
import type { SandboxPolicy } from './policy.ts'
import { containsPath, joinPath, normalizePath, pathDepth } from './path.ts'

/**
 * Directory names never writable inside a granted root. Writing `.git` lets a
 * command install a hook that runs arbitrary code on the next git invocation,
 * which defeats the point of confining the command; the credential files are
 * there so a confined command cannot rewrite the caller's own authentication.
 * They stay readable — this is a write boundary, not a read boundary.
 */
export const PROTECTED_SUBPATHS: readonly string[] = Object.freeze([
  '.git', '.hg', '.svn', '.ssh', '.aws', '.npmrc', '.netrc',
])

/** Where a layer came from, which decides ties at equal path specificity. */
export type GrantOrigin = 'mode' | 'protected' | 'entry'

/** One subtree's access, overriding whatever the layers beneath it said. */
export interface GrantLayer {
  /** Absolute, normalized path whose subtree this layer governs. */
  readonly path: string
  /** Access this layer establishes for that subtree. */
  readonly access: FileSystemAccess
  /** What contributed the layer; an explicit entry outranks a generated one. */
  readonly origin: GrantOrigin
}

/**
 * The baseline every policy starts from: the host is readable and nothing is
 * writable. Layers only ever move a subtree away from this.
 */
export const BASELINE_ACCESS: FileSystemAccess = 'read'

/** Optional platform inputs the caller knows and this package must not guess. */
export interface WritableRootOptions {
  /** Temp directories `workspace-write` may also use (e.g. the OS temp root). */
  readonly tempRoots?: readonly string[]
  /** Whether to layer {@link PROTECTED_SUBPATHS} under every granted root. */
  readonly protectSubpaths?: boolean
}

const ORIGIN_RANK: Readonly<Record<GrantOrigin, number>> = Object.freeze({
  mode: 0, protected: 1, entry: 2,
})

/**
 * Resolve a policy into the ordered layers that express it.
 *
 * Layers are sorted broadest to narrowest, and an explicit entry wins a tie at
 * equal depth so a deployment can deliberately reopen a protected subpath. A
 * layer that would not change the access already in force is dropped, so the
 * result carries no mount or profile rule that does nothing.
 */
export function grantLayers(
  policy: SandboxPolicy,
  options: WritableRootOptions = {},
): readonly GrantLayer[] {
  const proposed: GrantLayer[] = []
  if (policy.mode === 'workspace-write') {
    for (const root of [policy.workspaceRoot, ...(options.tempRoots ?? [])]) {
      proposed.push({ path: normalizePath(root), access: 'write', origin: 'mode' })
    }
  }
  if (options.protectSubpaths !== false) {
    for (const layer of proposed.filter(candidate => candidate.access === 'write')) {
      for (const name of PROTECTED_SUBPATHS) {
        proposed.push({ path: joinPath(layer.path, name), access: 'read', origin: 'protected' })
      }
    }
  }
  for (const entry of orderEntries(policy.entries ?? [])) {
    proposed.push({ path: entry.path, access: entry.access, origin: 'entry' })
  }

  proposed.sort((left, right) =>
    pathDepth(left.path) - pathDepth(right.path)
    || ORIGIN_RANK[left.origin] - ORIGIN_RANK[right.origin]
    || left.path.localeCompare(right.path))

  const kept: GrantLayer[] = []
  for (const layer of proposed) {
    if (accessInLayers(layer.path, kept) !== layer.access) kept.push(Object.freeze(layer))
  }
  return Object.freeze(kept)
}

/**
 * The access in force at one path, given layers already applied in order.
 * The last layer whose subtree contains the path wins, which is what makes a
 * narrower grant reopen a denied parent.
 */
export function accessInLayers(
  target: string,
  layers: readonly GrantLayer[],
  baseline: FileSystemAccess = BASELINE_ACCESS,
): FileSystemAccess {
  let effective = baseline
  for (const layer of layers) {
    if (containsPath(layer.path, target)) effective = layer.access
  }
  return effective
}

/** The write grants and re-denials one policy resolves to. */
export interface WritableRootSet {
  /** Subtrees that end up writable, broadest first. */
  readonly roots: readonly string[]
  /** Subtrees inside those roots that are not writable, in application order. */
  readonly denied: readonly string[]
}

/**
 * The writable subtrees and their re-denials, flattened from {@link grantLayers}
 * for callers that only need the two lists. Order is preserved; a narrower grant
 * beneath a denial appears in `roots` after the denial it reopens.
 */
export function writableRoots(
  policy: SandboxPolicy,
  options: WritableRootOptions = {},
): WritableRootSet {
  const layers = grantLayers(policy, options)
  return Object.freeze({
    roots: Object.freeze(layers.filter(layer => layer.access === 'write').map(layer => layer.path)),
    denied: Object.freeze(layers.filter(layer => layer.access !== 'write').map(layer => layer.path)),
  })
}

/** Subtrees whose contents must not be readable, for backends that can mask. */
export function unreadablePaths(
  policy: SandboxPolicy,
  options: WritableRootOptions = {},
): readonly string[] {
  return Object.freeze(
    grantLayers(policy, options).filter(layer => layer.access === 'deny').map(layer => layer.path),
  )
}

/** Re-export so a backend can name the entry shape without a second import. */
export type { FileSystemAccess, FileSystemEntry }
