/**
 * Reading a command for what it *does*, not just what it touches.
 *
 * The file seam cannot tell `systemctl status nginx` from `systemctl restart
 * nginx`: both are argv, neither writes a file the policy cares about, and one
 * observes while the other changes the machine. Deciding between them needs the
 * command read semantically, before any of it runs.
 *
 * This is a classifier, and a classifier is a guess. Two rules keep the guess
 * from becoming a hazard: a command it does not recognise is never allowed, and
 * a command that hides other commands — a shell string, a pipeline, a chain —
 * is classified by the riskiest thing inside it rather than by its wrapper.
 */

/** What a command does to the machine, in increasing order of consequence. */
export type ExecCapability =
  | 'observe'
  | 'use'
  | 'modify'
  | 'service-control'
  | 'package-install'
  | 'privilege'
  | 'credential'
  | 'critical'
  | 'unknown'

/** What a harness should do with a command carrying that capability. */
export type ExecOutcome = 'allow' | 'allow-scoped' | 'ask-approval' | 'deny'

/** One classified command, and why it was classified that way. */
export interface ExecClassification {
  readonly capability: ExecCapability
  readonly outcome: ExecOutcome
  /** The program the decision was made about, after unwrapping. */
  readonly program: string
  /** Why, in terms a person approving it can check. */
  readonly reason: string
  /** Every command found inside a shell string or chain, already classified. */
  readonly parts: readonly ExecClassification[]
}

/** The outcome each capability maps to, before a deployment adjusts it. */
export const DEFAULT_EXEC_OUTCOMES: Readonly<Record<ExecCapability, ExecOutcome>> = Object.freeze({
  observe: 'allow',
  use: 'allow-scoped',
  modify: 'ask-approval',
  'service-control': 'ask-approval',
  'package-install': 'ask-approval',
  privilege: 'ask-approval',
  credential: 'deny',
  critical: 'deny',
  // A command nobody recognised is not a safe command; it is an unread one.
  unknown: 'ask-approval',
})

/** Consequence order, used to pick the decisive command in a chain. */
export const CAPABILITY_RANK: Readonly<Record<ExecCapability, number>> = Object.freeze({
  observe: 0, use: 1, unknown: 2, modify: 3, 'service-control': 4,
  'package-install': 5, privilege: 6, credential: 7, critical: 8,
})
