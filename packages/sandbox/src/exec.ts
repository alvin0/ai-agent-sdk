import { CAPABILITY_RANK, type ExecCapability, type ExecOutcome, type ExecClassification } from './exec-types.ts'
import { DEFAULT_EXEC_OUTCOMES } from './exec-types.ts'
import { splitCommands } from './exec-shell.ts'
import { classifySingle, decide } from './exec-program.ts'
export { DEFAULT_EXEC_OUTCOMES } from './exec-types.ts'
export type { ExecCapability, ExecOutcome, ExecClassification } from './exec-types.ts'
export { splitCommands, tokenizeScript } from './exec-shell.ts'

/**
 * Classify one command.
 * @param argv - the exact argv, program first. A shell string is read through.
 * @param outcomes - the capability-to-outcome mapping a deployment uses.
 */
export function classifyExec(
  argv: readonly string[],
  outcomes: Readonly<Record<ExecCapability, ExecOutcome>> = DEFAULT_EXEC_OUTCOMES,
): ExecClassification {
  // A segment that is only shell keywords — a bare `fi`, a closing `done` — is
  // punctuation, not a command. Left in, it classifies as unrecognised and
  // drags a whole chain to an approval prompt: `if ...; then npm test; fi`
  // would ask about running its own test suite.
  const parts = splitCommands(argv)
    .map(part => classifySingle(part, outcomes))
    .filter(part => part.program !== '(empty)')
  if (parts.length === 0) {
    return decide('unknown', '(empty)', 'no command to classify', { parts: [], outcomes: outcomes })
  }
  if (parts.length === 1) return parts[0] as ExecClassification

  // A chain is as consequential as its worst link; wrapping `rm -rf /etc` after
  // an `echo` must not make the pair look like an `echo`.
  const worst = parts.reduce((left, right) =>
    CAPABILITY_RANK[right.capability] > CAPABILITY_RANK[left.capability] ? right : left)
  return decide(
    worst.capability, worst.program,
    `a chain of ${String(parts.length)} commands, decided by its riskiest: ${worst.reason}`,
    { parts: parts, outcomes: outcomes },
  )
}
