/** Normalized sandbox violations, shaped for audit and telemetry. */

import type { SandboxClassification } from './classify.ts'

/** The enforcement layer that observed a violation. */
export type SandboxViolationBackend = 'bwrap' | 'seatbelt' | 'windows-acl' | 'fence' | 'custom'

/** Why a file effect was refused, normalized across backend dialects. */
export type SandboxViolationReason =
  | 'operation-not-permitted'
  | 'permission-denied'
  | 'read-only-filesystem'
  | 'policy-denied'
  | 'runner-failure'

/** One observed violation, retaining the evidence that identified it. */
export interface SandboxViolation {
  readonly backend: SandboxViolationBackend
  readonly reason: SandboxViolationReason
  readonly mode: string
  /** The path involved, when the backend named one. */
  readonly path?: string
  /** Bounded evidence excerpt; never the whole output. */
  readonly snippet: string
}

/** Upper bound on retained evidence, so a violation never carries a log dump. */
const SNIPPET_MAX_LENGTH = 512

const REASON_SIGNATURES: readonly (readonly [SandboxViolationReason, string])[] = Object.freeze([
  ['operation-not-permitted', 'operation not permitted'],
  ['permission-denied', 'permission denied'],
  ['read-only-filesystem', 'read-only file system'],
  ['read-only-filesystem', 'erofs'],
  ['policy-denied', 'seccomp'],
  ['policy-denied', 'landlock'],
])

/**
 * Build a violation record from a classified outcome.
 * @returns the record, or `undefined` when the outcome was not a violation.
 */
export function sandboxViolation(
  classification: SandboxClassification,
  backend: SandboxViolationBackend,
  mode: string,
): SandboxViolation | undefined {
  if (classification.kind !== 'denied' && classification.kind !== 'runner-failure') return undefined
  const evidence = classification.evidence ?? ''
  const reason: SandboxViolationReason = classification.kind === 'runner-failure'
    ? 'runner-failure'
    : reasonFor(evidence)
  const path = pathIn(evidence)
  return Object.freeze({
    backend, reason, mode,
    ...(path === undefined ? {} : { path }),
    snippet: evidence.slice(0, SNIPPET_MAX_LENGTH),
  })
}

/** Map one evidence line to a normalized reason. */
function reasonFor(evidence: string): SandboxViolationReason {
  const haystack = evidence.toLowerCase()
  for (const [reason, signature] of REASON_SIGNATURES) {
    if (haystack.includes(signature)) return reason
  }
  return 'policy-denied'
}

/** Extract the first absolute path a denial message mentions, if any. */
function pathIn(evidence: string): string | undefined {
  const match = /(\/[^\s:'"]+|[A-Za-z]:[\\/][^\s:'"]*)/.exec(evidence)
  return match?.[0]
}
