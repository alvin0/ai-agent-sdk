/**
 * macOS Seatbelt backend.
 *
 * The profile is allow-default with a blanket `(deny file-write*)` and explicit
 * write allow-lists, so exactly the mode's promised file effects are governed
 * and nothing else about the process changes. Every path is canonicalized
 * first because Seatbelt matches resolved paths — `/tmp` IS `/private/tmp`, and
 * a grant written the other way silently matches nothing.
 */

import type { RunnerFailureRule, SandboxPolicy } from '@alvin0/ai-agent-sdk-sandbox'
import { grantLayers } from '@alvin0/ai-agent-sdk-sandbox'
import { nodePathResolver } from '../fs/resolver.ts'

/** Program name; ships with macOS. */
export const SEATBELT_PROGRAM = '/usr/bin/sandbox-exec'

/** Stderr substrings a file effect denied by Seatbelt produces. */
export const SEATBELT_DENIAL_SIGNATURES: readonly string[] = Object.freeze([
  'operation not permitted', 'permission denied',
])

/**
 * `sandbox-exec` prefixes both its own refusals and the child's exec failures
 * with `sandbox-exec:`, so the prefix alone cannot separate them — a missing
 * program would read as a broken sandbox. Its exit code does separate them: a
 * rejected profile exits `EX_DATAERR` (65) while a failed `execvp` of the
 * child exits `EX_OSERR` (71), which is an ordinary command failure.
 */
export const SEATBELT_RUNNER_FAILURE_RULES: readonly RunnerFailureRule[] = Object.freeze([
  Object.freeze({
    allowedExitCodes: Object.freeze([65]),
    fatalSignatures: Object.freeze(['sandbox-exec:']),
    excludedSignatures: Object.freeze(['execvp']),
  }),
  Object.freeze({ fatalSignatures: Object.freeze(['sandbox_init', 'sandbox_apply']) }),
])

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Build the `sandbox-exec` arguments and SBPL profile for one policy.
 *
 * Layers are emitted in the order the contract resolved them, because SBPL
 * resolves by last match: a narrower rule only overrides a broader one if it
 * comes after it.
 */
export async function seatbeltProfileArgs(
  policy: SandboxPolicy,
  tempRoots: readonly string[],
): Promise<readonly string[]> {
  const resolver = nodePathResolver()
  const forms: string[] = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbplString('/dev/null')}))`,
  ]

  for (const layer of grantLayers(policy, { tempRoots })) {
    // Seatbelt matches resolved paths — `/tmp` IS `/private/tmp` — so a rule
    // written the other way silently matches nothing.
    const subpath = `(subpath ${sbplString(await resolver.realpath(layer.path))})`
    if (layer.access === 'write') forms.push(`(allow file-write* ${subpath})`)
    else forms.push(`(deny file-write* ${subpath})`)
    if (layer.access === 'deny') forms.push(`(deny file-read* ${subpath})`)
  }

  return Object.freeze(['-p', forms.join(' ')])
}

/** The read-only profile used to probe whether Seatbelt accepts a policy. */
export function seatbeltProbeArgs(): readonly string[] {
  return Object.freeze([
    '-p', '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))',
    'true',
  ])
}
