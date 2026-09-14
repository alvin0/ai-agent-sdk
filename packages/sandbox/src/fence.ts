/**
 * The in-process path fence.
 *
 * A process sandbox only governs what a *child process* does. Tools that read,
 * write, or edit files inside the agent host bypass it entirely, so those calls
 * are fenced here against the same {@link grantLayers} the kernel profiles are
 * built from. The logic is pure; the filesystem facts it needs arrive through an
 * injected {@link PathResolver}.
 */

import { SandboxDeniedError } from './errors.ts'
import { ancestorPaths, normalizePath } from './path.ts'
import type { SandboxPolicy } from './policy.ts'
import type { FsFence, PathResolver } from './provider.ts'
import type { GrantLayer, WritableRootOptions } from './roots.ts'
import { accessInLayers, grantLayers } from './roots.ts'

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
  const layers = grantLayers(policy, options)

  /**
   * Layer paths are canonicalized too, not just the target.
   *
   * A workspace root is routinely reached through a symlink — `/tmp` IS
   * `/private/tmp` on macOS, and `/home` is often a link. Canonicalizing only
   * the target would then compare a resolved path against an unresolved layer
   * and refuse writes inside the very workspace that was granted. Resolved once
   * and reused, because a fence is built per call.
   */
  let canonical: Promise<readonly GrantLayer[]> | undefined
  function layersOnce(): Promise<readonly GrantLayer[]> {
    canonical ??= Promise.all(layers.map(async layer => Object.freeze({
      ...layer, path: await canonicalize(layer.path, resolver),
    })))
    return canonical
  }

  async function permits(path: string, want: 'write' | 'read'): Promise<boolean> {
    const [target, resolved] = await Promise.all([canonicalize(path, resolver), layersOnce()])
    const access = accessInLayers(target, resolved)
    if (want === 'read') return access !== 'deny'
    if (access !== 'write') return false
    return options.allowAliasedWrites === true || !(await aliased(target))
  }

  /**
   * Whether the target is reachable under a name this policy never saw.
   *
   * A hard link gives one inode two names. Judging the name inside the
   * workspace says nothing about the other one, which may sit anywhere,
   * so a write through the inside name escapes a boundary made of paths. The
   * count is the only signal available without walking the whole filesystem;
   * when the host cannot report it, the check does not fire.
   */
  async function aliased(target: string): Promise<boolean> {
    if (resolver.hardLinkCount === undefined) return false
    try { return (await resolver.hardLinkCount(target)) > 1 }
    catch { return false }
  }

  return Object.freeze({
    writableRoots: Object.freeze(layers.filter(layer => layer.access === 'write').map(layer => layer.path)),
    isWritable: (path: string) => permits(path, 'write'),
    isReadable: (path: string) => permits(path, 'read'),
    async assertWritable(path: string): Promise<void> {
      if (await permits(path, 'write')) return
      const writable = layers.filter(layer => layer.access === 'write').map(layer => layer.path)
      throw new SandboxDeniedError(normalizePath(path), policy.mode, writable)
    },
    isAliased: (path: string) => canonicalize(path, resolver).then(aliased),
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
