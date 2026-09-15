/**
 * Runner selection.
 *
 * Selection is by platform first, probe second. A platform whose chain is empty
 * — or whose every candidate fails its probe — is unavailable, and `confine()`
 * fails closed rather than returning an unconfined argv. The probe runs the
 * real `read-only` profile over `true`: a runner that cannot apply its own
 * profile on this kernel reports a nonzero exit, which is exactly the verdict
 * that matters.
 */

import { spawnSync } from 'node:child_process'
import type { RunnerFailureRule, SandboxEnforcement } from '@alvin0/ai-agent-sdk-sandbox'
import {
  BWRAP_DENIAL_SIGNATURES, BWRAP_PROGRAM, BWRAP_RUNNER_FAILURE_RULES, bwrapProbeArgs,
} from './backends/bwrap.ts'
import {
  SEATBELT_DENIAL_SIGNATURES, SEATBELT_PROGRAM, SEATBELT_RUNNER_FAILURE_RULES, seatbeltProbeArgs,
} from './backends/seatbelt.ts'

/** A process-confinement rung this package can select. */
export type RunnerId = 'bwrap' | 'bwrap-restricted' | 'seatbelt'

/** Everything a runner contributes to a wrap, independent of the policy. */
export interface RunnerDescriptor {
  readonly id: RunnerId
  /** Program to spawn, resolved on `PATH` or by absolute path. */
  readonly program: string
  /** Enforcement this rung achieves when its profile applies cleanly. */
  readonly enforcement: SandboxEnforcement
  /** Token placed between the profile arguments and the caller's argv. */
  readonly separator: readonly string[]
  readonly denialSignatures: readonly string[]
  readonly runnerFailureRules: readonly RunnerFailureRule[]
}

/**
 * Candidate rungs per platform, in preference order. `win32` is deliberately
 * empty: see `backends/windows.ts` for why, and what still applies there.
 */
export const PLATFORM_CHAINS: Readonly<Record<string, readonly RunnerId[]>> = Object.freeze({
  linux: Object.freeze(['bwrap', 'bwrap-restricted'] as const),
  darwin: Object.freeze(['seatbelt'] as const),
  win32: Object.freeze([] as const),
})

/** First upstream release containing GHSA-pxhw-h44j-8pfx's setup fix. */
export const MINIMUM_SAFE_BWRAP_VERSION = '0.12.0'

/** Whether `bwrap --version` identifies an upstream release with the fix. */
export function isSafeBubblewrapVersion(output: string): boolean {
  const match = /(?:bubblewrap|bwrap)\s+(\d+)\.(\d+)\.(\d+)/i.exec(output)
  if (match === null) return false
  const found = match.slice(1, 4).map(Number)
  const minimum = MINIMUM_SAFE_BWRAP_VERSION.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if ((found[index] ?? 0) > (minimum[index] ?? 0)) return true
    if ((found[index] ?? 0) < (minimum[index] ?? 0)) return false
  }
  return true
}

function safeBubblewrapInstalled(program: string, timeoutMs: number): boolean {
  try {
    const version = spawnSync(program, ['--version'], {
      timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    return version.error === undefined && version.status === 0
      && isSafeBubblewrapVersion(`${version.stdout ?? ''}\n${version.stderr ?? ''}`)
  } catch { return false }
}

const DESCRIPTORS: Readonly<Record<RunnerId, RunnerDescriptor>> = Object.freeze({
  bwrap: Object.freeze({
    id: 'bwrap', program: BWRAP_PROGRAM, enforcement: 'full' as const,
    separator: Object.freeze(['--']),
    denialSignatures: BWRAP_DENIAL_SIGNATURES,
    runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES,
  }),
  'bwrap-restricted': Object.freeze({
    id: 'bwrap-restricted', program: BWRAP_PROGRAM, enforcement: 'partial' as const,
    separator: Object.freeze(['--']),
    denialSignatures: BWRAP_DENIAL_SIGNATURES,
    runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES,
  }),
  seatbelt: Object.freeze({
    id: 'seatbelt', program: SEATBELT_PROGRAM, enforcement: 'full' as const,
    // `sandbox-exec` treats `--` as the command to run, so no separator.
    separator: Object.freeze([]),
    denialSignatures: SEATBELT_DENIAL_SIGNATURES,
    runnerFailureRules: SEATBELT_RUNNER_FAILURE_RULES,
  }),
})

/** The static facts for one rung. */
export function runnerDescriptor(id: RunnerId): RunnerDescriptor {
  return DESCRIPTORS[id]
}

/** The candidate chain for a platform, empty when none is supported. */
export function platformChain(platform: string): readonly RunnerId[] {
  return PLATFORM_CHAINS[platform] ?? Object.freeze([])
}

/**
 * Functionally probe one rung by applying its real `read-only` profile to
 * `true`. A missing program, a kernel that refuses the profile, and a runner
 * that cannot create user namespaces all fail the same way: unusable.
 */
export function probeRunner(id: RunnerId, workspaceRoot: string, timeoutMs: number): boolean {
  const descriptor = DESCRIPTORS[id]
  if (id !== 'seatbelt' && !safeBubblewrapInstalled(descriptor.program, timeoutMs)) return false
  const args = id === 'seatbelt'
    ? seatbeltProbeArgs()
    : bwrapProbeArgs(workspaceRoot, id === 'bwrap' ? 'full' : 'restricted')
  try {
    // The bubblewrap profile reports status on its own descriptor, so the probe
    // has to provide one: writing to a closed fd would fail the probe for a
    // runner that works.
    const probe = spawnSync(descriptor.program, [...args], {
      timeout: timeoutMs,
      stdio: id === 'seatbelt' ? 'ignore' : ['ignore', 'ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    return probe.error === undefined && probe.status === 0
  } catch { return false }
}
