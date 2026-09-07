/** Codex-style dynamic worker creation and delegation over AgentTeam. */

import type { JsonValue } from '../../primitives/index.ts'
import { timeoutValue } from '../../platform/config.ts'
import { createTextMessage } from '../../message/index.ts'
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
 * What the lead is told about delegating.
 *
 * This used to say little more than "delegate when it helps", and the result
 * was a lead that divided AGENTS without dividing WORK. A trace from this
 * project: asked for a todo app built by three agents, it spawned a UI worker,
 * a logic worker and an audit worker in one step, into an empty directory. The
 * audit worker had nothing to review and spent its run inventing a checklist;
 * the other two each discovered the empty directory separately and each decided
 * to scaffold it, one of them announcing it would put the logic in the page
 * component the other had been given. Nothing in the mechanism was broken. The
 * lead had simply never been told what a good division looks like, or that some
 * work has to happen before any division is possible.
 *
 * Both reference implementations answer this in prose rather than with a task
 * graph. Codex's `spawn_agent` description carries sections on when to delegate
 * versus work locally, how to design a subtask, and what to do afterwards; the
 * DeepSeek harness adds a task board where dependencies gate claiming and file
 * hints warn on overlap. Neither offers the model a `depends_on` field. The
 * rules below are that guidance, reduced to the four the trace shows matter:
 *
 * 1. Plan first and name the critical path — delegating before there is
 *    anything to delegate is the expensive mistake.
 * 2. Keep the blocking next step local; delegate what runs alongside it.
 * 3. Give each worker a disjoint set of files to write.
 * 4. Do not delegate verification until there is something to verify.
 */
const LEAD_INSTRUCTIONS = [
  'You lead a managed dynamic team. Delegation buys parallelism; it is not a way to distribute a task you have not yet understood.',
  'PLAN BEFORE YOU DELEGATE. State briefly what the objective needs, which steps block the others, and which can run alongside them, and decide what you will do yourself right now. Only then spawn.',
  'Do the blocking step yourself. If your very next action depends on a result, producing it locally is faster than delegating it and waiting for it.',
  'Delegate work that runs alongside your own: concrete, bounded, self-contained, and worth a whole worker.',
  'GIVE EACH WORKER A DISJOINT SET OF FILES TO WRITE. Declare them in `writes`, and say which in its task. Two workers building different features of one file will each write that file, and the later write erases the earlier one; a spawn that would do this is refused.',
  'EXPRESS ORDER WITH `dependsOn`, NOT BY SPAWNING LATE. A worker that reviews, integrates, or builds on another names it there: it is created now, held until that work settles, and then given what it produced. Spawn the whole plan in one step and let the order be enforced rather than remembered.',
  'Do not delegate review, audit or verification against nothing. Either the thing to be reviewed already exists, or the reviewer `dependsOn` whoever is producing it. A reviewer started over an empty workspace produces a checklist, not a review.',
  'When the work does not exist yet, the first step is yours: establish its shape — scaffold, layout, shared types — and then delegate the independent pieces of it.',
  'Choose each worker context deliberately: fork when it needs what you have already found out, fresh when its task genuinely stands alone. Given neither, every worker rediscovers the workspace for itself.',
  'Call spawn_agent several times in one step for work that is genuinely independent, and once for work that is not.',
  'spawn_agent does not return a result: workers run while you keep working, and each one reports back to you when it finishes.',
  'After delegating, do useful non-overlapping work. Do not wait by reflex, and do not redo what you delegated.',
  'Use wait_agents only when you need a result to continue. It returns within its timeout whether or not anyone finished, so read the reported status and decide again.',
  'Read a finished worker result from list_agents, then call close_agent to release its slot.',
  'Never answer as if a worker had reported when it has not; say what is still outstanding instead.',
  'Synthesize worker results yourself and remain responsible for the final answer.',
].join(' ')

/**
 * How much of the lead's conversation a new worker starts from.
 *
 * `fresh` is one task and nothing else. `fork` copies the lead's completed
 * conversation so far, so the worker begins already knowing what the lead
 * learned — the state of the workspace, the decisions taken, what the other
 * workers were given.
 *
 * The distinction exists because its absence is expensive in a specific way.
 * With only a task string, every worker re-derives the same context from
 * scratch: three workers spawned into an empty repository each listed the
 * directory, each concluded independently that nothing was there, and each
 * decided on its own to scaffold it. Both reference implementations offer the
 * same choice — Codex as `fork_context`/`fork_turns`, the DeepSeek harness as
 * `context: 'fresh' | 'fork'`, whose naming this follows.
 */
export type ManagedAgentSpawnContext = 'fresh' | 'fork'

/**
 * A worker kind the host declares up front.
 *
 * Without a declared set, `specialty` is free text the model invents at the
 * moment it spawns: the harness is handed `"Code review, accessibility,
 * security và quality audit"` and can make nothing of it — not that the role
 * reads rather than writes, not that it needs code to exist first. So it
 * cannot help order the work, and the lead is left inventing both the role and
 * its place in the plan in the same breath.
 *
 * Declaring roles turns that into a choice from a list the host wrote, with
 * `whenToUse` stating the precondition in the spawn schema where the lead
 * reads it. Codex does the same thing with `agent_type` and its role registry.
 */
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
  /**
   * Workers that must finish before this one starts.
   *
   * The harness holds it back until every one of them has settled, and then
   * gives it what they produced. This is the difference between dividing
   * agents and dividing work: a lead can spawn the whole plan in one step —
   * which is what it wants to do — and the ORDER is still respected, because
   * ordering is no longer something the model has to remember to enforce by
   * spawning late.
   *
   * A dependency that fails still releases its dependents, and they are told
   * it failed. Waiting only for success turns one broken worker into a
   * permanently stalled plan.
   */
  readonly dependsOn?: readonly string[]
  /**
   * Files and directories this worker may write, workspace-relative.
   *
   * Declared so the harness can refuse a division that cannot work. Two
   * workers given overlapping scopes with no ordering between them will both
   * write those files, and the later write erases the earlier one — observed
   * as a UI worker announcing it would put its logic in the very page
   * component the logic worker had been assigned.
   */
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
   * Defaults to 8 KiB per dependency.
   */
  readonly maxDependencyReportBytes?: number
  /** End-to-end deadline for one generated worker. Defaults to 10 minutes. */
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
  status: ManagedAgentWorkerStatus
  /**
   * Cancels this worker's run.
   *
   * Owned here rather than by the team: `AgentTeam.cancel` only aborts a
   * team-scheduled wake, not a run a host started itself, so without this a
   * detached worker would survive both `close_agent` and `dispose`.
   */
  readonly controller: AbortController
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
}

/**
 * A dynamic harness whose lead can create specialized workers with spawn_agent.
 *
 * `spawn_agent` blocks the lead for as long as its worker runs, so it declares
 * that blocking to the team as a wait edge. Cycle detection is only as good as
 * the graph it can see: an unrecorded edge does not merely go unchecked, it
 * lets the cycle it completes through, and a worker waiting for the lead that
 * is waiting for it deadlocks both until a timeout.
 *
 * Each worker is a real connected AgentSession and remains addressable afterward.
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
  private readonly spawnTimeoutMs: number
  private readonly workerRuntimes = new Map<string, WorkerRuntime>()
  private readonly reservedNames = new Set<string>()
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
    this.spawnTimeoutMs = timeoutValue(options.spawnTimeoutMs ?? DEFAULT_SPAWN_SETUP_TIMEOUT_MS)
    this.maxDependencyReportBytes = positiveInteger(
      options.maxDependencyReportBytes ?? 8 * 1024,
      'maxDependencyReportBytes',
    )
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
      onTurnEnd: async (context) => {
        await host?.onTurnEnd?.(context)
        if (!context.canContinue) return
        const busy = [...this.workerRuntimes.values()]
          .filter(runtime => runtime.status === 'running')
          .map(runtime => runtime.request.name)
        if (busy.length === 0) return
        this.lead.inject(
          `Not finished: ${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} still running. `
          + 'Use wait_agents to wait for them and read their results, or close_agent to '
          + 'give up on one. Do not present a conclusion that depends on work they have '
          + 'not reported yet.',
        )
      },
    }
  }

  /** Run the lead. It decides whether and how many workers to create. */
  run(input: AgentInput, invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    return this.lead.run(input, invocation)
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
    signal?.throwIfAborted()
    const resolved: ResolvedManagedAgentSpawnRequest = {
      name: memberName(request.name ?? this.nextWorkerName()),
      task: boundedString(request.task, 'worker task', this.maxTaskBytes),
      ...(request.specialty === undefined
        ? {}
        : { specialty: boundedString(request.specialty, 'worker specialty', this.maxSpecialtyBytes) }),
      context: request.context ?? this.options.defaultSpawnContext ?? 'fresh',
      ...(request.role === undefined ? {} : { role: this.requireRole(request.role) }),
      dependsOn: this.resolveDependencies(request.dependsOn ?? []),
      writes: [...new Set((request.writes ?? []).map(normalizeWriteScope))],
    }
    if (this.workerRuntimes.size + this.reservedNames.size >= this.maxWorkers) {
      throw new Error(`managed agent team reached its ${this.maxWorkers}-worker limit`)
    }
    if (this.reservedNames.has(resolved.name) || this.workerRuntimes.has(resolved.name)
      || this.team.members().some(member => member.name === resolved.name)) {
      throw new Error(`managed worker '${resolved.name}' already exists`)
    }

    this.reservedNames.add(resolved.name)
    let runtime: WorkerRuntime | undefined
    try {
      const warnings = this.checkWriteScopes(resolved)
      const operationSignal = combineSignals(signal, AbortSignal.timeout(this.workerTimeoutMs))
      const definition = await abortable(this.workerDefinition(resolved), operationSignal)
      operationSignal.throwIfAborted()
      const scopedSessionOptions = this.options.workerSessionOptionsFactory === undefined
        ? undefined
        : await abortable(Promise.resolve(this.options.workerSessionOptionsFactory(resolved)), operationSignal)
      operationSignal.throwIfAborted()
      const session = definition.createSession({
        ...this.options.workerSessionOptions,
        ...scopedSessionOptions,
        ...(resolved.context === 'fork' ? { history: this.forkLeadHistory() } : {}),
        registry: this.options.registry,
        team: {
          team: this.team,
          name: resolved.name,
          role: 'peer',
          // A worker exists to finish one task and hand back a result, so it
          // gets no verb that can block it or push work elsewhere. With them
          // it has no stopping point: a worker wanting guidance messages a
          // peer and then waits, and only a cancellation ends its run.
          tools: 'reporting',
          instructions: [
            `You are a dynamically created worker reporting to '${this.leadName}'.`,
            'Complete the delegated task independently and return a concise evidence-backed result.',
            'Do not broaden the task or attempt to become team lead.',
            'If you lack information, state what is missing in your result rather than waiting for an answer.',
          ].join(' '),
          ...(resolved.specialty === undefined ? {} : { description: resolved.specialty }),
        },
      })
      const controller = new AbortController()
      let markSettled!: () => void
      runtime = {
        request: resolved,
        session,
        status: 'pending',
        controller,
        settled: new Promise<void>((resolve) => { markSettled = resolve }),
        markSettled,
        start: undefined,
        warnings,
        result: undefined,
        error: undefined,
      }
      this.workerRuntimes.set(resolved.name, runtime)
      this.reservedNames.delete(resolved.name)

      await this.team.sendMessage({
        from: this.leadName,
        target: resolved.name,
        message: resolved.task,
        delivery: 'quiet',
        signal: operationSignal,
      })
      if (definition.memory.autoCaptureObjective) {
        session.memory.captureOriginalObjective(createTextMessage(resolved.task))
      }

      if (resolved.dependsOn.length > 0 && !this.dependenciesSettled(resolved.dependsOn)) {
        // Held, not started. The promise handed to the team is what makes the
        // wait honest: without it `wait_agents` asks an idle session whether it
        // is finished, is told yes, and the lead reads a worker that never ran
        // as one that had nothing to report.
        const held = new Promise<void>((resolve) => { runtime!.start = resolve })
        this.team.markPending(resolved.name, held)
        return this.workerView(runtime)
      }
      this.beginWorker(runtime)
      return this.workerView(runtime)
    } catch (error: unknown) {
      if (runtime !== undefined) {
        runtime.status = 'failed'
        runtime.error = errorMessage(error)
        runtime.start = undefined
        runtime.markSettled()
      }
      throw error
    } finally {
      this.reservedNames.delete(resolved.name)
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
    runtime.start?.()
    runtime.start = undefined
    this.team.markPending(name, undefined)
    // Closed while it was held: there is nothing left to start, and starting it
    // anyway would resurrect a worker the lead had already let go.
    if (runtime.status !== 'pending') return
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
    const running = runtime.session.runPending({
      signal: combineSignals(runtime.controller.signal, AbortSignal.timeout(this.workerTimeoutMs)),
      ...(this.options.onWorkerEvent === undefined
        ? {}
        : { onEvent: (event: AgentRunEvent) => this.observeWorkerEvent(name, event) }),
    })
    void this.followWorker(runtime, running)
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
  private checkWriteScopes(request: ResolvedManagedAgentSpawnRequest): readonly string[] {
    const policy = this.options.writeScopePolicy ?? 'reject'
    if (policy === 'off' || request.writes.length === 0) return []
    const ancestors = this.ancestorsOf(request.dependsOn)
    const found: string[] = []
    for (const other of this.workerRuntimes.values()) {
      if (other.status !== 'pending' && other.status !== 'running') continue
      if (ancestors.has(other.request.name)) continue
      const clash = request.writes.filter(mine =>
        other.request.writes.some(theirs => scopesOverlap(mine, theirs)))
      if (clash.length === 0) continue
      const detail = `'${other.request.name}' also writes ${clash.join(', ')}`
      if (policy === 'reject') {
        throw new Error(
          `worker '${request.name}' would write files another running worker writes: ${detail}.`
          + ` Add '${other.request.name}' to dependsOn so it runs after, or narrow the scopes.`,
        )
      }
      found.push(detail)
    }
    return found
  }

  /** Every worker reachable through `dependsOn`, transitively. */
  private ancestorsOf(names: readonly string[], seen = new Set<string>()): Set<string> {
    for (const name of names) {
      if (seen.has(name)) continue
      seen.add(name)
      const runtime = this.workerRuntimes.get(name)
      if (runtime !== undefined) this.ancestorsOf(runtime.request.dependsOn, seen)
    }
    return seen
  }

  /** Whether every named worker has reached a final state. */
  private dependenciesSettled(names: readonly string[]): boolean {
    return names.every((name) => {
      const runtime = this.workerRuntimes.get(name)
      // Gone means closed and detached: settled, and no longer able to report.
      return runtime === undefined || SETTLED_WORKER_STATUS.has(runtime.status)
    })
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
  private async releaseDependents(finished: string): Promise<void> {
    const ready = [...this.workerRuntimes.values()].filter(runtime =>
      runtime.status === 'pending'
      && runtime.request.dependsOn.includes(finished)
      && this.dependenciesSettled(runtime.request.dependsOn))
    for (const runtime of ready) {
      const report = this.dependencyReport(runtime.request.dependsOn)
      if (report !== undefined) {
        try {
          await this.team.sendMessage({
            from: this.leadName,
            target: runtime.request.name,
            message: report,
            delivery: 'quiet',
          })
        } catch {
          // A worker that cannot be told what came before it is still better
          // started than stranded; its own task stands on its own.
        }
      }
      this.beginWorker(runtime)
    }
  }

  /** What the dependencies produced, as context for a dependent about to start. */
  private dependencyReport(names: readonly string[]): string | undefined {
    const lines = names.map((name) => {
      const runtime = this.workerRuntimes.get(name)
      if (runtime === undefined) return `- ${name}: closed before reporting.`
      if (runtime.error !== undefined) return `- ${name} FAILED: ${runtime.error}`
      const text = runtime.result?.text ?? ''
      return `- ${name} finished: ${truncate(text, this.maxDependencyReportBytes)}`
    })
    if (lines.length === 0) return undefined
    return [
      'Work you depend on has finished. Its results follow; build on them rather than redoing them.',
      ...lines,
    ].join('\n')
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
      if (runtime.status !== 'closed') {
        runtime.status = 'completed'
        runtime.result = Object.freeze({
          worker: name,
          agentId: runtime.session.definition.id,
          conversationId: runtime.session.conversationId,
          text: response.text,
          succeeded: response.outcome.completed,
        })
        this.team.recordOutcome(name, { kind: 'completed', text: response.text })
        await this.notifyLead(name, `finished: ${response.text}`)
      }
    } catch (error: unknown) {
      if (runtime.status !== 'closed') {
        runtime.status = 'failed'
        runtime.error = errorMessage(error)
        this.team.recordOutcome(name, { kind: 'failed', message: runtime.error })
        await this.notifyLead(name, `failed: ${runtime.error}`)
      }
    } finally {
      runtime.markSettled()
      // Whatever ended this worker — success, failure, or a close — the work
      // planned after it is no longer waiting on anything.
      await this.releaseDependents(name)
    }
  }

  /**
   * Tell the lead what one of its workers did.
   *
   * Quiet: it appends to the lead's history without scheduling anything, and
   * the loop rebuilds its request from history every model round, so a lead
   * still inside its turn reads this on the next one. Holding that turn open
   * is {@link leadHooks}'s job, not this one's — waking a lead that had
   * already concluded would have it answer twice instead.
   */
  private async notifyLead(worker: string, summary: string): Promise<void> {
    try {
      await this.team.sendMessage({
        from: worker,
        target: this.leadName,
        message: `Worker '${worker}' ${summary}`,
        delivery: 'quiet',
      })
    } catch {
      // The lead may already be gone, or the team disposed. A worker's report
      // is not worth failing anything else over; `workers()` still has it.
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
      await Promise.race([runtime.settled, deadline])
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
    const previous = runtime.status
    runtime.controller.abort(reason)
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
      await waitForSettlement(runtime.settled, this.closeTimeoutMs)
      runtime.status = 'closed'
    }
    this.workerRuntimes.delete(address)
    try { this.team.detach(address) } catch { /* already gone, or the team is disposed */ }
    // Closing is a settlement too: work planned after this worker must not be
    // left waiting on one the lead has abandoned.
    await this.releaseDependents(address)
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
  async dispose(reason: unknown = new Error('managed agent team disposed')): Promise<void> {
    const names = [...this.workerRuntimes.keys()]
    await Promise.allSettled(names.map(name => this.closeWorker(name, reason)))
  }

  /** Remove one idle generated worker from the harness and shared roster. */
  removeWorker(name: string): void {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    if (runtime.status === 'running' || runtime.session.isRunning) {
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
          'Create a connected specialist worker and start one task on it.',
          'Returns as soon as the worker is running, WITHOUT its result: keep working,',
          'and you will be told when it finishes. Use wait_agents to pause for it,',
          'list_agents to read its status and result, and close_agent when done with it.',
          'Before the first call, plan: name the step that blocks the others and do that',
          'one yourself. Then spawn the rest of the plan in one step: declare each',
          'worker\'s `writes` so two never write the same file, and use `dependsOn` for',
          'anything that must follow another worker rather than waiting to spawn it.',
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
              description: 'Concrete bounded task assigned to the worker.'
                + ' State which files it owns and may write, so two workers never write the same one.',
            },
            specialty: {
              type: 'string',
              description: 'Optional worker role or domain specialization.',
            },
            context: {
              type: 'string',
              enum: ['fresh', 'fork'],
              description: 'fresh starts the worker from its task alone;'
                + ' fork also gives it your conversation so far, so it does not have to'
                + ' rediscover what you already established. Prefer fork when the task'
                + ' depends on findings of yours.',
            },
            dependsOn: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of workers that must finish before this one starts.'
                + ' The worker is created now and held until they do, then given what they'
                + ' produced — so spawn the whole plan at once and express the ORDER here'
                + ' rather than by spawning later. Use it for anything that reviews,'
                + ' integrates or builds on another worker.',
            },
            writes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Files and directories this worker may write, workspace-relative.'
                + ' A spawn that would write what another worker running at the same time'
                + ' writes is refused, because both would write it and the later write wins.'
                + ' Declare them and the conflict is caught before any work is lost.',
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
        description: [
          'Close a worker you no longer need and free its slot.',
          'A finished worker still occupies one until closed, so close it once you have read its result.',
          'Closing a worker that is still running cancels its work.',
          'Returns the status it held before closing.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Worker address returned by spawn_agent.' },
          },
          required: ['name'],
          additionalProperties: false,
        },
        parse: parseCloseTool,
        execute: async ({ name }) => asJson({
          worker: name,
          previousStatus: await this.closeWorker(name),
        }),
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
  private forkLeadHistory(): History {
    const entries = completedHistoryPrefix(this.lead.snapshot().history)
    return History.fromSnapshot(
      { version: 1, entries },
      this.options.workerSessionOptions?.historyLimits ?? {},
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
      if (!this.reservedNames.has(candidate) && !this.workerRuntimes.has(candidate)
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

function parseCloseTool(value: unknown): { name: string } {
  const input = object(value, 'close_agent arguments')
  if (Object.keys(input).some(key => key !== 'name')) {
    throw new TypeError('close_agent arguments contain unknown fields')
  }
  return { name: memberName(input.name) }
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

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('managed worker aborted')
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
function normalizeWriteScope(value: unknown): string {
  const text = nonEmpty(value, 'worker write scope').trim().split('\\').join('/')
  const trimmed = text.replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (trimmed.length === 0 || trimmed === '.') {
    throw new TypeError('a worker write scope must name a file or directory, not the whole workspace')
  }
  return trimmed
}

/** Whether two normalized scopes cover any of the same files. */
function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/** Cut text to a byte budget without splitting a UTF-16 surrogate pair. */
function truncate(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.byteLength <= maxBytes) return text
  const kept = new TextDecoder('utf-8', { fatal: false })
    .decode(encoded.subarray(0, maxBytes))
    .replace(/�$/, '')
  return `${kept}… (truncated)`
}
