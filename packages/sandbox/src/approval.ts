/**
 * The authorization boundary.
 *
 * Everything a tool sends arrives as JSON the model can write, so a policy
 * input that widens authority is one the model can grant itself. The demonstrated
 * attack is exactly that: a tool call carrying `mode: 'danger-full-access'`, or
 * an entry granting write to `.git`, and the resolver honouring it because
 * nothing distinguished "what was asked for" from "what was approved".
 *
 * An approval is therefore a capability, not data: it exists only if this module
 * minted it, and `JSON.parse` cannot produce one. A host mints it after whatever
 * out-of-band check it uses — a human prompt, a policy engine — and only a
 * minted approval may widen a policy.
 */

import type { FileSystemEntry } from './entries.ts'
import { SandboxPolicyError } from './errors.ts'
import type { SandboxMode } from './mode.ts'
import type { NetworkMode } from './network.ts'

/** How long a minted approval remains usable. */
export type SandboxApprovalScope = 'single-call' | 'session'

/** What an approval permits, beyond what the session already allows. */
export interface SandboxApprovalGrant {
  /**
   * Whether the approval survives the call it was minted for.
   *
   * `single-call` — the default — is consumed the first time a policy is
   * resolved with it, so a grant given for one operation cannot be replayed
   * for the next. A person approving "read this file" approved one read.
   */
  readonly scope?: SandboxApprovalScope
  /** Wall-clock deadline in epoch milliseconds, after which it is refused. */
  readonly expiresAt?: number
  /** Mode the approval raises this call to. */
  readonly mode?: SandboxMode
  /** Entries the approval may add, including widening ones. */
  readonly entries?: readonly FileSystemEntry[]
  /** Network reach the approval raises this call to. */
  readonly network?: NetworkMode
  /** Free-text reason, carried for audit; never interpreted. */
  readonly justification?: string
}

/**
 * An approval token. Structurally it is just its grant, but only a value minted
 * by {@link approveSandboxEscalation} is accepted — a look-alike object, however
 * carefully shaped, is refused.
 */
export interface SandboxApproval extends SandboxApprovalGrant {
  readonly approved: true
}

/**
 * The minted set. A `WeakSet` is the whole mechanism: membership cannot be
 * forged, serialized, or reached from inside a tool payload.
 */
const MINTED = new WeakSet<object>()

/** Approvals already consumed. Separate from minting, so the refusal differs. */
const SPENT = new WeakSet<object>()

/**
 * Mint an approval. Call this only after the host has actually authorized the
 * escalation; the SDK cannot tell an approved grant from a requested one, which
 * is precisely why this call has to be the place the distinction is made.
 */
export function approveSandboxEscalation(grant: SandboxApprovalGrant): SandboxApproval {
  const approval: SandboxApproval = Object.freeze({ ...grant, approved: true })
  MINTED.add(approval)
  return approval
}

/** Whether a value is an approval this module minted. */
export function isSandboxApproval(value: unknown): value is SandboxApproval {
  return typeof value === 'object' && value !== null && MINTED.has(value)
}

/** Whether a minted approval has already been used up. */
export function isSandboxApprovalSpent(approval: SandboxApproval): boolean {
  return SPENT.has(approval)
}

/**
 * Accept an approval, or refuse it loudly.
 * @throws SandboxPolicyError when the value was not minted here — which is what
 *   a forged approval arriving through a tool payload looks like.
 */
export function requireSandboxApproval(value: unknown, now: number = Date.now()): SandboxApproval {
  if (!isSandboxApproval(value)) {
    throw new SandboxPolicyError(
      'Sandbox escalation requires an approval minted by approveSandboxEscalation(); '
      + 'a plain object cannot widen a policy, because a tool payload can contain one',
    )
  }
  if (value.expiresAt !== undefined && now > value.expiresAt) {
    throw new SandboxPolicyError(
      'This sandbox approval has expired; an escalation outliving the moment it was '
      + 'granted is an escalation nobody is still watching',
    )
  }
  if (SPENT.has(value)) {
    throw new SandboxPolicyError(
      'This sandbox approval was already used; a grant given for one operation cannot '
      + 'be replayed for the next',
    )
  }
  if ((value.scope ?? 'single-call') === 'single-call') SPENT.add(value)
  return value
}
