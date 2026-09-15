/**
 * Universal sandbox contract: the file-effect vocabulary, per-call policy
 * resolution, the writable-root algebra both enforcement layers share, and the
 * classification rules that keep a broken sandbox from reading as a denied
 * command. It holds no platform code and imports nothing.
 */

export {
  approveSandboxEscalation, isSandboxApproval, isSandboxApprovalSpent, requireSandboxApproval,
} from './approval.ts'
export type {
  SandboxApproval, SandboxApprovalGrant, SandboxApprovalScope,
} from './approval.ts'
export { classifyExec, DEFAULT_EXEC_OUTCOMES, splitCommands } from './exec.ts'
export type { ExecCapability, ExecClassification, ExecOutcome } from './exec.ts'
export { accessFor, entriesWithin, orderEntries } from './entries.ts'
export type { FileSystemAccess, FileSystemEntry } from './entries.ts'
export { SandboxDeniedError, SandboxPolicyError, SandboxUnavailableError } from './errors.ts'
export { createFsFence } from './fence.ts'
export { isConfinedMode, isSandboxMode, modeAuthority, SANDBOX_MODES } from './mode.ts'
export { isNetworkMode, narrowNetwork, networkAuthority, NETWORK_MODES } from './network.ts'
export type { NetworkEnforcement, NetworkMode } from './network.ts'
export type { ConfinedSandboxMode, SandboxEnforcement, SandboxMode } from './mode.ts'
export {
  ancestorPaths, containsPath, dedupeRoots, detectFlavor, isAbsolutePath,
  joinPath, normalizePath, parentPath, pathDepth, pathSegments, samePath,
} from './path.ts'
export type { PathFlavor } from './path.ts'
export { annotateStderr, classifyOutcome } from './classify.ts'
export type {
  CommandOutcome, RunnerFailureRule, SandboxClassification,
  SandboxClassificationInput, SandboxOutcomeKind,
} from './classify.ts'
export { confiningPolicy, narrowPolicy, resolveSandboxPolicy } from './policy.ts'
export type {
  SandboxExecutionPolicy, SandboxPolicy, SandboxPolicyDefaults, SandboxPolicyRequest,
} from './policy.ts'
export type { ConfinedArgv, FsFence, PathResolver, SandboxProvider } from './provider.ts'
export {
  accessInLayers, BASELINE_ACCESS, grantLayers, PROTECTED_SUBPATHS, unreadablePaths, writableRoots,
} from './roots.ts'
export type { GrantLayer, GrantOrigin, WritableRootOptions, WritableRootSet } from './roots.ts'
export { breachedLimit, hasResourceLimits } from './resources.ts'
export type {
  ResourceBreach, ResourceEnforcement, ResourceLimits, ResourceUsage,
} from './resources.ts'
export { sandboxViolation } from './violation.ts'
export type { SandboxViolation, SandboxViolationBackend, SandboxViolationReason } from './violation.ts'
