export { localSandbox } from './local.ts'
export type { LocalSandboxOptions } from './local-options.ts'

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
export {
  SEATBELT_RUNNER_FAILURE_RULES, seatbeltNetworkEnforcement, seatbeltProfileAccepted,
} from './backends/seatbelt.ts'
export {
  MINIMUM_SAFE_BWRAP_VERSION, PLATFORM_CHAINS, isSafeBubblewrapVersion,
  platformChain, probeRunner, runnerDescriptor,
} from './select.ts'
export type { RunnerDescriptor, RunnerId } from './select.ts'
export type { BwrapVariant } from './backends/bwrap.ts'
export { WINDOWS_UNAVAILABLE_REASON } from './backends/windows.ts'
