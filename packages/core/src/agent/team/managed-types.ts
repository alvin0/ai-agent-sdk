import type { ModelRegistry } from '../../runtime/index.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { DefinedAgent } from '../define/definition.ts'
import type { AgentSession, AgentSessionOptions } from '../define/session.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import type { ToolCatalog } from '../tool/registry.ts'
import type { AgentTeam } from './team.ts'
import type { AgentTeamOptions } from './types.ts'

type DetachedSessionOptions = Omit<AgentSessionOptions, 'registry' | 'team' | 'tools'>

/** `fresh` starts from the task; `fork` copies the lead's completed conversation. */
export type ManagedAgentSpawnContext = 'fresh' | 'fork'

/** Optional host-defined worker roles; the SDK supplies no domain-specific roles. */
export interface ManagedAgentRole {
  /** Referred to by `spawn_agent`; the enum the lead chooses from. */
  readonly name: string
  /** What this role is for. Shown to the lead in the spawn tool schema. */
  readonly description: string
  /** When choosing it is correct — and when it is premature. */
  readonly whenToUse?: string
  /** Added to the worker's own instructions; defaults to `description`. */
  readonly instructions?: string
}

/** What to do about two workers that would write the same files at once. */
export type WriteScopeConflictPolicy = 'reject' | 'warn' | 'off'

export interface ManagedAgentSpawnRequest {
  /** Optional stable team address; generated as worker_N when omitted. */
  readonly name?: string
  readonly task: string
  /** Short specialization added to the generated worker's instructions. */
  readonly specialty?: string
  /**
   * Context the worker starts from; defaults to
   * {@link ManagedAgentTeamOptions.defaultSpawnContext}.
   */
  readonly context?: ManagedAgentSpawnContext
  /** One of {@link ManagedAgentTeamOptions.roles}, when the host declared any. */
  readonly role?: string
  /** Registered producers that must settle before dispatch; failures also release dependents. */
  readonly dependsOn?: readonly string[]
  /** Workspace-relative scheduling declarations, not filesystem authorization. */
  readonly writes?: readonly string[]
}

export interface ResolvedManagedAgentSpawnRequest extends ManagedAgentSpawnRequest {
  readonly name: string
  readonly context: ManagedAgentSpawnContext
  readonly dependsOn: readonly string[]
  readonly writes: readonly string[]
}

export interface ManagedAgentWorkerResult {
  readonly worker: string
  readonly agentId: string
  readonly conversationId: string
  readonly text: string
  readonly succeeded: boolean
}

/**
 * Where a generated worker is in its life.
 *
 * `completed` and `failed` are final but NOT gone: a finished worker stays
 * addressable and keeps occupying a `maxWorkers` slot until it is closed, so
 * a lead that spawns without closing runs out of workers rather than silently
 * accumulating them.
 */
export type ManagedAgentWorkerStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'closed'

export interface ManagedAgentWorker {
  readonly name: string
  readonly agentId: string
  readonly conversationId: string
  readonly task: string
  readonly specialty?: string
  /** Context this worker was started from. */
  readonly context: ManagedAgentSpawnContext
  readonly role?: string
  /** Workers that had to settle before this one could start. */
  readonly dependsOn: readonly string[]
  /** Files this worker declared it would write. */
  readonly writes: readonly string[]
  readonly status: ManagedAgentWorkerStatus
  /** Non-fatal problems with the division of work, e.g. an accepted overlap. */
  readonly warnings?: readonly string[]
  readonly result?: ManagedAgentWorkerResult
  readonly error?: string
}

export interface ManagedAgentTeamOptions {
  readonly registry: ModelRegistry
  readonly lead: DefinedAgent
  readonly leadName?: string
  readonly leadDescription?: string
  readonly team?: AgentTeam | AgentTeamOptions
  readonly maxWorkers?: number
  /**
   * Automatically hold/continue the lead for pending work and wake it for reports.
   * Defaults to true for this convenience helper. Set false for host-driven turns;
   * reports remain delivered quietly and all lifecycle APIs stay available.
   */
  readonly autoLeadCoordination?: boolean
  /** Team tools exposed to workers; defaults to reporting. Full also enables peer coordination. */
  readonly workerTeamTools?: false | 'reporting' | 'full'
  /** Treat a clean completion with empty text as failure. Defaults to false (tool-only work is valid). */
  readonly requireWorkerText?: boolean
  /** Maximum UTF-8 worker task bytes. Defaults to 64 KiB. */
  readonly maxTaskBytes?: number
  /** Maximum UTF-8 specialty bytes. Defaults to 8 KiB. */
  readonly maxSpecialtyBytes?: number
  /**
   * Context a `spawn_agent` call starts a worker from when it does not say.
   * Defaults to `'fresh'`.
   *
   * `'fresh'` is the default because forking is not free: the worker pays for
   * the lead's whole conversation in input tokens on every round it runs, and
   * a worker whose task genuinely stands alone gains nothing for it. A host
   * that knows its workers always operate on the lead's workspace — and so
   * would otherwise watch each of them rediscover it — should set `'fork'`
   * here rather than hope the lead remembers to ask.
   */
  readonly defaultSpawnContext?: ManagedAgentSpawnContext
  /**
   * Worker kinds the lead may choose from, with what each is for.
   *
   * Declaring them replaces free-text `specialty` with an enum, and puts each
   * role's `whenToUse` in the spawn schema — the one place the lead is certain
   * to read before choosing. Leave it unset and `specialty` behaves as before.
   */
  readonly roles?: readonly ManagedAgentRole[]
  /**
   * What to do when a spawn declares `writes` overlapping a worker that would
   * run at the same time. Defaults to `'reject'`.
   *
   * Rejecting is the default because the alternative is silent data loss: both
   * workers write the file and the later write wins. The refusal names the
   * conflicting worker and the overlap, so the lead's available fix — add it
   * to `dependsOn`, or narrow the scope — is visible in the error itself.
   * `'warn'` records it on the worker instead and lets it run; `'off'` skips
   * the check.
   */
  readonly writeScopePolicy?: WriteScopeConflictPolicy
  /**
   * Cap on how much of a dependency's result is handed to its dependents.
   * Defaults to 8 KiB per dependency; at least 4 bytes. Full results remain readable by scoped tool.
   */
  readonly maxDependencyReportBytes?: number
  /** Active run deadline, excluding queued dependencies and setup. Defaults to 10 minutes. */
  readonly workerTimeoutMs?: number
  /** Maximum wait per worker event observer callback. Defaults to 1 second. */
  readonly observerTimeoutMs?: number
  /**
   * How long closing one worker waits for it to stop.
   * Defaults to {@link DEFAULT_WORKER_CLOSE_TIMEOUT_MS}.
   *
   * After that its slot is freed regardless. A worker that ignores its
   * cancellation must not be able to hold the harness at its cap forever.
   */
  readonly closeTimeoutMs?: number
  /**
   * How long the lead's turn is held open waiting for a worker to report,
   * before the lead is asked again. Defaults to {@link DEFAULT_HOLD_WAIT_MS}.
   *
   * Zero-length would be a spin: the lead answers, is told its workers are
   * still running, answers again, and burns its budget before any result
   * arrives. Codex blocks the parent inside its `wait_agent` tool for the same
   * reason.
   */
  readonly holdWaitMs?: number
  /** Allow model-invoked close_agent to cancel unfinished work (default true).
   * Host closeWorker, disposal and user cancellation are always available. */
  readonly allowModelWorkerCancellation?: boolean
  /**
   * How long `spawn_agent` may take to get a worker running.
   * Defaults to {@link DEFAULT_SPAWN_SETUP_TIMEOUT_MS}.
   *
   * Only the setup: the worker's own deadline is `workerTimeoutMs`, and how
   * long the lead may WAIT for it is the team's `waitTimeoutMs` — pass it
   * through `team: { waitTimeoutMs }` when building the harness.
   */
  readonly spawnTimeoutMs?: number
  /** Defaults to cloning the lead definition under the generated worker id. */
  readonly workerTemplate?: DefinedAgent
  readonly workerFactory?: (
    request: ResolvedManagedAgentSpawnRequest,
  ) => DefinedAgent | Promise<DefinedAgent>
  readonly leadSessionOptions?: DetachedSessionOptions & {
    readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }
  readonly workerSessionOptions?: DetachedSessionOptions & {
    readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }
  /** Per-worker runtime dependencies for least-privilege tools and workspace policy. */
  readonly workerSessionOptionsFactory?: (
    request: ResolvedManagedAgentSpawnRequest,
  ) => (DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] })
    | Promise<DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }>
  /** Observe every generated worker's model, tool, trace, and compaction events. */
  readonly onWorkerEvent?: (
    worker: string,
    event: AgentRunEvent,
  ) => void | Promise<void>
}

export interface WorkerRuntime {
  readonly request: ResolvedManagedAgentSpawnRequest
  readonly session: AgentSession
  /** Exact commissioned workers, independent of address reuse or roster removal. */
  dependencies: readonly WorkerRuntime[]
  starting: boolean
  settledComplete: boolean
  closeTask: Promise<ManagedAgentWorkerStatus> | undefined
  status: ManagedAgentWorkerStatus
  /**
   * Whether the lead's own turn created this worker.
   *
   * It decides who is owed the completion report. A worker the MODEL spawned
   * belongs to a conversation that is waiting for a synthesis, so its report
   * wakes an idle lead. A worker the HOST spawned belongs to the host, which is
   * driving the lead itself; waking it there would start a turn the caller did
   * not ask for.
   */
  readonly leadDriven: boolean
  /**
   * Cancels this worker's run.
   *
   * Owned here rather than by the team: `AgentTeam.cancel` only aborts a
   * team-scheduled wake, not a run a host started itself, so without this a
   * detached worker would survive both `close_agent` and `dispose`.
   */
  readonly controller: AbortController
  /**
   * Set the moment a close begins, before anything is aborted.
   *
   * `status` cannot carry this: it only becomes `'closed'` after the run has
   * settled, so the abort's own rejection arrives while the worker still looks
   * like a running one — and gets reported to the lead as a FAILURE it did not
   * cause and cannot act on.
   */
  closing: boolean
  /**
   * This worker's own deadline, so a run that ended can say WHY.
   *
   * An expired deadline surfaces as an ordinary abort — indistinguishable from
   * a close, or from a cancelled parent — unless the signal that expired is
   * kept and asked. Codex reports a status the parent can branch on; this is
   * what makes one reportable here.
   */
  deadline: AbortSignal | undefined
  /** Resolves when the run has ended and been recorded. Never rejects. */
  settled: Promise<void>
  /**
   * Releases a worker held back by `dependsOn`; undefined once it has started.
   *
   * The team holds the matching promise, so `wait_agents` and `list_agents`
   * report a held worker as `pending` rather than as one that has finished.
   */
  start: (() => void) | undefined
  /** Resolves {@link settled}; called exactly once, whatever ended the worker. */
  readonly markSettled: () => void
  warnings: readonly string[]
  result: ManagedAgentWorkerResult | undefined
  error: string | undefined
  readonly evidence: { status: ManagedAgentWorkerStatus;
    result: ManagedAgentWorkerResult | undefined; error: string | undefined }
}

