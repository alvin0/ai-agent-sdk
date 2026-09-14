/**
 * Spawn options a confined execution must be given.
 *
 * Neither bubblewrap nor Seatbelt closes inherited file descriptors, and a
 * descriptor is a capability the kernel already granted: a confined child
 * holding an fd opened before the wrap can read and write through it no matter
 * what the mounts say, because the path was never consulted again. The boundary
 * therefore depends on the caller passing nothing but the three standard
 * streams — which is easy to get wrong silently, so it is offered here rather
 * than left as advice.
 */

import type { ConfinedArgv } from '@alvin0/ai-agent-sdk-sandbox'

/** The `stdio` and `env` a confined execution should be spawned with. */
export interface SandboxSpawnOptions {
  /**
   * The standard streams, plus a pipe at the runner's status descriptor when it
   * has one. Nothing else: an inherited capability rides along otherwise.
   */
  readonly stdio: readonly ('ignore' | 'pipe')[]
  /** The caller's environment plus the confinement markers. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * Build the spawn options for one wrapped argv.
 * @param confined - the result of `confine()`.
 * @param env - the environment to start from; defaults to the current process's.
 * @param stdin - whether the child gets a pipe on stdin or nothing at all.
 */
export function sandboxSpawnOptions(
  confined: ConfinedArgv,
  env: Readonly<Record<string, string | undefined>> = process.env,
  stdin: 'ignore' | 'pipe' = 'ignore',
): SandboxSpawnOptions {
  const stdio: ('ignore' | 'pipe')[] = [stdin, 'pipe', 'pipe']
  if (confined.statusFd !== undefined) {
    while (stdio.length < confined.statusFd) stdio.push('ignore')
    stdio[confined.statusFd] = 'pipe'
  }
  return Object.freeze({ stdio: Object.freeze(stdio), env: Object.freeze({ ...env, ...confined.env }) })
}

/**
 * Read the runner's own status report back from a finished spawn.
 *
 * @param confined - the wrap that produced the execution.
 * @param output - `spawnSync`'s `output` array, or the collected text of the
 *   status pipe for an async spawn.
 * @returns whether the runner reported that it executed the command. A runner
 *   without a status channel reports `undefined`, and classification then falls
 *   back to stderr — which a command can forge.
 */
export function sandboxChildStarted(
  confined: ConfinedArgv,
  output: readonly (string | Buffer | null)[] | string,
): boolean | undefined {
  if (confined.statusFd === undefined) return undefined
  const raw = typeof output === 'string' ? output : output[confined.statusFd]
  if (raw === null || raw === undefined) return undefined
  return String(raw).includes('"child-pid"')
}
