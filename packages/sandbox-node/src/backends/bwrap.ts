/**
 * Linux bubblewrap backend.
 *
 * The host root is bound read-only and writable roots are layered back on top,
 * then every protected subpath and deny carve-out is re-applied *after* its
 * broader grant — bind order is what makes `/repo = write, /repo/.git = deny`
 * behave as written. A private PID namespace is part of the boundary, not a
 * convenience: without it, procfs magic links reach outside the mounts.
 */

import type { RunnerFailureRule, SandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'
import { grantLayers, pathDepth } from '@alvin0/ai-agent-sdk-sandbox'
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

/** The namespace and capability arguments shared by the profile and its probe. */
function baseArgs(variant: BwrapVariant): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    ...(variant === 'full' ? ['--proc', '/proc'] : []),
    '--unshare-pid', '--unshare-ipc', '--unshare-user',
    '--new-session', '--die-with-parent',
    '--cap-drop', 'ALL',
  ]
}

/** Stderr substrings a file effect denied by bubblewrap's binds produces. */
export const BWRAP_DENIAL_SIGNATURES: readonly string[] = Object.freeze([
  'read-only file system', 'permission denied', 'operation not permitted',
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
  tempRoots: readonly string[],
  variant: BwrapVariant = 'full',
): Promise<readonly string[]> {
  const resolver = nodePathResolver()
  const args: string[] = baseArgs(variant)
  const sealReadOnly: string[] = []

  for (const layer of grantLayers(policy, { tempRoots })) {
    // Bind the canonical location: a layer named through a symlink would
    // otherwise govern whatever the link happens to point at.
    const real = await resolver.realpath(layer.path)
    if (layer.access === 'write') {
      args.push('--bind', real, real)
    } else if (layer.access === 'read') {
      args.push('--ro-bind-try', real, real)
    } else if (await isDirectory(real)) {
      // An empty tmpfs hides the contents, but a bare tmpfs is writable, so the
      // denial is only real once it is remounted read-only. That remount is
      // deferred: sealing it here would leave bubblewrap unable to create the
      // mount point for a narrower grant reopened inside this subtree
      // ("Can't mkdir ...: Read-only file system").
      args.push('--tmpfs', real)
      sealReadOnly.push(real)
    } else {
      args.push('--ro-bind-try', '/dev/null', real)
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
 * The profile used to probe this host. It is the real profile's namespace and
 * capability set, so a probe that passes proves the profile a wrap will use —
 * probing a weaker profile would certify a sandbox that then fails to start.
 */
export function bwrapProbeArgs(workspaceRoot: string, variant: BwrapVariant): readonly string[] {
  return Object.freeze([...baseArgs(variant), '--chdir', workspaceRoot, '--', 'true'])
}
