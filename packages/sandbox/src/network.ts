/**
 * Network reachability — a seam of its own, deliberately not a file-effect mode.
 *
 * `SandboxMode` governs file effects and says so. Folding network reachability
 * into it would make the mode claim something it does not decide, and a mode
 * that lies about its scope is worse than one with a narrow one. So network is
 * a second, independent axis carried on the same policy: a call can be
 * `read-only` on the filesystem and still reach the internet, or writable in
 * its workspace and reach nothing.
 *
 * The distinction matters because the two are enforced by different mechanisms
 * — mount bindings versus a network namespace — and a host can provide one
 * without the other.
 */

import { SandboxPolicyError } from './errors.ts'

/**
 * What a confined execution may reach.
 *
 * `loopback` is not a weaker `deny`: it is what a command needs when the
 * deployment runs a proxy or a language server it is meant to talk to, and
 * nothing else. On a host whose only mechanism is a network namespace the two
 * enforce identically, which the enforcement report says rather than hides.
 */
export type NetworkMode = 'deny' | 'loopback' | 'allow-all'

/** Every network mode, in widening order of reach. */
export const NETWORK_MODES: readonly NetworkMode[] = Object.freeze(['deny', 'loopback', 'allow-all'])

/** How completely a backend enforces a network mode. */
export type NetworkEnforcement = 'full' | 'loopback-only' | 'none'

/** Whether an arbitrary value is one of the known network modes. */
export function isNetworkMode(value: unknown): value is NetworkMode {
  return typeof value === 'string' && (NETWORK_MODES as readonly string[]).includes(value)
}

/** Rank used so an untrusted request can narrow reach but never widen it. */
export function networkAuthority(mode: NetworkMode): number {
  return NETWORK_MODES.indexOf(mode)
}

/**
 * Narrow a network mode toward a stricter one, refusing to widen.
 * @param ceiling - the reach already permitted.
 * @param requested - the reach being asked for.
 * @returns the stricter of the two.
 */
export function narrowNetwork(ceiling: NetworkMode, requested: NetworkMode | undefined): NetworkMode {
  if (requested === undefined) return ceiling
  if (!isNetworkMode(requested)) {
    throw new SandboxPolicyError(`Unknown network mode '${String(requested)}'`)
  }
  return networkAuthority(requested) < networkAuthority(ceiling) ? requested : ceiling
}
