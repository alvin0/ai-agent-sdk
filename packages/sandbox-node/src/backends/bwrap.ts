/**
 * Linux bubblewrap backend.
 *
 * The host root is bound read-only and writable roots are layered back on top,
 * then every protected subpath and deny carve-out is re-applied *after* its
 * broader grant — bind order is what makes `/repo = write, /repo/.git = deny`
 * behave as written. A private PID namespace is part of the boundary, not a
 * convenience: without it, procfs magic links reach outside the mounts.
 */

import type {
  NetworkEnforcement, NetworkMode, RunnerFailureRule, SandboxPolicy,
} from '@alvin0/ai-agent-sdk-sandbox'
import type { WritableRootOptions } from '@alvin0/ai-agent-sdk-sandbox'
import { accessInLayers, grantLayers, normalizePath, pathDepth } from '@alvin0/ai-agent-sdk-sandbox'
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDirectory, nodePathResolver } from '../fs/resolver.ts'

/** Program name looked up on `PATH`. */
export const BWRAP_PROGRAM = 'bwrap'

/**
 * Which bubblewrap profile a host accepts.
 *
 * `full` mounts a fresh `/proc` inside the private PID namespace. Some hosts
 * refuse that mount even for a privileged user — a container whose `/proc` has
 * masked paths is the common case — and bubblewrap then fails outright rather
 * than confining anything. `restricted` drops only that mount, so the file
 * binds still hold while the outer `/proc` stays visible; procfs magic links
 * can then reach outside the mounts, which is why it reports `partial`.
 */
export type BwrapVariant = 'full' | 'restricted'

/**
 * Descriptor bubblewrap reports its own status on.
 *
 * It writes `{"child-pid": N}` once the command has actually been executed, on
 * a channel the command itself never holds. That is what makes the report
 * trustworthy where stderr is not: the runner and the command share stderr, so
 * a command can print `bwrap: ...` and exit 1 to impersonate a broken sandbox.
 */
export const BWRAP_STATUS_FD = 3

/** The namespace and capability arguments shared by the profile and its probe. */
function baseArgs(variant: BwrapVariant, network: NetworkMode = 'allow-all'): string[] {
  return [
    // A network namespace is all-or-nothing here: it leaves the sandbox with
    // its own loopback and no route anywhere else. `deny` and `loopback`
    // therefore enforce identically on this backend, which the enforcement
    // report states rather than papering over.
    ...(network === 'allow-all' ? [] : ['--unshare-net']),
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    ...(variant === 'full' ? ['--proc', '/proc'] : []),
    '--unshare-pid', '--unshare-ipc', '--unshare-user',
    '--new-session', '--die-with-parent',
    '--cap-drop', 'ALL',
    '--json-status-fd', String(BWRAP_STATUS_FD),
  ]
}

/**
 * Stderr substrings a file effect denied by bubblewrap's binds produces.
 *
 * `EBUSY` belongs here: a protected subpath is enforced by bind-mounting it, and
 * removing a mount point reports "resource busy" rather than a permission
 * error. Without it, `rm -rf .git` reads as an ordinary command failure even
 * though the sandbox is exactly what stopped it.
 */
export const BWRAP_DENIAL_SIGNATURES: readonly string[] = Object.freeze([
  'read-only file system', 'permission denied', 'operation not permitted',
  'resource busy or locked', 'device or resource busy',
])

/**
 * Bubblewrap prefixes its own fatal diagnostics with `bwrap:`, and uses the
 * same prefix to report that the child program could not be executed. Its exit
 * code cannot separate them — measured on 0.8.0, an unknown option, an
 * unusable bind, a failed `execvp`, and a child that merely returned 1 all exit
 * 1 — so the `execvp` form is excluded by name instead. A missing program is an
 * ordinary command failure, not a broken sandbox.
 */
export const BWRAP_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = Object.freeze([
  Object.freeze({
    fatalSignatures: Object.freeze(['bwrap:']),
    excludedSignatures: Object.freeze(['execvp']),
    informationalLines: Object.freeze(['bwrap: setting up uid map: Permission denied']),
  }),
])

/**
 * Build the bubblewrap profile arguments for one policy.
 *
 * Layers are emitted in the order the contract resolved them — broadest first —
 * because bind order IS the semantics here: a later mount overrides an earlier
 * one for its own subtree. That is what lets `/repo` be writable, `/repo/vendor`
 * denied, and `/repo/vendor/cache` writable again.
 */
export async function bwrapProfileArgs(
  policy: SandboxPolicy,
  options: WritableRootOptions,
  variant: BwrapVariant = 'full',
  aliased: readonly string[] = [],
): Promise<readonly string[]> {
  const resolver = nodePathResolver()
  const args: string[] = baseArgs(variant, policy.network ?? 'allow-all')
  const sealReadOnly: string[] = []
  const layers = Object.freeze(await Promise.all(grantLayers(policy, options).map(async layer =>
    Object.freeze({ ...layer, path: await resolver.realpath(layer.path) }))))

  for (const [index, layer] of layers.entries()) {
    // Bind the canonical location: a layer named through a symlink would
    // otherwise govern whatever the link happens to point at.
    const real = layer.path

    // A mount needs its destination to exist: `--ro-bind-try` tolerates a
    // missing SOURCE, not a missing DESTINATION, and outside the workspace the
    // root is read-only so bubblewrap cannot create one. A hardened deny list
    // names paths that are absent on most hosts (`~/.aws` on a machine without
    // it), and emitting a mount for those aborts the whole sandbox with
    // "Can't create file at ...: Read-only file system" — the command then
    // never runs at all. Nothing needs masking where nothing exists.
    if (layer.access !== 'write' && !(await resolver.exists(real))) {
      // A protected child of a writable mount must still occupy the name: if
      // it is skipped, the command can create it through the writable parent.
      const before = accessInLayers(layer.path, layers.slice(0, index), policy.baseline ?? 'read')
      if (before === 'write') {
        args.push('--tmpfs', real)
        sealReadOnly.push(real)
      }
      continue
    }

    if (layer.access === 'write') {
      args.push('--bind', real, real)
      continue
    }

    // bubblewrap builds the mount point itself, and since 0.12.0 it has to read
    // the destination's parent to do so. A host daemon socket routinely sits in
    // a root-owned `0711` directory — `/run/containerd` on a GitHub runner —
    // which the confined user may traverse but not list, and naming the socket
    // there aborts the whole sandbox instead of masking anything. Masking the
    // directory denies strictly more and mounts cleanly, so the mask climbs to
    // the shallowest ancestor bubblewrap can actually mount.
    const mask = await mountableMaskPoint(real)
    if (mask === undefined) {
      throw new Error(
        `bubblewrap cannot mask ${real}: no ancestor of it can carry a mount point, `
        + 'so this policy has no profile that expresses it',
      )
    }

    if (layer.access === 'read' && mask === real) {
      args.push('--ro-bind-try', real, real)
    } else if (await isDirectory(mask)) {
      // An empty tmpfs hides the contents, but a bare tmpfs is writable, so the
      // denial is only real once it is remounted read-only. That remount is
      // deferred: sealing it here would leave bubblewrap unable to create the
      // mount point for a narrower grant reopened inside this subtree
      // ("Can't mkdir ...: Read-only file system").
      args.push('--tmpfs', mask)
      sealReadOnly.push(mask)
    } else {
      args.push('--ro-bind-try', '/dev/null', mask)
    }
  }

  // A hard link is two names for one inode, and the grant above named only one
  // of them. Re-binding the file read-only closes the second name without
  // hiding the first: the content stays readable, the write does not land.
  for (const alias of aliased) {
    const real = await resolver.realpath(alias)
    if (accessInLayers(alias, layers, policy.baseline ?? 'read') === 'write') {
      args.push('--ro-bind-try', real, real)
    }
  }

  // Deepest first, so sealing a parent never precedes sealing its own child.
  for (const sealed of [...sealReadOnly].sort((left, right) => pathDepth(right) - pathDepth(left))) {
    args.push('--remount-ro', sealed)
  }

  args.push('--chdir', await resolver.realpath(policy.workspaceRoot))
  return Object.freeze(args)
}

/**
 * The shallowest path at or above `path` that bubblewrap can mount a mask on.
 *
 * The constraint is the destination's *parent*: bubblewrap creates the mount
 * point, and to do that it must be able to read that parent. A directory the
 * confined user may traverse but not list therefore cannot hold a mask, while
 * the directory itself can carry one — and masking it denies strictly more
 * than masking what is inside it, so climbing never widens the boundary.
 *
 * `undefined` means even the root could not be read, which no profile can
 * express and which the caller reports rather than papering over.
 */
async function mountableMaskPoint(path: string): Promise<string | undefined> {
  let candidate = normalizePath(path)
  for (;;) {
    const parent = normalizePath(dirname(candidate))
    if (parent === candidate) return undefined
    if (await isReadableDirectory(parent)) return candidate
    candidate = parent
  }
}

/** Whether this process may list `path`, which is what mounting under it needs. */
async function isReadableDirectory(path: string): Promise<boolean> {
  try { await readdir(path); return true }
  catch { return false }
}

/**
 * The profile used to probe this host. It is the real profile's namespace and
 * capability set, so a probe that passes proves the profile a wrap will use —
 * probing a weaker profile would certify a sandbox that then fails to start.
 */
export function bwrapProbeArgs(workspaceRoot: string, variant: BwrapVariant): readonly string[] {
  return Object.freeze([...baseArgs(variant), '--chdir', workspaceRoot, '--', 'true'])
}

/**
 * What this backend achieves for a network mode. A namespace removes every
 * route, so `deny` is met exactly and `loopback` is met by construction.
 */
export function bwrapNetworkEnforcement(network: NetworkMode): NetworkEnforcement {
  return network === 'allow-all' ? 'none' : 'full'
}
