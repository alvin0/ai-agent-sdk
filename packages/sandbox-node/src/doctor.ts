/**
 * Dependency diagnosis.
 *
 * A sandbox that silently turns itself off because a tool is missing is worse
 * than no sandbox: the operator configured a boundary, sees no error, and
 * believes it is enforced. This reports why confinement is unavailable in terms
 * an operator can act on, so a caller can surface it at startup.
 */

import type { SandboxEnforcement } from '@alvin0/ai-agent-sdk-sandbox'
import { platformChain, probeRunner, runnerDescriptor, type RunnerId } from './select.ts'
import { WINDOWS_UNAVAILABLE_REASON } from './backends/windows.ts'

/** What the host can and cannot do, and what to install to change that. */
export interface SandboxDependencyReport {
  readonly platform: string
  /** The rung that would be selected, when one is usable. */
  readonly backend?: RunnerId
  /** How completely that rung enforces; absent when none is usable. */
  readonly enforcement?: SandboxEnforcement
  /** Conditions that prevent process confinement entirely. */
  readonly errors: readonly string[]
  /** Conditions that narrow enforcement without disabling it. */
  readonly warnings: readonly string[]
  /** Whether the in-process fence is available; it always is. */
  readonly fenceAvailable: true
}

/** Operator-facing remediation per rung. */
const REMEDIATION: Readonly<Record<RunnerId, string>> = Object.freeze({
  bwrap: "install bubblewrap >= 0.12.0, or run under WSL2 rather than WSL1",
  'bwrap-restricted':
    'install bubblewrap >= 0.12.0; it must also be able to create user namespaces (WSL1 cannot), and a container host '
    + 'must permit unprivileged user namespaces',
  seatbelt: 'sandbox-exec is missing from /usr/bin, which means this is not a supported macOS host',
})

/**
 * Diagnose process-confinement availability on this host.
 * @param workspaceRoot - an absolute directory the probe can chdir into.
 * @param platform - platform identifier; defaults to the running one.
 * @param probeTimeoutMs - per-candidate probe timeout.
 */
export function checkSandboxDependencies(
  workspaceRoot: string,
  platform: string = process.platform,
  probeTimeoutMs = 5_000,
): SandboxDependencyReport {
  const chain = platformChain(platform)
  if (chain.length === 0) {
    const reason = platform === 'win32'
      ? WINDOWS_UNAVAILABLE_REASON
      : `platform ${platform} has no process-confinement backend in this package`
    return Object.freeze({ platform, errors: Object.freeze([reason]), warnings: Object.freeze([]), fenceAvailable: true })
  }

  const errors: string[] = []
  for (const candidate of chain) {
    if (probeRunner(candidate, workspaceRoot, probeTimeoutMs)) {
      const descriptor = runnerDescriptor(candidate)
      return Object.freeze({
        platform, backend: candidate, enforcement: descriptor.enforcement,
        errors: Object.freeze([]),
        warnings: descriptor.enforcement === 'full'
          ? Object.freeze([])
          : Object.freeze([`${candidate} enforces only part of the promised file effects on this host`]),
        fenceAvailable: true,
      })
    }
    errors.push(`${runnerDescriptor(candidate).program} is unusable: ${REMEDIATION[candidate]}`)
  }
  return Object.freeze({ platform, errors: Object.freeze(errors), warnings: Object.freeze([]), fenceAvailable: true })
}

/**
 * A single sentence explaining why an explicitly requested sandbox cannot run,
 * or `undefined` when it can. Intended to be surfaced once at startup.
 */
export function sandboxUnavailableReason(report: SandboxDependencyReport): string | undefined {
  return report.errors.length === 0 ? undefined : report.errors.join('; ')
}
