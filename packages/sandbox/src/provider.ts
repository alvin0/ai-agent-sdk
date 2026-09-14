/** The abstract sandbox seam: one wrap function and one in-process fence. */

import type { RunnerFailureRule } from './classify.ts'
import type { SandboxEnforcement } from './mode.ts'
import type { SandboxPolicy } from './policy.ts'

/** The argv to spawn in place of the caller's own, plus how to read its result. */
export interface ConfinedArgv {
  /** The wrapped argv: runner, profile arguments, separator, caller's argv. */
  readonly argv: readonly string[]
  /** How completely the selected backend enforces this policy's file effects. */
  readonly enforcement: SandboxEnforcement
  /** Identifier of the backend that produced this wrap. */
  readonly backend: string
  /**
   * The selected backend's denial DIALECT: the stderr substrings a file effect
   * denied by THIS backend produces. Matched instead of a cross-backend union,
   * which would claim denials this backend never emits.
   */
  readonly denialSignatures: readonly string[]
  /** Structured evidence that the runner failed before the command ran. */
  readonly runnerFailureRules: readonly RunnerFailureRule[]
  /** Environment additions marking the confinement for child processes. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * In-process path fence. It governs file effects a tool performs itself, which
 * no process sandbox can see, and is the only enforcement available on a
 * platform without a process backend.
 */
export interface FsFence {
  /** Throw `SandboxDeniedError` unless the path may be written. */
  assertWritable(path: string): Promise<void>
  /** Whether the path may be written, without throwing. */
  isWritable(path: string): Promise<boolean>
  /** Whether the path may be read; `deny` carve-outs make this false. */
  isReadable(path: string): Promise<boolean>
  /** The roots this fence permits writes under, for surfacing to a caller. */
  readonly writableRoots: readonly string[]
}

/**
 * Abstract process-sandbox service. `confine` must return an enforcing argv or
 * fail closed; silent unconfined passthrough is forbidden.
 */
export interface SandboxProvider {
  /** Stable identifier of this provider implementation. */
  readonly id: string
  /**
   * Wrap `argv` so it executes confined under `policy` on this host.
   * @param argv - the exact argv the caller is about to spawn, NOT a shell
   *   string; a shell-shaped consumer passes `['bash', '-c', command]`.
   * @param policy - the file-effect policy this execution runs under.
   * @returns the argv to spawn instead, plus its enforcement and dialects.
   */
  confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv>
  /** Build the in-process fence for the same policy the backends receive. */
  fence(policy: SandboxPolicy): FsFence
}

/** Filesystem facts the Universal contract cannot read for itself. */
export interface PathResolver {
  /** Canonical path with symlinks resolved, for the nearest existing ancestor. */
  realpath(path: string): Promise<string>
  /** Whether the path currently exists. */
  exists(path: string): Promise<boolean>
}
