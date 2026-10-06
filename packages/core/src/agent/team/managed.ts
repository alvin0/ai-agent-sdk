/** Codex-style dynamic worker creation and delegation over AgentTeam. */

import type { JsonValue } from '../../primitives/index.ts'
import { timeoutValue } from '../../platform/config.ts'
import { createTextMessage, createUserMessage } from '../../message/index.ts'
import type { ModelRegistry } from '../../runtime/index.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import { cloneAgent, type DefinedAgent } from '../define/definition.ts'
import {
  type AgentInput,
  type AgentInvocationOptions,
  type AgentResponse,
  type AgentSession,
  type AgentSessionOptions,
} from '../define/session.ts'
import { History, type HistoryEntry, type HistorySnapshot } from '../history/index.ts'
import { managedTeamNoticeRequest } from '../history/input-work.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import { ToolRegistry, type ToolCatalog } from '../tool/registry.ts'
import { AgentTeam } from './team.ts'
import { DEFAULT_WAIT_TIMEOUT_MS } from './common.ts'
import type { AgentTeamOptions } from './types.ts'
import type { TurnHooks } from '../loop/events.ts'
import { waitForSettlement } from '../../async/index.ts'
type DetachedSessionOptions = Omit<AgentSessionOptions, 'registry' | 'team' | 'tools'>

/**
 * Default bound on getting one worker RUNNING, overridable per harness with
 * {@link ManagedAgentTeamOptions.spawnTimeoutMs}.
 *
 * Not the worker's deadline — that is `workerTimeoutMs`. This bounds only the
 * setup, so a lead cannot be held for minutes by a call that no longer waits
 * for any work.
 */
export const DEFAULT_SPAWN_SETUP_TIMEOUT_MS = 30_000

/** Default bound on stopping one worker; see {@link ManagedAgentTeamOptions.closeTimeoutMs}. */
export const DEFAULT_WORKER_CLOSE_TIMEOUT_MS = 30_000

/**
 * Default bound on holding the lead's turn open for news from a worker; see
 * {@link ManagedAgentTeamOptions.holdWaitMs}.
 *
 * Long enough that a lead is not re-prompted about work that has visibly just
 * started, short enough that it keeps control of its own run: at the deadline
 * the turn comes back and the lead decides whether to wait again, close a
 * worker, or answer with what it has.
 */
export const DEFAULT_HOLD_WAIT_MS = 15_000

/** Protocol facts only; task strategy and output contracts belong to the host. */
const LEAD_INSTRUCTIONS = [
  'You have access to a managed team. Your task and coordination strategy are defined by the host instructions.',
  'Return only the caller-requested result in the caller’s format; include explanation only when requested.',
  'spawn_agent returns a worker lifecycle view, not its final result. list_agents exposes status and retained results; wait_agents waits within its timeout.',
  'dependsOn references already registered producer instances. Pending dependents start after those producers settle and receive their results or failure status, even if a producer address is later closed or reused.',
  'fresh starts from the assigned task; fork also copies the completed lead conversation.',
  'writes declares relative scheduling scopes under the host conflict policy; it does not grant filesystem permissions. Omit it when no write scope is needed.',
  'send_message is an update, not terminal completion. completed and failed are terminal worker states; pending and running are not.',
  'Finished workers occupy slots until close_agent. Closing unfinished work requires cancelRunning: true and host authorization.',
].join(' ')

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
  readonly leadSessionOptions?: DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }
  readonly workerSessionOptions?: DetachedSessionOptions & { readonly tools?: ToolCatalog | readonly ToolDefinition<any>[] }
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

interface WorkerRuntime {
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
  readonly evidence: { status: ManagedAgentWorkerStatus; result: ManagedAgentWorkerResult | undefined; error: string | undefined }
}

/**
 * A dynamic harness whose lead can create specialized workers with spawn_agent.
 *
 * Spawning starts independent work without blocking the lead. Dependencies refer
 * to the commissioned producer instance; closing its address cannot rebind them.
 */
export class ManagedAgentTeam {
  readonly team: AgentTeam
  readonly lead: AgentSession
  readonly leadName: string
  private readonly options: ManagedAgentTeamOptions
  private readonly maxWorkers: number
  private readonly maxTaskBytes: number
  private readonly maxSpecialtyBytes: number
  private readonly workerTimeoutMs: number
  private readonly observerTimeoutMs: number
  private readonly closeTimeoutMs: number
  private readonly holdWaitMs: number
  private readonly spawnTimeoutMs: number
  private readonly workerRuntimes = new Map<string, WorkerRuntime>()
  /** Closed roster entries may still own an in-flight follow-up after a bounded close. */
  private readonly drainingWrites = new Set<WorkerRuntime>()
  private readonly preparing = new Map<string, {
    readonly request: ResolvedManagedAgentSpawnRequest
    readonly dependencies: readonly WorkerRuntime[]
    readonly settled: Promise<void>
  }>()
  private readonly lifecycle = new AbortController()
  private disposeTask: Promise<void> | undefined
  private workerSequence = 0
  private readonly maxDependencyReportBytes: number
  private readonly roles: Map<string, ManagedAgentRole>

  constructor(options: ManagedAgentTeamOptions) {
    this.options = options
    this.maxWorkers = positiveInteger(options.maxWorkers ?? 7, 'maxWorkers')
    this.maxTaskBytes = positiveInteger(options.maxTaskBytes ?? 64 * 1024, 'maxTaskBytes')
    this.maxSpecialtyBytes = positiveInteger(options.maxSpecialtyBytes ?? 8 * 1024, 'maxSpecialtyBytes')
    this.workerTimeoutMs = timeoutValue(options.workerTimeoutMs ?? 10 * 60_000)
    this.observerTimeoutMs = timeoutValue(options.observerTimeoutMs ?? 1_000)
    this.closeTimeoutMs = timeoutValue(options.closeTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS)
    this.holdWaitMs = timeoutValue(options.holdWaitMs ?? DEFAULT_HOLD_WAIT_MS)
    this.spawnTimeoutMs = timeoutValue(options.spawnTimeoutMs ?? DEFAULT_SPAWN_SETUP_TIMEOUT_MS)
    this.maxDependencyReportBytes = positiveInteger(
      options.maxDependencyReportBytes ?? 8 * 1024,
      'maxDependencyReportBytes',
    )
    if (this.maxDependencyReportBytes < 4) throw new TypeError('maxDependencyReportBytes must be at least 4')
    this.roles = new Map((options.roles ?? []).map(role => [role.name, role]))
    if (this.roles.size !== (options.roles ?? []).length) {
      throw new Error('managed agent roles contain a duplicate name')
    }
    this.team = options.team instanceof AgentTeam
      ? options.team
      : new AgentTeam({
          ...options.team,
          maxMembers: options.team?.maxMembers ?? this.maxWorkers + 1,
        })
    this.leadName = memberName(options.leadName ?? options.lead.id)
    this.lead = options.lead.createSession({
      ...options.leadSessionOptions,
      // A lead's forced answer must not be confirmed in a tool-less window
      // while its workers may still report: their results could only arrive
      // after a synthesis already declared complete. Hosts can opt back in.
      runtimeLimits: { ...options.leadSessionOptions?.runtimeLimits,
        finalizeSteps: options.leadSessionOptions?.runtimeLimits?.finalizeSteps ?? 0 },
      hooks: this.leadHooks(options.leadSessionOptions?.hooks),
      registry: options.registry,
      tools: mergeTools(options.leadSessionOptions?.tools, this.controlTools()),
      team: {
        team: this.team,
        name: this.leadName,
        role: 'lead',
        instructions: LEAD_INSTRUCTIONS,
        ...(options.leadDescription === undefined ? {} : { description: options.leadDescription }),
      },
    })
  }

  /**
   * Hold the lead's turn open while a worker of its is unfinished.
   *
   * This is Codex's shape, arrived at from the other side: there the parent
   * stays inside its turn and loops on its wait tool until it has what it
   * needs. A lead that concludes while its workers are still running answers
   * from nothing — and once the turn is over, the reports that arrive
   * afterwards have no turn left to be read in, so the work stops with no
   * synthesis at all.
   *
   * `runTurn` re-runs a turn whose `onTurnEnd` hook appended history, so
   * saying so is enough to send the lead round again. Its own step and turn
   * budgets bound this, and `canContinue` leaves an aborted or exhausted turn
   * free to end.
   * @param host - Hooks the host supplied; theirs run first and are kept.
   * @returns The hooks to give the lead's session.
   */
  private leadHooks(host: TurnHooks | undefined): TurnHooks {
    return {
      ...host,
      beforeStep: async (context) => {
        // The request for this round is rebuilt from history, so anything
        // delivered quietly before now is about to be read.
        this.unreadReports = false
        this.leadSteer = new AbortController()
        this.leadSignal = context.signal
        return await host?.beforeStep?.(context) ?? { kind: 'proceed' as const }
      },
      onTurnEnd: async (context) => {
        await host?.onTurnEnd?.(context)
        if (this.options.autoLeadCoordination === false) return
        if (!context.canContinue) {
          // The turn is over and cannot be extended — a spent step budget, an
          // error, a stop. A report that arrived during it has no round left to
          // be read in, and the run would end with the synthesis unwritten, so
          // one more turn is scheduled for when the lead goes idle.
          if (this.unreadReports) {
            this.unreadReports = false
            try { this.team.wake(this.leadName) } catch { /* team disposed */ }
          }
          return
        }
        // Pending counts as busy. A worker held behind `dependsOn` has not
        // started, but it WILL run and report, and a lead that concluded while
        // its dependency chain was still queued answers from work that never
        // reached it.
        const outstanding = [...this.workerRuntimes.values()]
          .filter(runtime => runtime.status === 'running' || runtime.status === 'pending')
        if (outstanding.length === 0) return
        // WAIT for news before spending another model call.
        //
        // Re-prompting immediately is a spin: measured on a real run, a lead
        // with slow researchers answered "still waiting" twelve times in half a
        // second and had no budget left when the results finally arrived. Codex
        // has the parent block inside `wait_agent` until a mailbox update
        // arrives or a deadline passes; the DeepSeek harness starts the next
        // round only when there is something to start it for. This is the same
        // shape from inside the hook: the turn stays open, costing nothing,
        // until a worker reports or the wait expires.
        await this.awaitWorkerNews(outstanding)
        const busy = [...this.workerRuntimes.values()]
          .filter(runtime => runtime.status === 'running' || runtime.status === 'pending')
          .map(runtime => runtime.request.name)
        if (busy.length === 0) {
          this.lead.inject(createUserMessage({
            source: { kind: 'app', producer: 'managed-team' },
            content: [{ type: 'text', text: 'All outstanding managed workers have settled. Their statuses and retained results are available through list_agents.' }],
          }))
          return
        }
        this.lead.inject(createUserMessage({
          source: { kind: 'app', producer: 'managed-team' },
          content: [{ type: 'text', text: `Outstanding managed workers: ${busy.join(', ')}. `
            + 'Their current lifecycle status is available through list_agents; wait_agents is bounded by its timeout.' }],
        }))
      },
    }
  }

  /** Run the lead. It decides whether and how many workers to create. */
  run(input: AgentInput, invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    this.lifecycle.signal.throwIfAborted()
    return this.lead.run(input, invocation)
  }

  /**
   * Add a message to the lead's context, and make sure something reads it.
   *
   * Injection alone is enough only while the lead is mid-turn: its next model
   * round rebuilds the request from history and picks the message up. Once the
   * lead has answered and is only waiting on its workers, an injected message
   * sits in history with nothing scheduled to read it — which is what happened
   * to a user who typed a correction while the researchers were still running
   * and never got an answer to it. Idle, the lead is scheduled one turn.
   * @param text - What the user said.
   * @returns True; the message is always accepted.
   */
  steer(text: string): boolean {
    this.lifecycle.signal.throwIfAborted()
    this.lead.inject(text)
    this.leadSteer.abort()
    // Ends a wait the lead is parked in, so the correction is read now rather
    // than after its wait budget expires.
    try { this.team.notifySteer(this.leadName) } catch { /* team disposed */ }
    if (!this.lead.isRunning) {
      try { this.team.wake(this.leadName) } catch { /* team disposed */ }
    }
    return true
  }

  /** Host-side equivalent of the model's spawn_agent tool. */
  /**
   * Create a worker and start it, WITHOUT waiting for it.
   *
   * Returns as soon as the worker is running. Use {@link awaitWorker} for its
   * result, {@link workers} for its status, or let the worker's completion
   * notification reach the lead on its own.
   * @param request - Task, and optionally a name and a specialty.
   * @param signal - Cancels the setup, not the worker's run.
   * @returns The worker, in its `running` state.
   */
  async spawn(
    request: ManagedAgentSpawnRequest,
    signal?: AbortSignal,
  ): Promise<ManagedAgentWorker> {
    this.lifecycle.signal.throwIfAborted()
    signal?.throwIfAborted()
    const resolved: ResolvedManagedAgentSpawnRequest = {
      name: memberName(request.name ?? this.nextWorkerName()),
      task: boundedString(request.task, 'worker task', this.maxTaskBytes),
      ...(request.specialty === undefined
        ? {}
        : { specialty: boundedString(request.specialty, 'worker specialty', this.maxSpecialtyBytes) }),
      context: spawnContext(request.context ?? this.options.defaultSpawnContext ?? 'fresh'),
      ...(request.role === undefined ? {} : { role: this.requireRole(request.role) }),
      dependsOn: this.resolveDependencies(request.dependsOn ?? []),
      writes: [...new Set((request.writes ?? []).map(normalizeWriteScope))],
    }
    Object.freeze(resolved.dependsOn)
    Object.freeze(resolved.writes)
    Object.freeze(resolved)
    const dependencies = resolved.dependsOn.map(name => this.workerRuntimes.get(name)!)
    if (this.workerRuntimes.size + this.preparing.size >= this.maxWorkers) {
      throw new Error(`managed agent team reached its ${this.maxWorkers}-worker limit`)
    }
    if (this.preparing.has(resolved.name) || this.workerRuntimes.has(resolved.name)
      || this.team.members().some(member => member.name === resolved.name)) {
      throw new Error(`managed worker '${resolved.name}' already exists`)
    }

    let markPrepared!: () => void
    const prepared = new Promise<void>(resolve => { markPrepared = resolve })
    this.preparing.set(resolved.name, { request: resolved, dependencies, settled: prepared })
    let runtime: WorkerRuntime | undefined
    try {
      const warnings = this.checkWriteScopes(resolved, dependencies)
      const operationSignal = combineSignals(signal, this.lifecycle.signal, AbortSignal.timeout(this.spawnTimeoutMs))
      const definition = await abortable(this.workerDefinition(resolved), operationSignal)
      operationSignal.throwIfAborted()
      const scopedSessionOptions = this.options.workerSessionOptionsFactory === undefined
        ? undefined
        : await abortable(Promise.resolve(this.options.workerSessionOptionsFactory(resolved)), operationSignal)
      operationSignal.throwIfAborted()
      const sessionOptions = { ...this.options.workerSessionOptions, ...scopedSessionOptions }
      const workerTeamTools = this.options.workerTeamTools ?? 'reporting'
      const session = definition.createSession({
        ...sessionOptions,
        ...(dependencies.length === 0 ? {} : { tools: mergeTools(sessionOptions.tools, [this.dependencyReadTool(dependencies)]) }),
        ...(resolved.context === 'fork' ? { history: this.forkLeadHistory(sessionOptions.historyLimits) } : {}),
        registry: this.options.registry,
        team: {
          team: this.team,
          name: resolved.name,
          role: 'peer',
          tools: workerTeamTools,
          instructions: [
            `You are managed worker '${resolved.name}'; lead: '${this.leadName}'.`,
            'Return only the caller-requested result in the caller’s format; include explanation only when requested.',
            'Your terminal result is delivered automatically.',
            ...(workerTeamTools === false ? [] : ['send_message is context, not a substitute result; it cannot target yourself.']),
          ].join(' '),
          ...(resolved.specialty === undefined ? {} : { description: resolved.specialty }),
        },
      })
      const controller = new AbortController()
      let markSettled!: () => void
      runtime = {
        request: resolved,
        session,
        dependencies,
        starting: false,
        settledComplete: false,
        closeTask: undefined,
        status: 'pending',
        leadDriven: this.lead.isRunning,
        closing: false,
        deadline: undefined,
        controller,
        settled: new Promise<void>((resolve) => { markSettled = resolve }),
        markSettled: () => { recordEvidence(runtime!); runtime!.settledComplete = true; markSettled() },
        start: undefined,
        warnings,
        result: undefined,
        error: undefined,
        evidence: { status: 'pending', result: undefined, error: undefined },
      }
      this.workerRuntimes.set(resolved.name, runtime)
      this.preparing.delete(resolved.name)

      const deliverySignal = combineSignals(operationSignal, controller.signal)
      await abortable(this.team.sendMessage({
        from: this.leadName,
        target: resolved.name,
        message: resolved.task,
        delivery: 'quiet',
        signal: deliverySignal,
      }), deliverySignal)
      deliverySignal.throwIfAborted()
      if (definition.memory.autoCaptureObjective) {
        session.memory.captureOriginalObjective(createTextMessage(resolved.task))
      }

      if (dependencies.length > 0 && !this.dependenciesSettled(dependencies, resolved.writes)) {
        // Held, not started. The promise handed to the team is what makes the
        // wait honest: without it `wait_agents` asks an idle session whether it
        // is finished, is told yes, and the lead reads a worker that never ran
        // as one that had nothing to report.
        const held = new Promise<void>((resolve) => { runtime!.start = resolve })
        this.team.markPending(resolved.name, held)
        for (const dependency of dependencies) {
          if (SETTLED_WORKER_STATUS.has(dependency.status) && this.workerHasWork(dependency)) {
            // A completed worker may be running a team-scheduled follow-up.
            // Its original managed watcher has already finished.
            void this.team.whenIdle(dependency.request.name).then(() => this.releaseDependents(dependency)).catch(() => {})
          }
        }
        return this.workerView(runtime)
      }
      await this.startWorker(runtime, deliverySignal)
      return this.workerView(runtime)
    } catch (error: unknown) {
      if (runtime !== undefined && this.workerRuntimes.get(resolved.name) === runtime && !runtime.closing) {
        runtime.status = 'failed'
        runtime.error = errorMessage(error)
        runtime.start = undefined
        runtime.dependencies = []
        try { this.team.markPending(resolved.name, undefined) } catch { /* team already disposed */ }
        runtime.markSettled()
        this.workerRuntimes.delete(resolved.name)
        try { this.team.detach(resolved.name) } catch { /* registration already removed */ }
        await this.releaseDependents(runtime)
      }
      throw error
    } finally {
      this.preparing.delete(resolved.name)
      markPrepared()
    }
  }

  /**
   * Put a worker on the model, at last.
   *
   * Separate from `spawn` because a worker with dependencies is created now and
   * started later; the two used to be the same moment.
   */
  private beginWorker(runtime: WorkerRuntime): void {
    const name = runtime.request.name
    if (runtime.status !== 'pending' || runtime.closing || this.lifecycle.signal.aborted
      || this.workerRuntimes.get(name) !== runtime) return
    runtime.start?.()
    runtime.start = undefined
    this.team.markPending(name, undefined)
    // Closed while it was held: there is nothing left to start, and starting it
    // anyway would resurrect a worker the lead had already let go.
    runtime.status = 'running'

    // Started, NOT awaited. `runPending` begins the run eagerly and
    // synchronously, so by the time this returns the worker is genuinely
    // going; the promise is simply left for `followWorker` to watch.
    // Awaiting it in `spawn` is what blinded the lead: parked inside its own
    // tool call it could not read the worker's messages, could not spawn
    // anything else, and could not be told that the worker had gone quiet.
    //
    // `runPending` rather than `streamPending`, and that is load-bearing:
    // `onEvent` is delivered by the consumer `runPending` wraps around the
    // handle, so a bare `streamPending` starts the run and reports NOTHING.
    // Every worker event is lost with it — including the approval requests a
    // worker parks on, which leaves it waiting for an answer nobody was ever
    // shown, and the run hangs.
    const deadline = AbortSignal.timeout(this.workerTimeoutMs)
    runtime.deadline = deadline
    const running = runtime.session.runPending({
      signal: combineSignals(runtime.controller.signal, deadline),
      ...(this.options.onWorkerEvent === undefined
        ? {}
        : { onEvent: (event: AgentRunEvent) => this.observeWorkerEvent(name, event) }),
    })
    void this.followWorker(runtime, running)
  }

  /** One handoff path for both already-settled and asynchronously released dependencies. */
  private async startWorker(runtime: WorkerRuntime, setupSignal?: AbortSignal): Promise<void> {
    if (runtime.starting || runtime.status !== 'pending' || runtime.closing || this.lifecycle.signal.aborted) return
    runtime.starting = true
    try {
      const report = this.dependencyReport(runtime.dependencies)
      if (report !== undefined) {
        const signal = combineSignals(setupSignal, runtime.controller.signal, this.lifecycle.signal,
          AbortSignal.timeout(this.spawnTimeoutMs))
        await abortable(this.team.sendMessage({ from: this.leadName, target: runtime.request.name,
          message: report, delivery: 'quiet', signal }), signal)
        signal.throwIfAborted()
      }
      this.beginWorker(runtime)
    } catch (error: unknown) {
      // Missing required context is a visible failure, never a successful task
      // dispatched with the dependencies silently omitted.
      if (!runtime.closing && !this.lifecycle.signal.aborted) {
        runtime.status = 'failed'
        runtime.error = `dependency handoff failed: ${errorMessage(error)}`
        recordEvidence(runtime)
        runtime.start?.()
        runtime.start = undefined
        try {
          this.team.markPending(runtime.request.name, undefined)
          this.team.recordOutcome(runtime.request.name, { kind: 'failed', message: runtime.error })
        } catch { /* shared team already disposed */ }
        await this.notifyLead(runtime, `failed: ${runtime.error}`)
        runtime.markSettled()
        await this.releaseDependents(runtime)
      }
    } finally {
      // Retain producer facts only while queued/preparing. Completed ancestors
      // must not keep entire sessions alive through an arbitrarily long chain.
      runtime.dependencies = []
    }
  }

  /**
   * The `role` parameter, when the host declared any roles.
   *
   * Each role's purpose and precondition go in the description, which is where
   * Codex puts its role registry too: the lead is choosing a role at the
   * moment it reads this, so this is the only place the guidance can arrive in
   * time to change the choice.
   * @returns A one-property object to spread, or nothing.
   */
  private roleSchema(): Record<string, unknown> {
    if (this.roles.size === 0) return {}
    const lines = [...this.roles.values()].map(role =>
      `- ${role.name}: ${role.description}`
      + (role.whenToUse === undefined ? '' : ` Use when: ${role.whenToUse}`))
    return {
      role: {
        type: 'string',
        enum: [...this.roles.keys()],
        description: `Which kind of worker this is.\n${lines.join('\n')}`,
      },
    }
  }

  /** Resolve a declared role name, or say which ones exist. */
  private requireRole(name: unknown): string {
    const value = nonEmpty(name, 'worker role')
    if (this.roles.size === 0) {
      throw new Error('this managed team declares no roles, so spawn_agent takes no role')
    }
    if (!this.roles.has(value)) {
      throw new Error(
        `unknown worker role '${value}'; declared roles are ${[...this.roles.keys()].join(', ')}`,
      )
    }
    return value
  }

  /**
   * Check the named dependencies and return them deduplicated.
   *
   * A dependency can only name a worker that already exists, and a new worker
   * is not yet nameable by anything, so the graph cannot contain a cycle by
   * construction — no cycle check is needed here, and a `dependsOn` that could
   * name a future worker would need one.
   */
  private resolveDependencies(names: readonly string[]): readonly string[] {
    return [...new Set(names.map((name) => {
      const address = memberName(name)
      if (!this.workerRuntimes.has(address)) {
        throw new Error(
          `unknown dependency '${address}'; a worker can only depend on one that already exists`,
        )
      }
      return address
    }))]
  }

  /**
   * Judge a new worker's write scopes against the ones already in flight.
   *
   * Only workers that could run AT THE SAME TIME conflict. One that this
   * worker depends on, directly or through others, writes its files before
   * this one begins, so sharing a scope with it is ordinary sequential work —
   * and is in fact the fix the refusal points at.
   * @param request - The resolved spawn request.
   * @returns Warnings to record; throws instead under the `reject` policy.
   */
  private checkWriteScopes(request: ResolvedManagedAgentSpawnRequest, dependencies: readonly WorkerRuntime[]): readonly string[] {
    const policy = this.options.writeScopePolicy ?? 'reject'
    if (policy === 'off' || request.writes.length === 0) return []
    const ancestors = this.ancestorsOf(dependencies)
    const found: string[] = []
    const runningRoster = new Set(this.team.members().filter(member => member.status === 'running').map(member => member.conversationId))
    const others = [
      ...[...this.workerRuntimes.values()].filter(other => other.status === 'pending' || other.status === 'running' || this.workerHasWork(other, runningRoster))
        .filter(other => !ancestors.has(other)),
      ...this.drainingWrites,
      ...[...this.preparing.values()].filter(other => other.request.name !== request.name),
    ]
    for (const other of others) {
      const clash = request.writes.filter(mine =>
        other.request.writes.some(theirs => scopesOverlap(mine, theirs)))
      if (clash.length === 0) continue
      const detail = `'${other.request.name}' also writes ${clash.join(', ')}`
      if (policy === 'reject') {
        throw new Error(
          `worker '${request.name}' would write files another running worker writes: ${detail}.`
          + ` Add '${other.request.name}' to dependsOn so it runs after, or narrow the scopes`
          // Observed in a real run: four read-only researchers each declared the
          // same placeholder scope and collided over a file none of them would
          // ever write. The refusal used to offer only dependsOn and narrowing,
          // which sends a worker that writes nothing looking for a better fake
          // path instead of dropping the field.
          + ' — or omit writes entirely if this worker only reads.',
        )
      }
      found.push(detail)
    }
    return found
  }

  /**
   * Say what actually happened to a worker, in words the lead can act on.
   *
   * A raw abort reads "The operation was aborted due to timeout", which tells
   * the lead nothing about WHOSE timeout or whether re-delegating would help.
   * Codex reports a status the parent can branch on; the DeepSeek harness
   * records a blocker code with an explanation. This is the same idea at the
   * size this harness needs.
   * @param error - Whatever ended the run.
   * @returns The explanation to record and report.
   */
  private describeWorkerFailure(error: unknown, runtime: WorkerRuntime | undefined): string {
    if (runtime?.deadline?.aborted === true) return this.deadlineFailure()
    const name = (error as { name?: unknown } | null)?.name
    if (name === 'TimeoutError') return this.deadlineFailure()
    if (name === 'AbortError') return 'its work was cancelled before it finished'
    return errorMessage(error)
  }

  /** The one explanation an expired worker deadline deserves. */
  private deadlineFailure(): string {
    return `it ran past its ${String(this.workerTimeoutMs)}ms deadline without finishing.`
      + ' Narrow the task, or split it, before delegating it again'
  }

  /**
   * Block until a worker reports, or the hold deadline passes.
   *
   * Bounded on purpose. An unbounded wait would hand the whole run's liveness to
   * the slowest worker and, since this runs inside a turn hook, would be cut off
   * by the hook timeout rather than by anything that understands the work. When
   * it expires the lead gets its turn back and decides for itself — wait again
   * with `wait_agents`, close one, or answer with what it has.
   * @param outstanding - Workers that have not settled.
   */
  private async awaitWorkerNews(outstanding: readonly WorkerRuntime[]): Promise<void> {
    let removeSteer: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.holdWaitMs)
      // A timer must never be the reason a process stays alive. Node exposes
      // `unref`; a browser timer has no such handle and needs none.
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    try {
      const steered = this.leadSteer.signal
      const correction = new Promise<void>(resolve => {
        if (steered.aborted) resolve()
        else steered.addEventListener('abort', resolveSteer, { once: true })
        function resolveSteer() { resolve() }
        removeSteer = () => steered.removeEventListener('abort', resolveSteer)
      })
      await abortable(Promise.race([...outstanding.map(runtime => runtime.settled), deadline, correction]),
        combineSignals(this.lifecycle.signal, this.leadSignal))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      removeSteer?.()
    }
  }

  /** Every worker reachable through `dependsOn`, transitively. */
  private ancestorsOf(workers: readonly WorkerRuntime[], seen = new Set<WorkerRuntime>()): Set<WorkerRuntime> {
    for (const runtime of workers) {
      if (seen.has(runtime)) continue
      seen.add(runtime)
      this.ancestorsOf(runtime.dependencies, seen)
    }
    return seen
  }

  /** Includes team-owned follow-ups queued between session runs. */
  private workerHasWork(runtime: WorkerRuntime, runningRoster?: ReadonlySet<string | undefined>): boolean {
    return runtime.session.isRunning || this.drainingWrites.has(runtime)
      || (runningRoster === undefined
        ? this.team.members().some(member => member.name === runtime.request.name
          && member.conversationId === runtime.session.conversationId && member.status === 'running')
        : runningRoster.has(runtime.session.conversationId))
  }

  /** Whether every named worker has reached a final state without conflicting active writes. */
  private dependenciesSettled(workers: readonly WorkerRuntime[], writes: readonly string[] = []): boolean {
    return workers.every(runtime => SETTLED_WORKER_STATUS.has(runtime.status)
      && !((this.options.writeScopePolicy ?? 'reject') === 'reject'
        && writes.some(mine => runtime.request.writes.some(theirs => scopesOverlap(mine, theirs)))
        && this.workerHasWork(runtime)))
  }

  /**
   * Start whatever was waiting on the worker that just settled.
   *
   * Dependents are released when their dependencies SETTLE, not when they
   * succeed. Requiring success would let one failed worker strand every step
   * planned after it, and a plan that stalls silently is worse than one whose
   * later stages are told the earlier ones broke — which is exactly what they
   * are told: each dependent starts with what its dependencies produced.
   */
  private async releaseDependents(finished: WorkerRuntime): Promise<void> {
    if (this.lifecycle.signal.aborted) return
    const ready = [...this.workerRuntimes.values()].filter(runtime =>
      runtime.status === 'pending'
      && !runtime.closing
      && runtime.dependencies.includes(finished)
      && this.dependenciesSettled(runtime.dependencies, runtime.request.writes))
    for (const runtime of ready) {
      await this.startWorker(runtime)
    }
  }

  /** What the dependencies produced, as context for a dependent about to start. */
  private dependencyReport(workers: readonly WorkerRuntime[]): string | undefined {
    let hasTruncatedResult = false
    const lines = workers.map((runtime) => {
      const name = runtime.request.name
      if (runtime.error !== undefined) {
        const partial = runtime.result?.text
        const payload = partial ? truncate(partial, this.maxDependencyReportBytes) : undefined
        hasTruncatedResult ||= payload !== undefined && payload !== partial
        return `- worker address '${name}' FAILED: ${runtime.error}`
          + (partial ? '' : '\nResult payload: absent. No result data was returned.')
          + (payload === undefined ? '' : `\nPartial findings (not a completed task): ${payload}`)
      }
      if (runtime.result === undefined && runtime.status === 'closed') return `- worker address '${name}': closed before reporting. Result payload: absent. No result data was returned.`
      const text = runtime.result?.text ?? ''
      const payload = truncate(text, this.maxDependencyReportBytes)
      hasTruncatedResult ||= payload !== text
      return `- worker address '${name}' finished. ${payload === text ? 'Full' : 'Truncated'} result payload:\n${payload}`
    })
    if (lines.length === 0) return undefined
    return [
      'Dependency result data: worker addresses are routing metadata. Preserve source identifiers supplied in payloads; an absent payload supplies no evidence identifiers.',
      ...lines,
      ...(hasTruncatedResult ? ['Read truncated results with read_dependency_result, the original worker address and nextOffset.'] : []),
    ].join('\n')
  }

  /** Only this worker's commissioned producer instances are readable, including after closure. */
  private dependencyReadTool(dependencies: readonly WorkerRuntime[]): ToolDefinition {
    const scope = new Map(dependencies.map(runtime => [runtime.request.name, runtime.evidence]))
    return defineTool({
      name: 'read_dependency_result',
      description: 'Read a bounded page from an original dependency result, including after closure. Full handoffs already contain the same result. Use nextOffset until null; partial/failed results are not completed work.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['name'], additionalProperties: false },
      parse(raw: unknown) {
        if (typeof raw !== 'object' || raw === null) throw new TypeError('dependency name and offset required')
        const name = Reflect.get(raw, 'name'), offset = Reflect.get(raw, 'offset') ?? 0
        if (typeof name !== 'string' || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError('invalid dependency name or offset')
        return { name, offset: offset as number }
      },
      execute: ({ name, offset }) => {
        const producer = scope.get(name)
        if (producer === undefined) throw new Error('this worker was not commissioned against that dependency')
        const text = producer.result?.text ?? ''
        if (offset > text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]!))) throw new RangeError('offset must be a valid character boundary')
        // Offsets count UTF-16 code units, returned pages stay within the byte cap.
        const page = prefixWithinBytes(text.slice(offset), this.maxDependencyReportBytes)
        const next = offset + page.length
        return { name, status: producer.status, succeeded: producer.result?.succeeded ?? false,
          ...(producer.error === undefined ? {} : { error: producer.error }), text: page,
          nextOffset: next < text.length ? next : null }
      },
      isConcurrencySafe: () => true,
    })
  }

  /**
   * Watch a detached worker run to its end and report it.
   *
   * Never rejects: the run has no awaiting caller, so a throw here would be an
   * unhandled rejection. Failures are recorded on the runtime and told to the
   * lead instead, which is the same shape `AgentTeam.runWakeLoop` uses for the
   * other kind of un-awaited member run.
   */
  private async followWorker(
    runtime: WorkerRuntime,
    running: Promise<AgentResponse>,
  ): Promise<void> {
    const name = runtime.request.name
    try {
      const response = await running
      if (runtime.status !== 'closed' && !runtime.closing) {
        // A run that RESOLVES has not necessarily succeeded: a model call that
        // failed ends the turn with an error reason and an empty answer. Read
        // as a success it became "Worker 'x' finished:" with nothing after the
        // colon — the lead told a sector was done by a worker that never got
        // an answer out of the model, which is worse than being told nothing.
        const failure = runtime.deadline?.aborted === true
          ? this.deadlineFailure()
          : failureOf(response, this.options.requireWorkerText === true)
        if (failure !== undefined) {
          runtime.status = 'failed'
          runtime.error = failure
          // A failed final request must not erase evidence already returned.
          // Preserve partial output, but never report it as successful work.
          if (response.text.trim() !== '') {
            runtime.result = Object.freeze({
              worker: name,
              agentId: runtime.session.definition.id,
              conversationId: runtime.session.conversationId,
              text: response.text,
              succeeded: false,
            })
          }
          recordEvidence(runtime)
          this.team.recordOutcome(name, { kind: 'failed', message: failure })
          await this.notifyLead(runtime, `failed: ${failure}`
            + (runtime.result === undefined ? '' : `\nPartial findings (not a completed task): ${runtime.result.text}`))
        } else {
          runtime.status = 'completed'
          runtime.result = Object.freeze({
            worker: name,
            agentId: runtime.session.definition.id,
            conversationId: runtime.session.conversationId,
            text: response.text,
            succeeded: response.outcome.completed,
          })
          recordEvidence(runtime)
          this.team.recordOutcome(name, { kind: 'completed', text: response.text })
          await this.notifyLead(runtime, `finished: ${response.text}`)
        }
      }
    } catch (error: unknown) {
      // A close is not a failure. Reporting the abort it caused would tell the
      // lead its own decision went wrong, and — once a report can wake an idle
      // lead — would start a turn about a worker it deliberately abandoned.
      if (runtime.status !== 'closed' && !runtime.closing) {
        runtime.status = 'failed'
        runtime.error = this.describeWorkerFailure(error, runtime)
        recordEvidence(runtime)
        try { this.team.recordOutcome(name, { kind: 'failed', message: runtime.error }) } catch { /* shared team disposed */ }
        await this.notifyLead(runtime, `failed: ${runtime.error}`)
      }
    } finally {
      runtime.markSettled()
      // Whatever ended this worker — success, failure, or a close — the work
      // planned after it is no longer waiting on anything.
      await this.releaseDependents(runtime)
    }
  }

  /**
   * Tell the lead what one of its workers did.
   *
   * Quiet WHILE THE LEAD IS STILL IN ITS TURN: the report appends to history
   * and the next model round rebuilds its request from history, so the lead
   * reads it without an extra turn being scheduled. Holding that turn open is
   * {@link leadHooks}'s job.
   *
   * A wake-up once the lead has gone idle, because then nothing else will ever
   * read the report. The hold cannot cover every case — a turn that ended on
   * its step budget, or on an error, is not eligible to continue, and a worker
   * that outlives the run reports into a conversation with no turn left. That
   * is the failure this exists for: the transcript ends on a worker's own
   * output, and the synthesis the lead was there to write never happens. One
   * more turn is the point, not a duplicate answer.
   */
  private async notifyLead(runtime: WorkerRuntime, summary: string): Promise<void> {
    const worker = runtime.request.name
    if (runtime.closing || this.lifecycle.signal.aborted || this.workerRuntimes.get(worker) !== runtime) return
    const delivery = this.deliveryFor(worker)
    // A quiet report is a bet that the lead's next model round will read it.
    // Cleared by `beforeStep`, which is that round; still set at the end of a
    // turn that cannot continue, it means the bet lost and nobody ever will.
    if (delivery === 'quiet') this.unreadReports = true
    try {
      const signal = combineSignals(runtime.controller.signal, this.lifecycle.signal,
        AbortSignal.timeout(this.spawnTimeoutMs))
      await abortable(this.team.sendMessage(managedTeamNoticeRequest({
        from: worker,
        target: this.leadName,
        message: `Worker '${worker}' ${truncate(summary, Math.min(this.maxDependencyReportBytes, Math.max(64, Math.floor(this.team.messageByteLimit / 4))))}`,
        delivery,
        signal,
      })), signal)
    } catch {
      // The lead may already be gone, or the team disposed. A worker's report
      // is not worth failing anything else over; `workers()` still has it.
    }
  }

  /**
   * Quiet into an open turn, a wake-up into an idle conversation.
   * @param worker - The worker whose report is being delivered.
   * @returns The delivery the report needs to actually be read.
   */
  private deliveryFor(worker: string): 'quiet' | 'wakeup' {
    // Mid-turn: the next model round rebuilds its request from history, so the
    // report is read without scheduling anything.
    if (this.options.autoLeadCoordination === false || this.lead.isRunning) return 'quiet'
    // Idle, and the host is driving: waking would start a turn it did not ask
    // for, and it can read the result from `workers()` whenever it likes.
    if (this.workerRuntimes.get(worker)?.leadDriven !== true) return 'quiet'
    return 'wakeup'
  }

  /** Set when a worker report was delivered quietly and no round has read it. */
  private unreadReports = false
  private leadSteer = new AbortController()
  private leadSignal: AbortSignal | undefined

  /**
   * Wait until no worker is outstanding and the lead has nothing left to do.
   *
   * The roster cannot answer this on its own. A worker's last event fires
   * before its run resolves, and its completion report — the thing that wakes
   * the lead — is delivered after that. For the moment in between, every member
   * looks idle: a caller watching the roster sees a finished team and stops
   * listening, exactly as the synthesis is about to be written. Waiting here
   * covers that gap, because a worker's `settled` resolves only once its report
   * has been delivered.
   * @param signal - Gives up waiting; the work itself is not cancelled.
   */
  async whenQuiet(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted()
      const outstanding = [...this.workerRuntimes.values()]
        .filter(runtime => !runtime.settledComplete)
      const preparing = [...this.preparing.values()].map(prepared => prepared.settled)
      if (outstanding.length + preparing.length > 0) {
        await abortable(Promise.all([...outstanding.map(runtime => runtime.settled), ...preparing]), signal)
      }
      await this.team.whenIdle(this.leadName, signal)
      const busy = this.preparing.size > 0 || [...this.workerRuntimes.values()]
        .some(runtime => !runtime.settledComplete)
      if (!busy) return
    }
  }

  /** Current detached worker lifecycle view. */
  workers(): readonly ManagedAgentWorker[] {
    return Object.freeze([...this.workerRuntimes.values()].map(runtime => this.workerView(runtime)))
  }

  private workerView(runtime: WorkerRuntime): ManagedAgentWorker {
    return Object.freeze({
      name: runtime.request.name,
      agentId: runtime.session.definition.id,
      conversationId: runtime.session.conversationId,
      task: runtime.request.task,
      status: runtime.status,
      context: runtime.request.context,
      dependsOn: runtime.request.dependsOn,
      writes: runtime.request.writes,
      ...(runtime.request.role === undefined ? {} : { role: runtime.request.role }),
      ...(runtime.warnings.length === 0 ? {} : { warnings: runtime.warnings }),
      ...(runtime.request.specialty === undefined ? {} : { specialty: runtime.request.specialty }),
      ...(runtime.result === undefined ? {} : { result: runtime.result }),
      ...(runtime.error === undefined ? {} : { error: runtime.error }),
    })
  }

  /**
   * Wait for one worker to finish, for at most `timeoutMs`.
   *
   * Bounded on purpose. An unbounded wait is how a host loses the ability to
   * tell a slow worker from a stuck one; a caller that gets `undefined` back
   * still holds every other option.
   * @param name - Worker address.
   * @param options - Budget, default {@link DEFAULT_WAIT_TIMEOUT_MS}, and a signal.
   * @returns Its result, or undefined if it had not finished in time.
   */
  async awaitWorker(
    name: string,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ManagedAgentWorkerResult | undefined> {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    const budget = timeoutValue(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    // The timer is cleared either way: a worker that finishes early must not
    // leave one pending, which in a long-lived host is a slow leak.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, budget) })
    try {
      await abortable(Promise.race([runtime.settled, deadline]), options.signal)
    } finally {
      clearTimeout(timer)
    }
    options.signal?.throwIfAborted()
    return runtime.result
  }

  /**
   * Stop a worker and give up its slot.
   *
   * This is the stopping point a delegated agent otherwise lacks. A worker that
   * has already finished is still occupying a `maxWorkers` slot, so closing is
   * how a lead makes room for the next one.
   * @param name - Worker address.
   * @param reason - Cancellation reason for a worker still running.
   * @returns The status it held before being closed.
   */
  async closeWorker(
    name: string,
    reason: unknown = new Error('managed worker closed'),
  ): Promise<ManagedAgentWorkerStatus> {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    runtime.closing = true
    runtime.closeTask ??= Promise.resolve().then(() => this.closeRuntime(runtime, reason))
    return runtime.closeTask
  }

  private async closeRuntime(runtime: WorkerRuntime, reason: unknown): Promise<ManagedAgentWorkerStatus> {
    const address = runtime.request.name
    const previous = runtime.status
    runtime.closing = true
    runtime.controller.abort(reason)
    const closeDeadline = AbortSignal.timeout(this.closeTimeoutMs)
    // The controller only governs the run THIS harness started. A worker the
    // lead reached with followup_task, or any wake-up delivery, is running
    // under the team's own scheduler, and aborting the harness controller does
    // nothing to it: observed in a real run, a closed worker kept calling the
    // model for another fourteen seconds and submitted its result after the
    // lead had already answered, so the conversation ended on the worker's
    // output instead of the lead's synthesis.
    try {
      await abortable(this.team.cancel(address, reason), closeDeadline)
    } catch {
      // A cancellation that times out must not wedge the close: the slot is
      // freed either way, exactly as it is for a run that ignores its signal.
    }
    if (previous === 'pending') {
      // Never started, so there is no run to wait for — and `settled` would
      // never resolve on its own, because nothing is going to end.
      runtime.status = 'closed'
      runtime.start = undefined
      this.team.markPending(address, undefined)
      runtime.markSettled()
    } else {
      // Waited for, but not indefinitely, and a worker that ignores its signal
      // does not get to wedge the harness: the slot is freed either way. The
      // wait is what usually lets `detach` succeed, since it refuses a member
      // whose session is still running.
      try { await abortable(runtime.settled, closeDeadline) } catch { /* non-cooperative run remains bounded */ }
      runtime.status = 'closed'
      runtime.markSettled()
    }
    recordEvidence(runtime)
    if (this.workerHasWork(runtime)) {
      if (runtime.request.writes.length > 0) this.drainingWrites.add(runtime)
      // Closing frees the managed slot, but cannot establish that an active
      // session stopped writing. Release only its write claim at actual idle.
      void this.team.whenIdle(address).then(async () => {
        this.drainingWrites.delete(runtime)
        try {
          if (this.team.members().some(member => member.name === address && member.conversationId === runtime.session.conversationId)) {
            this.team.detach(address)
          }
        } catch { /* roster already removed or disposed */ }
        await this.releaseDependents(runtime)
      }).catch(() => { /* team lifecycle may already be disposed */ })
    }
    if (this.workerRuntimes.get(address) === runtime) {
      this.workerRuntimes.delete(address)
      try { this.team.detach(address) } catch { /* already gone, or the team is disposed */ }
    }
    // Closing is a settlement too: work planned after this worker must not be
    // left waiting on one the lead has abandoned.
    runtime.dependencies = []
    await this.releaseDependents(runtime)
    return previous
  }

  /**
   * Stop every worker this harness started.
   *
   * Workers outlive the lead's turn by design, so something has to end them:
   * without this a detached run would keep calling the model after the host had
   * moved on. Disposing the underlying `AgentTeam` is left to whoever owns it.
   * @param reason - Cancellation reason handed to each worker.
   */
  dispose(reason: unknown = new Error('managed agent team disposed')): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.lifecycle.abort(reason)
    const names = [...this.workerRuntimes.keys()]
    this.disposeTask = Promise.allSettled([
      ...[...this.preparing.values()].map(prepared => prepared.settled),
      ...names.map(name => this.closeWorker(name, reason)),
    ]).then(() => undefined)
    return this.disposeTask
  }

  /** Remove one idle generated worker from the harness and shared roster. */
  removeWorker(name: string): void {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    if (runtime.status === 'pending' || runtime.status === 'running' || !runtime.settledComplete || runtime.session.isRunning) {
      throw new Error(`cannot remove running managed worker '${address}'`)
    }
    this.team.detach(address)
    this.workerRuntimes.delete(address)
  }

  private controlTools(): readonly ToolDefinition<any>[] {
    return Object.freeze([
      defineTool({
        name: 'spawn_agent',
        description: [
          'Create a managed worker for the supplied task.',
          'Returns a lifecycle view after setup; a dependent may still be pending.',
          'Use list_agents for retained status/results and wait_agents for bounded waits.',
          'dependsOn binds already registered producer instances; writes declares relative scheduling scopes under host policy.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Optional unique worker address; omitted generates worker_N.',
            },
            task: {
              type: 'string',
              description: 'Task and any output contract assigned to the worker.',
            },
            specialty: {
              type: 'string',
              description: 'Optional worker role or domain specialization.',
            },
            context: {
              type: 'string',
              enum: ['fresh', 'fork'],
              description: 'fresh starts from the task; fork also copies the completed lead conversation.',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of workers that must finish before this one starts.'
                + ' The worker is created now and held until they do, then given what they'
                + ' produced. Register the producers first; a dependency cannot name a'
                + ' future or still-preparing worker. Failed producers also release dependents with failure status.',
            },
            writes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Workspace-relative scheduling scopes. Overlaps are rejected, warned or allowed'
                + ' according to host writeScopePolicy. This is not filesystem authorization.'
                + ' Omit when no writes are declared; placeholder paths claim real scopes.',
            },
            ...this.roleSchema(),
          },
          required: ['task'],
          additionalProperties: false,
        },
        parse: parseSpawnTool,
        execute: async (request, context) => asJson(await this.spawn(request, context.signal)),
        // Seconds, not the worker's whole deadline: this call only starts the
        // worker now. Leaving it at workerTimeoutMs would let a stuck SETUP
        // hold the lead for ten minutes.
        timeoutMs: this.spawnTimeoutMs,
        isConcurrencySafe: () => true,
      }),
      defineTool({
        name: 'close_agent',
        budgetExempt: true,
        description: [
          'Close a worker you no longer need and free its slot.',
          'A finished worker still occupies one until closed, so close it once you have read its result.',
          'A running or pending worker is kept alive by default so it can finish its final report.',
          this.options.allowModelWorkerCancellation === false
            ? 'The host requires worker reports: you cannot cancel unfinished workers. Wait for their result.'
            : 'Set cancelRunning: true only to deliberately abandon unfinished work and cancel it.',
          'Returns the status it held before closing.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Worker address returned by spawn_agent.' },
            cancelRunning: { type: 'boolean', description: 'Explicitly cancel an unfinished worker. Defaults to false.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
        parse: parseCloseTool,
        execute: async ({ name, cancelRunning }) => {
          const runtime = this.workerRuntimes.get(name)
          if (runtime !== undefined && (!cancelRunning || this.options.allowModelWorkerCancellation === false)
            && (runtime.status === 'pending' || runtime.status === 'running' || runtime.session.isRunning)) {
            return asJson({
              worker: name, closed: false,
              status: runtime.status === 'pending' ? 'pending' : 'running',
              instruction: 'The worker has not finished its final report. Use wait_agents and read its completed result before closing.'
                + (this.options.allowModelWorkerCancellation === false ? ' Model cancellation is disabled by the host.'
                  : ' To deliberately abandon this work, call close_agent with cancelRunning: true.'),
            })
          }
          return asJson({ worker: name, closed: true, previousStatus: await this.closeWorker(name) })
        },
        timeoutMs: this.workerTimeoutMs,
      }),
    ])
  }

  /**
   * Build the history a `fork` worker starts from.
   *
   * Limits come from the WORKER's session options, not the lead's: this is the
   * worker's own history from here on, and it is the worker's configured
   * ceiling that has to hold it.
   * @returns The lead's completed conversation as a fresh history.
   */
  private forkLeadHistory(limits: AgentSessionOptions['historyLimits']): History {
    const entries = completedHistoryPrefix(this.lead.snapshot().history)
    return History.fromSnapshot(
      { version: 1, entries },
      limits ?? {},
    )
  }

  private async workerDefinition(
    request: ResolvedManagedAgentSpawnRequest,
  ): Promise<DefinedAgent> {
    if (this.options.workerFactory !== undefined) return this.options.workerFactory(request)
    const template = this.options.workerTemplate ?? this.options.lead
    const role = request.role === undefined ? undefined : this.roles.get(request.role)
    const roleText = role === undefined
      ? ''
      : ` You are the '${role.name}' worker. ${role.instructions ?? role.description}`
    const specialty = request.specialty === undefined
      ? ''
      : ` Your specialization is: ${request.specialty}.`
    return cloneAgent(template, {
      id: request.name,
      name: request.name,
      instructions: `${template.instructions}\n\nYou are dynamically assigned worker '${request.name}'.${roleText}${specialty}`,
    })
  }

  private nextWorkerName(): string {
    while (true) {
      const candidate = `worker_${++this.workerSequence}`
      if (!this.preparing.has(candidate) && !this.workerRuntimes.has(candidate)
        && !this.team.members().some(member => member.name === candidate)) return candidate
    }
  }

  private async observeWorkerEvent(worker: string, event: AgentRunEvent): Promise<void> {
    const observer = Promise.resolve().then(() => this.options.onWorkerEvent?.(worker, event))
    await waitForSettlement(observer, this.observerTimeoutMs)
  }
}

export function createManagedAgentTeam(options: ManagedAgentTeamOptions): ManagedAgentTeam {
  return new ManagedAgentTeam(options)
}

function mergeTools(
  supplied: ToolCatalog | readonly ToolDefinition<any>[] | undefined,
  generated: readonly ToolDefinition<any>[],
): ToolRegistry {
  const registry = new ToolRegistry()
  if (supplied !== undefined) {
    const tools = 'names' in supplied
      ? supplied.names().map(name => supplied.get(name))
        .filter((tool): tool is ToolDefinition => tool !== undefined)
      : supplied
    for (const tool of tools) registry.register(tool)
  }
  for (const tool of generated) registry.register(tool)
  return registry
}

function parseCloseTool(value: unknown): { name: string; cancelRunning: boolean } {
  const input = object(value, 'close_agent arguments')
  if (Object.keys(input).some(key => key !== 'name' && key !== 'cancelRunning')) {
    throw new TypeError('close_agent arguments contain unknown fields')
  }
  if (input.cancelRunning !== undefined && typeof input.cancelRunning !== 'boolean') {
    throw new TypeError('close_agent cancelRunning must be a boolean')
  }
  return { name: memberName(input.name), cancelRunning: input.cancelRunning === true }
}

function parseSpawnTool(value: unknown): ManagedAgentSpawnRequest {
  const input = object(value, 'spawn_agent arguments')
  const known = new Set([
    'name', 'task', 'specialty', 'context', 'role', 'dependsOn', 'writes',
  ])
  if (Object.keys(input).some(key => !known.has(key))) {
    throw new TypeError('spawn_agent arguments contain unknown fields')
  }
  return {
    task: nonEmpty(input.task, 'worker task'),
    ...(input.name === undefined ? {} : { name: memberName(input.name) }),
    ...(input.specialty === undefined
      ? {}
      : { specialty: nonEmpty(input.specialty, 'worker specialty') }),
    ...(input.context === undefined ? {} : { context: spawnContext(input.context) }),
    ...(input.role === undefined ? {} : { role: nonEmpty(input.role, 'worker role') }),
    ...(input.dependsOn === undefined
      ? {}
      : { dependsOn: stringArray(input.dependsOn, 'dependsOn') }),
    ...(input.writes === undefined ? {} : { writes: stringArray(input.writes, 'writes') }),
  }
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of strings`)
  return value.map(entry => nonEmpty(entry, `${label} entry`))
}

function spawnContext(value: unknown): ManagedAgentSpawnContext {
  if (value !== 'fresh' && value !== 'fork') {
    throw new TypeError("worker context must be 'fresh' or 'fork'")
  }
  return value
}

/**
 * Copy the lead's conversation up to the last point it was complete.
 *
 * The lead is INSIDE a turn when it calls `spawn_agent`: the assistant message
 * carrying that very call is already in history, and its result cannot be,
 * because producing it is what this code is doing. Handing that tail to a
 * worker gives it a conversation ending in an unanswered tool call — which
 * providers reject, and which would turn a context optimisation into a spawn
 * that fails outright.
 *
 * So the fork is cut at the last position where no tool call was outstanding.
 * That is also the honest boundary in meaning: work still in flight is not yet
 * something the lead knows. The DeepSeek harness names the same rule a
 * "completed-turn prefix".
 *
 * A prefix is safe to hydrate as a history in its own right: `replace` surface
 * ops and compaction records only ever reference earlier entries, so cutting
 * from the end cannot orphan a reference.
 * @param snapshot - The lead's history, taken mid-turn.
 * @returns Entries up to that boundary; empty when nothing has completed.
 */
export function completedHistoryPrefix(
  snapshot: HistorySnapshot,
): readonly HistoryEntry[] {
  const pending = new Set<string>()
  let cut = 0
  snapshot.entries.forEach((entry, index) => {
    const event = entry.event
    if (event.kind === 'tool-call') pending.add(event.callId)
    else if (event.kind === 'tool-result') pending.delete(event.callId)
    else if (event.kind === 'assistant') {
      // The assistant MESSAGE carries its own tool-call blocks, separately from
      // the `tool-call` events beside it. Counting only the events left the
      // spawn call in the fork, complete with the synthetic "interrupted before
      // a result was recorded" error the request builder pairs it with — the
      // worker's first sight of its lead being that it had just failed.
      for (const block of event.message.content) {
        if (block.type === 'tool-call') pending.add(block.id)
      }
    }
    // An interrupted assistant message is a turn that never finished; treating
    // it as settled context would hand a worker a half-formed intention.
    const settled = pending.size === 0
      && !(event.kind === 'assistant' && event.interrupted === true)
    if (settled) cut = index + 1
  })
  return snapshot.entries.slice(0, cut)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function memberName(value: unknown): string {
  const name = nonEmpty(value, 'managed agent name')
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new TypeError('managed agent name must start with a letter and contain only letters, digits, _ or -')
  }
  if (name.length > 128) throw new TypeError('managed agent name must not exceed 128 characters')
  return name
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function boundedString(value: unknown, label: string, maxBytes: number): string {
  const text = nonEmpty(value, label)
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new TypeError(`${label} exceeds the ${maxBytes}-byte limit`)
  }
  return text
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    // Calling a host callback can synchronously abort and return a rejected
    // promise; retain its rejection observer even though cancellation won.
    void promise.catch(() => undefined)
    throw signal.reason ?? new Error('managed worker aborted')
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('managed worker aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const active = signals.filter((candidate): candidate is AbortSignal => candidate !== undefined)
  return active.length === 1 ? active[0]! : AbortSignal.any(active)
}

function asJson(value: unknown): JsonValue { return value as JsonValue }

/** Worker states that will never change again on their own. */
const SETTLED_WORKER_STATUS: ReadonlySet<ManagedAgentWorkerStatus> =
  new Set<ManagedAgentWorkerStatus>(['completed', 'failed', 'closed'])

/**
 * Reduce one declared write scope to a comparable path.
 *
 * Comparison is by path component, so the shapes that mean the same directory
 * have to arrive spelled the same way: `./app/`, `app`, and `app\` all name
 * `app`, and a worker writing `app/page.tsx` conflicts with one writing `app`.
 */
/**
 * Why a worker's run did not produce an answer, if it did not.
 *
 * A rejected run is obvious; a run that ends on an error reason is not, because
 * it resolves like any other. Both leave the lead with nothing to read, so both
 * are failures as far as the report is concerned.
 * @param response - What the worker's run returned.
 * @returns The failure to report, or undefined when the worker actually answered.
 */
function failureOf(response: AgentResponse, requireText: boolean): string | undefined {
  const reason = response.outcome.reason
  if (reason.kind === 'error') return reason.failure.message
  if (reason.kind === 'max-tokens') return 'the model stopped at its output limit'
  if (reason.kind === 'usage-unavailable') return 'the provider reported no usage for a billed call'
  if (reason.kind === 'aborted') return 'the run was aborted'
  if (reason.kind === 'budget-exhausted' && !response.outcome.completed) {
    return `the run stopped at its ${reason.budget} limit before completing the task`
  }
  // Tool-only agents may intentionally complete without a textual answer.
  if (requireText && response.text.trim() === '') return 'it produced no answer'
  return undefined
}

function normalizeWriteScope(value: unknown): string {
  const text = nonEmpty(value, 'worker write scope').trim().split('\\').join('/')
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) {
    throw new TypeError('a worker write scope must be workspace-relative')
  }
  const parts: string[] = []
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) throw new TypeError('a worker write scope must not escape the workspace')
      parts.pop()
    } else parts.push(part)
  }
  if (parts.length === 0) {
    throw new TypeError('a worker write scope must name a file or directory, not the whole workspace')
  }
  return parts.join('/')
}

/** Whether two normalized scopes cover any of the same files. */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Cut text to a byte budget without splitting a UTF-16 surrogate pair. */
function prefixWithinBytes(text: string, maxBytes: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(new TextEncoder().encode(text).subarray(0, maxBytes), { stream: true })
}

/** Keep both the initial findings and final verdict; the marker is inside the byte cap. */
function truncate(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return text
  const marker = '\n… (truncated; read full result) …\n'
  const markerBytes = new TextEncoder().encode(marker).byteLength
  if (maxBytes <= markerBytes) return prefixWithinBytes('(truncated)', maxBytes)
  const remaining = maxBytes - markerBytes
  const head = prefixWithinBytes(text, Math.ceil(remaining / 2))
  let tailStart = encoded.length - Math.floor(remaining / 2)
  while (tailStart < encoded.length && (encoded[tailStart]! & 0xc0) === 0x80) tailStart++
  const tail = new TextDecoder().decode(encoded.subarray(tailStart))
  return head + marker + tail
}

/** Detached evidence keeps full reports available without retaining producer sessions or ancestor chains. */
function recordEvidence(runtime: WorkerRuntime): void {
  runtime.evidence.status = runtime.status
  runtime.evidence.result = runtime.result
  runtime.evidence.error = runtime.error
}
