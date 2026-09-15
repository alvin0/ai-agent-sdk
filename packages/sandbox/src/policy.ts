/**
 * Per-call policy resolution.
 *
 * The policy is carried per capability call rather than fixed on the provider:
 * two consumers may confine under different boundaries at the same instant, and
 * an approved escalation is a new call with a wider policy — never a mutation
 * of shared provider state.
 */

import type { SandboxApproval } from './approval.ts'
import { requireSandboxApproval } from './approval.ts'
import type { FileSystemAccess, FileSystemEntry } from './entries.ts'
import { orderEntries } from './entries.ts'
import { SandboxPolicyError } from './errors.ts'
import type { ConfinedSandboxMode, SandboxMode } from './mode.ts'
import type { NetworkMode } from './network.ts'
import { narrowNetwork } from './network.ts'
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
  /**
   * The access in force where no layer applies.
   *
   * `read` — the default — means the host is readable and a policy closes
   * paths one at a time, which is a deny-list: it protects what someone
   * remembered to name. `deny` inverts that into an allow-list, where nothing
   * is readable until an entry says so, and a path nobody thought about is
   * closed rather than open.
   */
  readonly baseline?: FileSystemAccess
  /**
   * What this execution may reach over the network. Independent of
   * {@link SandboxExecutionPolicy.mode}, which governs file effects only.
   */
  readonly network?: NetworkMode
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

/**
 * Inputs that select the policy for one capability call.
 *
 * `mode` and `entries` are the UNTRUSTED half: they arrive from whatever asked
 * for the execution, which in an agent is a model-authored tool payload. They
 * may only narrow. Widening lives behind {@link approval}, which a tool payload
 * cannot contain because it is a capability rather than data.
 */
export interface SandboxPolicyRequest {
  /**
   * The mode the caller asks for. Honoured only when it is at least as strict
   * as the session's own mode — a request can tighten its own execution, never
   * loosen it.
   */
  readonly mode?: SandboxMode
  /** The calling session's mode, as last logged for that session. */
  readonly sessionMode?: SandboxMode
  /** The calling session's immutable cwd; becomes the workspace boundary. */
  readonly cwd?: string
  /**
   * Carve-outs the caller asks for. Restrictions only: a `write` entry here is
   * an escalation attempt and is refused, because granting write to `.git` or
   * `~/.ssh` defeats the boundary just as completely as raising the mode.
   */
  readonly entries?: readonly FileSystemEntry[]
  /** The network reach the caller asks for; honoured only when it narrows. */
  readonly network?: NetworkMode
  /** An approval minted by `approveSandboxEscalation`; the only way to widen. */
  readonly approval?: SandboxApproval
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
  /** Access where no layer applies; see {@link SandboxExecutionPolicy.baseline}. */
  readonly baseline?: FileSystemAccess
  /**
   * Network reach for calls that do not narrow it. Defaults to `allow-all`,
   * which is what this package did before the seam existed; a deployment
   * running anything untrusted should set `deny` and widen per call.
   */
  readonly network?: NetworkMode
}

/**
 * Resolve the complete policy for one capability call.
 *
 * Authority only ever decreases across untrusted inputs: the deployment default
 * and the session's mode set a ceiling, a request may narrow beneath it, and a
 * minted approval is the single path that raises it. A session cwd is its
 * `workspace-write` boundary; the configured root is the fallback for agentless
 * calls and sessions without a cwd.
 * @param request - the calling session's untrusted ask, plus any approval.
 * @param defaults - deployment mode, workspace root, and standing carve-outs.
 * @throws SandboxPolicyError when a request tries to widen without an approval.
 */
export function resolveSandboxPolicy(
  request: SandboxPolicyRequest,
  defaults: SandboxPolicyDefaults,
): SandboxExecutionPolicy {
  const approval = request.approval === undefined ? undefined : requireSandboxApproval(request.approval)

  // The ceiling is what the deployment and the session already allow. A request
  // is clamped to it; only an approval may raise it.
  const ceiling = request.sessionMode ?? defaults.mode
  if (!isSandboxMode(ceiling)) throw new SandboxPolicyError(`Unknown sandbox mode '${String(ceiling)}'`)
  const requested = request.mode
  if (requested !== undefined && !isSandboxMode(requested)) {
    throw new SandboxPolicyError(`Unknown sandbox mode '${String(requested)}'`)
  }
  const narrowed = requested !== undefined && modeAuthority(requested) < modeAuthority(ceiling)
    ? requested
    : ceiling
  const mode = approval?.mode ?? narrowed

  const workspaceRoot = normalizePath(request.cwd ?? defaults.workspaceRoot)
  if (!isAbsolutePath(workspaceRoot)) {
    throw new SandboxPolicyError(`Sandbox workspace root must be absolute, received '${workspaceRoot}'`)
  }

  for (const entry of request.entries ?? []) {
    if (entry.access === 'write') {
      throw new SandboxPolicyError(
        `A requested entry may not grant write access to '${entry.path}'; `
        + 'widening a policy requires an approval minted by approveSandboxEscalation()',
      )
    }
  }

  // Deployment config first, then the caller's restrictions, then the approval —
  // so an approval can reopen what a restriction closed, and a restriction can
  // never reopen what the deployment closed unless it is narrower.
  const entries = orderEntries([
    ...(defaults.entries ?? []), ...(request.entries ?? []), ...(approval?.entries ?? []),
  ])
  // Reach narrows the same way authority does, and widens only with approval.
  const network = approval?.network
    ?? narrowNetwork(defaults.network ?? 'allow-all', request.network)

  return Object.freeze({
    mode, workspaceRoot, network,
    ...(defaults.baseline === undefined ? {} : { baseline: defaults.baseline }),
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
