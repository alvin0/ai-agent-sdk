/**
 * Node-elevated sandbox provider.
 *
 * Two enforcement layers, deliberately separate. `confine()` wraps an argv for
 * a kernel backend and exists only where the platform has one. `fence()` guards
 * the file effects a tool performs in-process, works on every platform, and is
 * built from the same writable-root algebra the kernel profiles are — so the
 * two can never drift into disagreeing about what is writable.
 */

import type {
  ConfinedArgv, FsFence, PathResolver, SandboxEnforcement, SandboxPolicy, SandboxProvider,
  WritableRootOptions,
} from '@alvin0/ai-agent-sdk-sandbox'
import { createFsFence, SandboxUnavailableError, writableRoots } from '@alvin0/ai-agent-sdk-sandbox'
import {
  bwrapNetworkEnforcement, bwrapProfileArgs, BWRAP_DENIAL_SIGNATURES, BWRAP_STATUS_FD,
} from './backends/bwrap.ts'
import {
  seatbeltNetworkEnforcement, seatbeltProfileAccepted, seatbeltProfileArgs,
  SEATBELT_VALIDATED_FAILURE_RULES,
} from './backends/seatbelt.ts'
import { WINDOWS_UNAVAILABLE_REASON } from './backends/windows.ts'
import { findAliasedPaths, type AliasScanOptions } from './aliases.ts'
import { sandboxEnv } from './env.ts'
import { hardenedDeniedPaths, nodePathResolver } from './fs/resolver.ts'
import { platformChain, probeRunner, runnerDescriptor, type RunnerId } from './select.ts'

/** Enforcement levels in increasing completeness, for comparing one to another. */
const ENFORCEMENT_RANK: Readonly<Record<SandboxEnforcement, number>> = Object.freeze({
  'fence-only': 0, partial: 1, full: 2,
})

/** Provider configuration; every field has a working default. */
export interface LocalSandboxOptions {
  /** Platform identifier; defaults to the running one. Injectable for tests. */
  readonly platform?: string
  /**
   * Temp roots `workspace-write` grants alongside the workspace. Empty by
   * default: the host temp directory is shared with other processes, so it is
   * an opt-in grant rather than a silent one. A consumer whose commands need
   * `TMPDIR` passes {@link defaultTempRoots}.
   */
  readonly tempRoots?: readonly string[]
  /** Run the functional probe before selecting a rung. Default `true`. */
  readonly probe?: boolean
  /** Timeout for each functional probe. Default 5s. */
  readonly probeTimeoutMs?: number
  /**
   * Operator override: a custom runner argv that accepts bwrap-compatible
   * profile arguments. It skips probing and is trusted to confine honestly, so
   * its own failure dialect must be supplied alongside it.
   */
  readonly runnerCommand?: readonly string[]
  /** Stderr substrings identifying the custom runner's own fatal diagnostics. */
  readonly runnerFailureSignatures?: readonly string[]
  /** Filesystem facts; defaults to the real filesystem. Injectable for tests. */
  readonly resolver?: PathResolver
  /**
   * Hide credential stores and host daemon sockets from every execution.
   * On by default: reading is otherwise unconfined, and connecting to a daemon
   * socket is not a file write, so both pass straight through a write boundary.
   */
  readonly hardenDefaults?: boolean
  /** Permit writes to a file whose inode carries another name. Off by default. */
  readonly allowAliasedWrites?: boolean
  /**
   * Scan the granted roots for hard links and close them in the kernel profile.
   *
   * On by default. A path boundary cannot see that two names share an inode, so
   * without this the fence refuses an aliased write while the profile permits
   * it — the boundary then depends on which layer the caller went through. The
   * cost is a walk of the writable roots per call; a scan that hits its bound
   * reports `partial`, because it cannot prove the absence of an alias.
   */
  readonly maskAliasedInodes?: boolean
  /** Bounds for the hard-link walk; primarily useful for deterministic policy. */
  readonly aliasScanOptions?: AliasScanOptions
  /**
   * Refuse to confine unless the selected rung reaches at least this level.
   *
   * `partial` is a real state, not a caveat: a bubblewrap rung without its own
   * `/proc` lets a command reach outside the mounts through another process's
   * procfs entry. A deployment that cannot accept that says so here and gets
   * `SANDBOX_UNAVAILABLE` instead of a boundary it did not agree to.
   */
  readonly requireEnforcement?: SandboxEnforcement
}

/**
 * Build the local sandbox provider for this host.
 *
 * Rung selection is resolved once and cached for the provider's lifetime, so
 * installing or removing a runner requires a new provider rather than silently
 * changing the boundary mid-session.
 */
export function localSandbox(options: LocalSandboxOptions = {}): SandboxProvider {
  const platform = options.platform ?? process.platform
  const tempRoots = options.tempRoots ?? []
  const resolver = options.resolver ?? nodePathResolver()
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000
  const shouldProbe = options.probe ?? true
  const rootOptions: WritableRootOptions = Object.freeze({
    tempRoots,
    ...(options.hardenDefaults === false ? {} : { deniedPaths: hardenedDeniedPaths() }),
    ...(options.allowAliasedWrites === undefined ? {} : { allowAliasedWrites: options.allowAliasedWrites }),
  })
  let selected: RunnerId | undefined
  let selectionResolved = false

  function requireEffectiveEnforcement(reached: SandboxEnforcement, runner: string): void {
    const required = options.requireEnforcement
    if (required !== undefined && ENFORCEMENT_RANK[reached] < ENFORCEMENT_RANK[required]) {
      throw new SandboxUnavailableError(
        platform, [runner],
        `this execution reaches '${reached}' enforcement and the deployment requires '${required}'`,
      )
    }
  }

  function selectRunner(workspaceRoot: string): RunnerId {
    if (!selectionResolved) {
      const chain = platformChain(platform)
      selected = shouldProbe
        ? chain.find(candidate => probeRunner(candidate, workspaceRoot, probeTimeoutMs))
        : chain[0]
      selectionResolved = true
    }
    if (selected === undefined) {
      const detail = platform === 'win32' ? WINDOWS_UNAVAILABLE_REASON : undefined
      throw new SandboxUnavailableError(platform, platformChain(platform), detail)
    }
    const required = options.requireEnforcement
    if (required !== undefined) {
      const reached = runnerDescriptor(selected).enforcement
      if (ENFORCEMENT_RANK[reached] < ENFORCEMENT_RANK[required]) {
        throw new SandboxUnavailableError(
          platform, [selected],
          `this host reaches '${reached}' enforcement and the deployment requires '${required}'`,
        )
      }
    }
    return selected
  }

  return Object.freeze({
    id: 'local',

    fence(policy: SandboxPolicy): FsFence {
      return createFsFence(policy, resolver, rootOptions)
    },

    async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
      if (argv.length === 0) throw new TypeError('confine requires a non-empty argv')

      // An allow-list baseline is a fence capability, not a kernel one. Both
      // profiles here start from a readable host and close paths one at a
      // time; inverting that means binding only what a program needs, and the
      // set a program needs to start at all — loader, libraries, locale — is
      // specific to an OS build. Shipping a guess would produce a profile that
      // either fails to start or quietly reads more than it claims, so the
      // request is refused instead.
      if ((policy.baseline ?? 'read') === 'deny') {
        throw new SandboxUnavailableError(
          platform, [],
          'a deny-by-default read baseline is enforced by fence(policy), not by the kernel '
          + 'profiles: neither bubblewrap nor Seatbelt is given the system paths a program '
          + 'needs to start, so an allow-list profile cannot be built here',
        )
      }

      if (options.runnerCommand !== undefined && options.runnerCommand.length > 0) {
        const scan = options.maskAliasedInodes === false || options.allowAliasedWrites === true
          ? { aliased: [] as readonly string[], complete: true }
          : await findAliasedPaths(writableRoots(policy, rootOptions).roots, options.aliasScanOptions)
        const enforcement: SandboxEnforcement = scan.complete ? 'full' : 'partial'
        requireEffectiveEnforcement(enforcement, 'custom')
        const profile = await bwrapProfileArgs(policy, rootOptions, 'full', scan.aliased)
        return Object.freeze({
          argv: Object.freeze([...options.runnerCommand, ...profile, '--', ...argv]),
          enforcement, backend: 'custom',
          denialSignatures: BWRAP_DENIAL_SIGNATURES,
          runnerFailureRules: Object.freeze([
            Object.freeze({ fatalSignatures: options.runnerFailureSignatures ?? [] }),
          ]),
          env: sandboxEnv('custom', policy.mode),
          networkEnforcement: bwrapNetworkEnforcement(policy.network ?? 'allow-all'),
          statusFd: BWRAP_STATUS_FD,
        })
      }

      const runner = selectRunner(policy.workspaceRoot)
      const descriptor = runnerDescriptor(runner)
      const scan = options.maskAliasedInodes === false || options.allowAliasedWrites === true
        ? { aliased: [] as readonly string[], complete: true }
        : await findAliasedPaths(writableRoots(policy, rootOptions).roots, options.aliasScanOptions)
      const profile = runner === 'seatbelt'
        ? await seatbeltProfileArgs(policy, rootOptions, scan.aliased)
        : await bwrapProfileArgs(
          policy, rootOptions, runner === 'bwrap' ? 'full' : 'restricted', scan.aliased)
      // A validated profile cannot later be reported as rejected, so the rule
      // that reads such a report — the one a command can forge — is dropped.
      const validated = runner === 'seatbelt' && profile[1] !== undefined
        && seatbeltProfileAccepted(profile[1])
      const effectiveEnforcement = scan.complete ? descriptor.enforcement : 'partial'
      requireEffectiveEnforcement(effectiveEnforcement, descriptor.id)
      return Object.freeze({
        argv: Object.freeze([descriptor.program, ...profile, ...descriptor.separator, ...argv]),
        // A scan that stopped at its bound leaves an alias possible, so the
        // enforcement claim is lowered rather than the scan's limit hidden.
        enforcement: effectiveEnforcement,
        backend: descriptor.id,
        denialSignatures: descriptor.denialSignatures,
        runnerFailureRules: validated
          ? SEATBELT_VALIDATED_FAILURE_RULES
          : descriptor.runnerFailureRules,
        env: sandboxEnv(descriptor.id, policy.mode),
        networkEnforcement: runner === 'seatbelt'
          ? seatbeltNetworkEnforcement(policy.network ?? 'allow-all')
          : bwrapNetworkEnforcement(policy.network ?? 'allow-all'),
        ...(runner === 'seatbelt' ? {} : { statusFd: BWRAP_STATUS_FD }),
      })
    },
  })
}

export { checkSandboxDependencies, sandboxUnavailableReason } from './doctor.ts'
export type { SandboxDependencyReport } from './doctor.ts'
export {
  BASELINE_ENV_NAMES, confinedEnv, insideSandbox, isSecretEnvName,
  SANDBOX_ENV_VAR, SANDBOX_MODE_ENV_VAR, sandboxEnv,
} from './env.ts'
export type { ConfinedEnvOptions } from './env.ts'
export { findAliasedPaths } from './aliases.ts'
export type { AliasScan, AliasScanOptions } from './aliases.ts'
export { descendantsOf, terminateConfined } from './terminate.ts'
export { parseCpuTime, resourceEnforcement, sampleTree, superviseConfined } from './supervise.ts'
export type { Supervision, SuperviseOptions, SupervisionResult } from './supervise.ts'
export type { TerminateOptions, TerminateResult } from './terminate.ts'
export { defaultTempRoots, hardenedDeniedPaths, nodePathResolver } from './fs/resolver.ts'
export { openConfinedWrite, writeConfinedFile } from './open.ts'
export type { ConfinedOpenOptions } from './open.ts'
export { sandboxChildStarted, sandboxSpawnOptions } from './spawn.ts'
export type { SandboxSpawnInput, SandboxSpawnOptions } from './spawn.ts'
export { bwrapNetworkEnforcement, BWRAP_STATUS_FD } from './backends/bwrap.ts'
export { SEATBELT_RUNNER_FAILURE_RULES, seatbeltNetworkEnforcement, seatbeltProfileAccepted } from './backends/seatbelt.ts'
export {
  MINIMUM_SAFE_BWRAP_VERSION, PLATFORM_CHAINS, isSafeBubblewrapVersion,
  platformChain, probeRunner, runnerDescriptor,
} from './select.ts'
export type { RunnerDescriptor, RunnerId } from './select.ts'
export type { BwrapVariant } from './backends/bwrap.ts'
export { WINDOWS_UNAVAILABLE_REASON } from './backends/windows.ts'
