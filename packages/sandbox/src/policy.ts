/**
 * Per-call policy resolution.
 *
 * The policy is carried per capability call rather than fixed on the provider:
 * two consumers may confine under different boundaries at the same instant, and
 * an approved escalation is a new call with a wider policy — never a mutation
 * of shared provider state.
 */

import type { FileSystemEntry } from './entries.ts'
import { orderEntries } from './entries.ts'
import { SandboxPolicyError } from './errors.ts'
import type { ConfinedSandboxMode, SandboxMode } from './mode.ts'
import { isConfinedMode, isSandboxMode, modeAuthority } from './mode.ts'
import { isAbsolutePath, normalizePath } from './path.ts'

/** The complete file-effect policy resolved for one capability call. */
export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  readonly mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  readonly workspaceRoot: string
  /** Nested carve-outs layered over the mode's base grant. */
  readonly entries?: readonly FileSystemEntry[]
  /** Opaque calling-session identity; backends key per-session state off it. */
  readonly sessionId?: string
}

/**
 * A policy narrowed to a confining mode — the only shape a provider accepts.
 * Resolution happens at the consumer boundary; the provider treats what it
 * receives as fully specified and never re-defaults anything.
 */
export interface SandboxPolicy extends SandboxExecutionPolicy {
  readonly mode: ConfinedSandboxMode
}

/** Inputs that select the policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Explicit approved mode override; outranks every other source. */
  readonly mode?: SandboxMode
  /** The calling session's mode, as last logged for that session. */
  readonly sessionMode?: SandboxMode
  /** The calling session's immutable cwd; becomes the workspace boundary. */
  readonly cwd?: string
  /** Carve-outs contributed by configuration or by an approval. */
  readonly entries?: readonly FileSystemEntry[]
  /** Opaque calling-session identity. */
  readonly sessionId?: string
}

/** Deployment-level fallbacks applied when a request omits them. */
export interface SandboxPolicyDefaults {
  /** Mode for calls that carry neither an override nor a session mode. */
  readonly mode: SandboxMode
  /** Workspace root for agentless calls and sessions without a cwd. */
  readonly workspaceRoot: string
  /** Carve-outs that always apply, before request-supplied ones. */
  readonly entries?: readonly FileSystemEntry[]
}

/**
 * Resolve the complete policy for one capability call. An approved explicit
 * mode outranks the session's mode, which outranks the deployment default. A
 * session cwd is its `workspace-write` boundary; the configured root is the
 * fallback for agentless calls and sessions without a cwd.
 * @param request - the calling session, approved override, and carve-outs.
 * @param defaults - deployment mode, workspace root, and standing carve-outs.
 */
export function resolveSandboxPolicy(
  request: SandboxPolicyRequest,
  defaults: SandboxPolicyDefaults,
): SandboxExecutionPolicy {
  const mode = request.mode ?? request.sessionMode ?? defaults.mode
  if (!isSandboxMode(mode)) throw new SandboxPolicyError(`Unknown sandbox mode '${String(mode)}'`)
  const workspaceRoot = normalizePath(request.cwd ?? defaults.workspaceRoot)
  if (!isAbsolutePath(workspaceRoot)) {
    throw new SandboxPolicyError(`Sandbox workspace root must be absolute, received '${workspaceRoot}'`)
  }
  const entries = orderEntries([...(defaults.entries ?? []), ...(request.entries ?? [])])
  return Object.freeze({
    mode, workspaceRoot,
    ...(entries.length === 0 ? {} : { entries }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  })
}

/**
 * Narrow a resolved policy to the confining shape a provider accepts.
 * @returns the confining policy, or `undefined` under `danger-full-access`,
 *   whose consumer spawns its original argv and never calls the provider.
 */
export function confiningPolicy(policy: SandboxExecutionPolicy): SandboxPolicy | undefined {
  return isConfinedMode(policy.mode) ? (policy as SandboxPolicy) : undefined
}

/**
 * Narrow a policy toward a stricter mode without widening it. Used where a
 * consumer may tighten a caller's policy but must never loosen it.
 */
export function narrowPolicy(policy: SandboxExecutionPolicy, mode: SandboxMode): SandboxExecutionPolicy {
  return modeAuthority(mode) < modeAuthority(policy.mode) ? Object.freeze({ ...policy, mode }) : policy
}
