/** File-effect vocabulary shared by every sandbox backend and consumer. */

/**
 * File-effect policy for confined processes. `read-only` permits only the sinks
 * a shell requires (`/dev/null` and its platform equivalent); `workspace-write`
 * additionally permits the workspace root and a backend-defined temp area;
 * `danger-full-access` bypasses confinement entirely.
 *
 * Network reachability and process visibility are deliberately outside this
 * vocabulary — they are governed by their own seam, not by a file-effect mode.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** A confining mode — the only modes a provider can be asked to enforce. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/**
 * Enforcement completeness for this host, reported as a fact rather than
 * promised. `partial` means the selected backend cannot govern every file
 * effect the mode promises; `fence-only` means no process confinement exists on
 * this platform and just the in-process path fence applies, so a consumer that
 * needs a kernel boundary must reject it rather than treat it as enforcement.
 */
export type SandboxEnforcement = 'full' | 'partial' | 'fence-only'

/** Every mode, in widening order of authority. */
export const SANDBOX_MODES: readonly SandboxMode[] = Object.freeze([
  'read-only', 'workspace-write', 'danger-full-access',
])

/** Whether an arbitrary value is one of the known modes. */
export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (SANDBOX_MODES as readonly string[]).includes(value)
}

/** Whether a mode still asks a provider to confine the execution. */
export function isConfinedMode(mode: SandboxMode): mode is ConfinedSandboxMode {
  return mode !== 'danger-full-access'
}

/** Rank used when a narrower mode must not be widened by a weaker source. */
export function modeAuthority(mode: SandboxMode): number {
  return SANDBOX_MODES.indexOf(mode)
}
