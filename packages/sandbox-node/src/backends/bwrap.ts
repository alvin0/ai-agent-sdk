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
import { writableRoots, unreadablePaths } from '@alvin0/ai-agent-sdk-sandbox'
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

/** Build the bubblewrap profile arguments for one policy. */
export async function bwrapProfileArgs(
  policy: SandboxPolicy,
  tempRoots: readonly string[],
  variant: BwrapVariant = 'full',
): Promise<readonly string[]> {
  const resolver = nodePathResolver()
  const args: string[] = baseArgs(variant)

  const grants = writableRoots(policy, { tempRoots })
  if (policy.mode === 'workspace-write') {
    for (const root of grants.roots) {
      // Bind the canonical location: a symlinked workspace root would otherwise
      // grant write access to whatever the link happens to point at.
      const real = await resolver.realpath(root)
      args.push('--bind', real, real)
      if (real !== root) args.push('--bind', real, root)
    }
  }

  // Re-deny after the grants so the narrower rule is the one that survives.
  // Canonical paths throughout: the grant above was bound at its real location,
  // so a re-denial written through a symlink would land somewhere else.
  for (const denied of grants.denied) {
    const real = await resolver.realpath(denied)
    args.push('--ro-bind-try', real, real)
  }

  for (const hidden of unreadablePaths(policy)) {
    const real = await resolver.realpath(hidden)
    if (await isDirectory(real)) args.push('--tmpfs', real)
    else args.push('--ro-bind-try', '/dev/null', real)
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
