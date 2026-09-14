/**
 * The in-process path fence.
 *
 * A process sandbox only governs what a *child process* does. Tools that read,
 * write, or edit files inside the agent host bypass it entirely, so those calls
 * are fenced here against the same {@link writableRoots} the kernel profiles
 * are built from. The logic is pure; the filesystem facts it needs arrive
 * through an injected {@link PathResolver}.
 */

import type { FileSystemEntry } from './entries.ts'
import { accessFor } from './entries.ts'
import { SandboxDeniedError } from './errors.ts'
import { ancestorPaths, containsPath, normalizePath } from './path.ts'
import type { SandboxPolicy } from './policy.ts'
import type { FsFence, PathResolver } from './provider.ts'
import type { WritableRootOptions } from './roots.ts'
import { unreadablePaths, writableRoots } from './roots.ts'

/** One policy's grants with every path resolved through the filesystem. */
interface CanonicalGrants {
  readonly roots: readonly string[]
  readonly denied: readonly string[]
  readonly unreadable: readonly string[]
  readonly entries: readonly FileSystemEntry[]
}

/**
 * Build the fence for one policy.
 * @param policy - the same policy the process backends receive.
 * @param resolver - filesystem facts used to defeat symlinked paths.
 * @param options - platform temp roots and protected-subpath behaviour.
 */
export function createFsFence(
  policy: SandboxPolicy,
  resolver: PathResolver,
  options: WritableRootOptions = {},
): FsFence {
  const grants = writableRoots(policy, options)
  const unreadable = unreadablePaths(policy)
  const entries = policy.entries ?? []

  /**
   * Grants are canonicalized too, not just the target.
   *
   * A workspace root is routinely reached through a symlink — `/tmp` IS
   * `/private/tmp` on macOS, and `/home` is often a link. Canonicalizing only
   * the target would then compare a resolved path against an unresolved root
   * and refuse writes inside the very workspace that was granted. Resolved once
   * and reused, because a fence is built per call.
   */
  let canonical: Promise<CanonicalGrants> | undefined
  function grantsOnce(): Promise<CanonicalGrants> {
    canonical ??= (async (): Promise<CanonicalGrants> => Object.freeze({
      roots: await Promise.all(grants.roots.map(root => canonicalize(root, resolver))),
      denied: await Promise.all(grants.denied.map(root => canonicalize(root, resolver))),
      unreadable: await Promise.all(unreadable.map(root => canonicalize(root, resolver))),
      entries: await Promise.all(entries.map(async entry => Object.freeze({
        path: await canonicalize(entry.path, resolver), access: entry.access,
      }))),
    }))()
    return canonical
  }

  async function permits(path: string, want: 'write' | 'read'): Promise<boolean> {
    const [target, resolved] = await Promise.all([canonicalize(path, resolver), grantsOnce()])
    if (want === 'read') return !resolved.unreadable.some(root => containsPath(root, target))
    if (resolved.denied.some(root => containsPath(root, target))) return false
    if (!resolved.roots.some(root => containsPath(root, target))) return false
    return accessFor(target, resolved.entries, 'write') === 'write'
  }

  return Object.freeze({
    writableRoots: grants.roots,
    isWritable: (path: string) => permits(path, 'write'),
    isReadable: (path: string) => permits(path, 'read'),
    async assertWritable(path: string): Promise<void> {
      if (await permits(path, 'write')) return
      throw new SandboxDeniedError(normalizePath(path), policy.mode, grants.roots)
    },
  })
}

/**
 * Resolve a path through its deepest existing ancestor.
 *
 * A path is checked before it exists (a file about to be created) and may pass
 * through a symlink that points outside the workspace. Canonicalizing the
 * deepest ancestor that does exist and re-appending the missing tail closes
 * both cases: a symlinked parent resolves to its real location, and a target
 * that does not exist yet is still judged where it would actually be created.
 */
async function canonicalize(path: string, resolver: PathResolver): Promise<string> {
  const normalized = normalizePath(path)
  const chain = ancestorPaths(normalized)
  for (let index = chain.length - 1; index >= 0; index--) {
    const candidate = chain[index]
    if (candidate === undefined) continue
    if (!(await resolver.exists(candidate))) continue
    const real = await resolver.realpath(candidate)
    const tail = normalized.slice(candidate.length).replace(/^[\\/]+/, '')
    return tail === '' ? normalizePath(real) : normalizePath(`${real}/${tail}`)
  }
  return normalized
}
