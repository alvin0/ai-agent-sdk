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
import { confinedEnv, type ConfinedEnvOptions } from './env.ts'

/** The `stdio` and `env` a confined execution should be spawned with. */
export interface SandboxSpawnOptions {
  /**
   * The standard streams, plus a pipe at the runner's status descriptor when it
   * has one. Nothing else: an inherited capability rides along otherwise.
   */
  readonly stdio: readonly ('ignore' | 'pipe')[]
  /** The allowed environment plus the confinement markers. */
  readonly env: Readonly<Record<string, string>>
  /** Whether the child leads its own process group, so it can be torn down. */
  readonly detached: boolean
}

/** How a confined execution is spawned. */
export interface SandboxSpawnInput extends ConfinedEnvOptions {
  /** Whether the child gets a pipe on stdin or nothing at all. */
  readonly stdin?: 'ignore' | 'pipe'
  /**
   * Make the child a process-group leader so the whole group can be signalled
   * at once. Required by `terminateConfined`, and on by default because a
   * command that outlives its cancellation is a command still writing.
   */
  readonly detached?: boolean
}

/**
 * Build the spawn options for one wrapped argv.
 *
 * The environment is an allow-list, not an inheritance: the spawning process
 * usually holds the credentials the agent runs on, and a file boundary says
 * nothing about environment variables.
 *
 * @param confined - the result of `confine()`.
 */
export function sandboxSpawnOptions(
  confined: ConfinedArgv,
  input: SandboxSpawnInput = {},
): SandboxSpawnOptions {
  const stdin = input.stdin ?? 'ignore'
  const stdio: ('ignore' | 'pipe')[] = [stdin, 'pipe', 'pipe']
  if (confined.statusFd !== undefined) {
    while (stdio.length < confined.statusFd) stdio.push('ignore')
    stdio[confined.statusFd] = 'pipe'
  }
  return Object.freeze({
    stdio: Object.freeze(stdio),
    env: confinedEnv(confined.env, input),
    detached: input.detached ?? true,
  })
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
