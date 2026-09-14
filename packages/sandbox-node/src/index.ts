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
  ConfinedArgv, FsFence, PathResolver, SandboxPolicy, SandboxProvider,
} from '@alvin0/ai-agent-sdk-sandbox'
import { createFsFence, SandboxUnavailableError } from '@alvin0/ai-agent-sdk-sandbox'
import { bwrapProfileArgs, BWRAP_DENIAL_SIGNATURES } from './backends/bwrap.ts'
import { seatbeltProfileArgs } from './backends/seatbelt.ts'
import { WINDOWS_UNAVAILABLE_REASON } from './backends/windows.ts'
import { sandboxEnv } from './env.ts'
import { nodePathResolver } from './fs/resolver.ts'
import { platformChain, probeRunner, runnerDescriptor, type RunnerId } from './select.ts'

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
  let selected: RunnerId | undefined
  let selectionResolved = false

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
    return selected
  }

  return Object.freeze({
    id: 'local',

    fence(policy: SandboxPolicy): FsFence {
      return createFsFence(policy, resolver, { tempRoots })
    },

    async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
      if (argv.length === 0) throw new TypeError('confine requires a non-empty argv')

      if (options.runnerCommand !== undefined && options.runnerCommand.length > 0) {
        const profile = await bwrapProfileArgs(policy, tempRoots)
        return Object.freeze({
          argv: Object.freeze([...options.runnerCommand, ...profile, '--', ...argv]),
          enforcement: 'full', backend: 'custom',
          denialSignatures: BWRAP_DENIAL_SIGNATURES,
          runnerFailureRules: Object.freeze([
            Object.freeze({ fatalSignatures: options.runnerFailureSignatures ?? [] }),
          ]),
          env: sandboxEnv('custom', policy.mode),
        })
      }

      const runner = selectRunner(policy.workspaceRoot)
      const descriptor = runnerDescriptor(runner)
      const profile = runner === 'seatbelt'
        ? await seatbeltProfileArgs(policy, tempRoots)
        : await bwrapProfileArgs(policy, tempRoots, runner === 'bwrap' ? 'full' : 'restricted')
      return Object.freeze({
        argv: Object.freeze([descriptor.program, ...profile, ...descriptor.separator, ...argv]),
        enforcement: descriptor.enforcement,
        backend: descriptor.id,
        denialSignatures: descriptor.denialSignatures,
        runnerFailureRules: descriptor.runnerFailureRules,
        env: sandboxEnv(descriptor.id, policy.mode),
      })
    },
  })
}

export { checkSandboxDependencies, sandboxUnavailableReason } from './doctor.ts'
export type { SandboxDependencyReport } from './doctor.ts'
export { insideSandbox, SANDBOX_ENV_VAR, SANDBOX_MODE_ENV_VAR, sandboxEnv } from './env.ts'
export { defaultTempRoots, nodePathResolver } from './fs/resolver.ts'
export { PLATFORM_CHAINS, platformChain, probeRunner, runnerDescriptor } from './select.ts'
export type { RunnerDescriptor, RunnerId } from './select.ts'
export type { BwrapVariant } from './backends/bwrap.ts'
export { WINDOWS_UNAVAILABLE_REASON } from './backends/windows.ts'
