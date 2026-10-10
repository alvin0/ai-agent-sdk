import type {
  ConfinedArgv, FsFence, SandboxEnforcement, SandboxPolicy, SandboxProvider,
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
import { findAliasedPaths } from './aliases.ts'
import { sandboxEnv } from './env.ts'
import { hardenedDeniedPaths, nodePathResolver } from './fs/resolver.ts'
import { platformChain, probeRunner, runnerDescriptor, type RunnerId } from './select.ts'

import type { LocalSandboxOptions } from './local-options.ts'

/** Enforcement levels in increasing completeness, for comparing one to another. */
const ENFORCEMENT_RANK: Readonly<Record<SandboxEnforcement, number>> = Object.freeze({
  'fence-only': 0, partial: 1, full: 2,
})

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
  const rootOptions: WritableRootOptions = Object.freeze({
    tempRoots,
    ...(options.hardenDefaults === false ? {} : { deniedPaths: hardenedDeniedPaths() }),
    ...(options.allowAliasedWrites === undefined ? {} : { allowAliasedWrites: options.allowAliasedWrites }),
  })
  const selectRunner = createRunnerSelector(options, platform)

  return Object.freeze({
    id: 'local',

    fence(policy: SandboxPolicy): FsFence {
      return createFsFence(policy, resolver, rootOptions)
    },

    confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
      return confineLocal(argv, policy, { options, platform, rootOptions, selectRunner })
    },
  })
}

function createRunnerSelector(options: LocalSandboxOptions, platform: string) {
  const shouldProbe = options.probe ?? true
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000
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

  return selectRunner
}

function requireEffectiveEnforcement(
  options: LocalSandboxOptions, platform: string, reached: SandboxEnforcement, runner: string,
): void {
  const required = options.requireEnforcement
  if (required !== undefined && ENFORCEMENT_RANK[reached] < ENFORCEMENT_RANK[required]) {
    throw new SandboxUnavailableError(
      platform, [runner],
      `this execution reaches '${reached}' enforcement and the deployment requires '${required}'`,
    )
  }
}

interface LocalContext {
  options: LocalSandboxOptions
  platform: string
  rootOptions: WritableRootOptions
  selectRunner(workspaceRoot: string): RunnerId
}

async function confineLocal(
  argv: readonly string[], policy: SandboxPolicy, context: LocalContext,
): Promise<ConfinedArgv> {
  const { options, platform } = context

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

  const runnerCommand = options.runnerCommand
  if (runnerCommand !== undefined && runnerCommand.length > 0) {
    return confineCustom(argv, policy, context, runnerCommand)
  }
  return confineSelected(argv, policy, context)
}

async function confineCustom(
  argv: readonly string[], policy: SandboxPolicy, context: LocalContext, runnerCommand: readonly string[],
): Promise<ConfinedArgv> {
  const { options, platform, rootOptions } = context
  const scan = await scanAliases(policy, context)
  const enforcement: SandboxEnforcement = scan.complete ? 'full' : 'partial'
  requireEffectiveEnforcement(options, platform, enforcement, 'custom')
  const profile = await bwrapProfileArgs(policy, rootOptions, 'full', scan.aliased)
  return Object.freeze({
    argv: Object.freeze([...runnerCommand, ...profile, '--', ...argv]),
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

async function confineSelected(
  argv: readonly string[], policy: SandboxPolicy, context: LocalContext,
): Promise<ConfinedArgv> {
  const { options, platform, rootOptions } = context
  const runner = context.selectRunner(policy.workspaceRoot)
  const descriptor = runnerDescriptor(runner)
  const scan = await scanAliases(policy, context)
  const profile = runner === 'seatbelt'
    ? await seatbeltProfileArgs(policy, rootOptions, scan.aliased)
    : await bwrapProfileArgs(
      policy, rootOptions, runner === 'bwrap' ? 'full' : 'restricted', scan.aliased)
  // A validated profile cannot later be reported as rejected, so the rule
  // that reads such a report — the one a command can forge — is dropped.
  const validated = isValidatedSeatbelt(runner, profile)
  const effectiveEnforcement = scan.complete ? descriptor.enforcement : 'partial'
  requireEffectiveEnforcement(options, platform, effectiveEnforcement, descriptor.id)
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
}

function scanAliases(policy: SandboxPolicy, context: LocalContext) {
  const { options, rootOptions } = context
  return options.maskAliasedInodes === false || options.allowAliasedWrites === true
    ? Promise.resolve({ aliased: [] as readonly string[], complete: true })
    : findAliasedPaths(writableRoots(policy, rootOptions).roots, options.aliasScanOptions)
}

function isValidatedSeatbelt(runner: RunnerId, profile: readonly string[]): boolean {
  return runner === 'seatbelt' && profile[1] !== undefined
    && seatbeltProfileAccepted(profile[1])
}
