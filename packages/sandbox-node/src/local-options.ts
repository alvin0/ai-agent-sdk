import type { PathResolver, SandboxEnforcement,
} from '@alvin0/ai-agent-sdk-sandbox'
import { type AliasScanOptions } from './aliases.ts'

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

