/**
 * Outcome classification.
 *
 * Two failures look alike in a shell but mean opposite things. A *denial* means
 * confinement worked and blocked the command. A *runner failure* means the
 * sandbox itself refused or crashed and the command never ran at all. Reporting
 * the second as the first sends a model off rewriting correct code, so runner
 * failure is always checked first and never inferred from an exit code alone.
 */

/** Evidence that a runner failed before it executed the wrapped command. */
export interface RunnerFailureRule {
  /** Nonzero exits this rule may match; omitted permits any nonzero exit. */
  readonly allowedExitCodes?: readonly number[]
  /** Case-insensitive substrings identifying a fatal runner diagnostic. */
  readonly fatalSignatures: readonly string[]
  /** Benign lines removed by exact, case-insensitive full-line equality first. */
  readonly informationalLines?: readonly string[]
  /**
   * Substrings that disqualify a line from proving runner failure, applied
   * before {@link fatalSignatures}. A runner reports the child's failed `exec`
   * under its own name and often its own exit code, so the prefix that
   * identifies its diagnostics also matches an ordinary missing program; this
   * is how that one case is carved back out.
   */
  readonly excludedSignatures?: readonly string[]
}

/** What a finished confined command turned out to be. */
export type SandboxOutcomeKind = 'success' | 'runner-failure' | 'denied' | 'command-failure'

/** The observable result of spawning a confined argv. */
export interface CommandOutcome {
  /** Process exit code; a signalled process reports its conventional code. */
  readonly exitCode: number
  /** Stderr text as produced, never rewritten by classification. */
  readonly stderr: string
  /** Terminating signal name, when the host reports one. */
  readonly signal?: string | null
}

/** Evidence a consumer needs to classify one confined command's outcome. */
export interface SandboxClassificationInput {
  /** Denial dialect of the backend that actually wrapped this command. */
  readonly denialSignatures: readonly string[]
  /** Structured runner-failure evidence for that same backend. */
  readonly runnerFailureRules: readonly RunnerFailureRule[]
}

/** A classified outcome plus the stderr line that proved it. */
export interface SandboxClassification {
  readonly kind: SandboxOutcomeKind
  /** The stderr line that matched, kept verbatim for the caller to surface. */
  readonly evidence?: string
}

/**
 * Exit codes that are ordinary shell failures and never sandbox evidence:
 * 2 misuse of a builtin, 126 not executable, 127 command not found.
 */
const SHELL_FAILURE_EXIT_CODES: readonly number[] = Object.freeze([2, 126, 127])

/** POSIX `SIGSYS`, raised when a seccomp filter kills the process. */
const SIGSYS_EXIT_CODE = 128 + 31

/**
 * Classify one confined command's outcome.
 *
 * Runner failure is tested first, then a seccomp kill (deterministic, no text
 * matching needed), then the backend's own denial dialect. A cross-backend
 * union of denial strings is deliberately not used: it would claim denials a
 * given backend never produces.
 */
export function classifyOutcome(
  outcome: CommandOutcome,
  input: SandboxClassificationInput,
): SandboxClassification {
  if (outcome.exitCode === 0) return Object.freeze({ kind: 'success' })

  const lines = outcome.stderr.split(/\r?\n/)
  for (const rule of input.runnerFailureRules) {
    const evidence = matchRunnerFailure(outcome.exitCode, lines, rule)
    if (evidence !== undefined) return Object.freeze({ kind: 'runner-failure', evidence })
  }

  if (outcome.signal === 'SIGSYS' || outcome.exitCode === SIGSYS_EXIT_CODE) {
    return Object.freeze({ kind: 'denied', evidence: 'process killed by SIGSYS (seccomp)' })
  }

  if (SHELL_FAILURE_EXIT_CODES.includes(outcome.exitCode)) {
    return Object.freeze({ kind: 'command-failure' })
  }

  const denial = matchSignature(lines, input.denialSignatures)
  return denial === undefined
    ? Object.freeze({ kind: 'command-failure' })
    : Object.freeze({ kind: 'denied', evidence: denial })
}

/** Apply one runner-failure rule to a finished process. */
function matchRunnerFailure(
  exitCode: number,
  lines: readonly string[],
  rule: RunnerFailureRule,
): string | undefined {
  if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(exitCode)) return undefined
  const informational = new Set((rule.informationalLines ?? []).map(line => line.trim().toLowerCase()))
  const excluded = (rule.excludedSignatures ?? []).map(signature => signature.toLowerCase())
  const remaining = lines.filter((line) => {
    const normalized = line.trim().toLowerCase()
    if (informational.has(normalized)) return false
    return !excluded.some(signature => signature !== '' && normalized.includes(signature))
  })
  return matchSignature(remaining, rule.fatalSignatures)
}

/** The first line containing any signature, matched case-insensitively. */
function matchSignature(lines: readonly string[], signatures: readonly string[]): string | undefined {
  if (signatures.length === 0) return undefined
  for (const line of lines) {
    const haystack = line.toLowerCase()
    if (signatures.some(signature => signature !== '' && haystack.includes(signature.toLowerCase()))) return line
  }
  return undefined
}

/**
 * Append a short, factual note to stderr explaining a sandbox outcome, so a
 * reader never has to infer confinement from a bare error string.
 */
export function annotateStderr(
  stderr: string,
  classification: SandboxClassification,
  mode: string,
): string {
  if (classification.kind === 'success' || classification.kind === 'command-failure') return stderr
  const note = classification.kind === 'runner-failure'
    ? `[sandbox] The sandbox runner failed before the command ran; the command did not execute. ${classification.evidence ?? ''}`.trim()
    : `[sandbox] Blocked by sandbox mode '${mode}'. ${classification.evidence ?? ''}`.trim()
  return stderr.endsWith('\n') || stderr === '' ? `${stderr}${note}\n` : `${stderr}\n${note}\n`
}
