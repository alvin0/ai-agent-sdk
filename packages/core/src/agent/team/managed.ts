/** Codex-style dynamic worker creation and delegation over AgentTeam. */

import { timeoutValue } from '../../platform/config.ts'
import {
  type AgentInput,
  type AgentInvocationOptions,
  type AgentResponse,
  type AgentSession,
} from '../define/session.ts'
import { managedTeamNoticeRequest } from '../history/input-work.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { AgentTeam } from './team.ts'
import { DEFAULT_WAIT_TIMEOUT_MS } from './common.ts'
import { LEAD_INSTRUCTIONS, managedControlTools, managedRoleSchema } from './managed-controls.ts'
import { managedWorkerView } from './managed-reports.ts'
import { ManagedWorkerSpawning } from './managed-spawn.ts'
import { ManagedWorkerExecution } from './managed-worker.ts'
import { closeManagedWorker } from './managed-close.ts'
import { ManagedWorkerScheduling } from './managed-scheduling.ts'
import { ManagedLeadCoordination } from './managed-lead.ts'
export {
  DEFAULT_HOLD_WAIT_MS, DEFAULT_SPAWN_SETUP_TIMEOUT_MS, DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
} from './managed-config.ts'
import type {
  ManagedAgentRole, ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest, ManagedAgentWorkerResult,
  ManagedAgentWorkerStatus, ManagedAgentWorker, ManagedAgentTeamOptions, WorkerRuntime,
} from './managed-types.ts'
export type {
  ManagedAgentSpawnContext, ManagedAgentRole, WriteScopeConflictPolicy,
  ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest,
  ManagedAgentWorkerResult, ManagedAgentWorkerStatus, ManagedAgentWorker, ManagedAgentTeamOptions,
} from './managed-types.ts'
import {
  memberName, positiveInteger,
} from './managed-validation.ts'
import {
  mergeTools,
} from './managed-tool-input.ts'
import {
  abortable, combineSignals,
} from './managed-cancellation.ts'
import {
  truncate,
} from './managed-report-text.ts'
import {
  managedTimeouts, managedRoles, managedControlPlane,
} from './managed-options.ts'
export { completedHistoryPrefix } from './managed-support.ts'

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
  private readonly leadCoordination: ManagedLeadCoordination
  private readonly spawnTimeoutMs: number
  private readonly workerRuntimes = new Map<string, WorkerRuntime>()
  private readonly spawning: ManagedWorkerSpawning
  private readonly execution: ManagedWorkerExecution
  private readonly scheduling: ManagedWorkerScheduling
  private readonly preparing = new Map<string, {
    readonly request: ResolvedManagedAgentSpawnRequest
    readonly dependencies: readonly WorkerRuntime[]
    readonly settled: Promise<void>
  }>()
  private readonly lifecycle = new AbortController()
  private disposeTask: Promise<void> | undefined
  private readonly maxDependencyReportBytes: number
  private readonly roles: Map<string, ManagedAgentRole>

  constructor(options: ManagedAgentTeamOptions) {
    this.options = options
    this.maxWorkers = positiveInteger(options.maxWorkers ?? 7, 'maxWorkers')
    this.maxTaskBytes = positiveInteger(options.maxTaskBytes ?? 64 * 1024, 'maxTaskBytes')
    this.maxSpecialtyBytes = positiveInteger(options.maxSpecialtyBytes ?? 8 * 1024, 'maxSpecialtyBytes')
    const timeouts = managedTimeouts(options)
    this.workerTimeoutMs = timeouts.workerTimeoutMs
    this.observerTimeoutMs = timeouts.observerTimeoutMs
    this.closeTimeoutMs = timeouts.closeTimeoutMs
    this.spawnTimeoutMs = timeouts.spawnTimeoutMs
    this.maxDependencyReportBytes = positiveInteger(
      options.maxDependencyReportBytes ?? 8 * 1024,
      'maxDependencyReportBytes',
    )
    if (this.maxDependencyReportBytes < 4) throw new TypeError('maxDependencyReportBytes must be at least 4')
    this.roles = managedRoles(options)
    this.team = managedControlPlane(options, this.maxWorkers)
    this.leadName = memberName(options.leadName ?? options.lead.id)
    this.scheduling = new ManagedWorkerScheduling({
      options, team: this.team, signal: this.lifecycle.signal, workers: this.workerRuntimes,
      preparing: () => this.preparing.values(), startWorker: runtime => this.execution.startWorker(runtime),
    })
    this.leadCoordination = new ManagedLeadCoordination({
      options, team: this.team, leadName: this.leadName,
      holdWaitMs: timeouts.holdWaitMs, signal: this.lifecycle.signal,
      workers: () => this.workerRuntimes.values(), lead: () => this.lead,
    })
    this.execution = new ManagedWorkerExecution({
      options, team: this.team, signal: this.lifecycle.signal, workerRuntimes: this.workerRuntimes,
      leadName: this.leadName, workerTimeoutMs: this.workerTimeoutMs, observerTimeoutMs: this.observerTimeoutMs,
      spawnTimeoutMs: this.spawnTimeoutMs, maxDependencyReportBytes: this.maxDependencyReportBytes,
      notifyLead: (runtime, summary) => this.notifyLead(runtime, summary),
      releaseDependents: runtime => this.scheduling.releaseDependents(runtime),
    })
    this.spawning = new ManagedWorkerSpawning({
      options, team: this.team, signal: this.lifecycle.signal, workerRuntimes: this.workerRuntimes,
      preparing: this.preparing, roles: this.roles, maxWorkers: this.maxWorkers,
      maxTaskBytes: this.maxTaskBytes, maxSpecialtyBytes: this.maxSpecialtyBytes,
      spawnTimeoutMs: this.spawnTimeoutMs, maxDependencyReportBytes: this.maxDependencyReportBytes,
      leadName: this.leadName, execution: this.execution, scheduling: this.scheduling, lead: () => this.lead,
    })
    this.lead = this.createLeadSession(options)
  }

  private createLeadSession(options: ManagedAgentTeamOptions): AgentSession {
    return options.lead.createSession({
      ...options.leadSessionOptions,
      // A lead's forced answer must not be confirmed in a tool-less window
      // while its workers may still report: their results could only arrive
      // after a synthesis already declared complete. Hosts can opt back in.
      runtimeLimits: { ...options.leadSessionOptions?.runtimeLimits,
        finalizeSteps: options.leadSessionOptions?.runtimeLimits?.finalizeSteps ?? 0 },
      hooks: this.leadCoordination.hooks(options.leadSessionOptions?.hooks),
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
    this.leadCoordination.interruptWait()
    // Ends a wait the lead is parked in, so the correction is read now rather
    // than after its wait budget expires.
    try { this.team.notifySteer(this.leadName) } catch { /* team disposed */ }
    if (!this.lead.isRunning) {
      try { this.team.wake(this.leadName) } catch { /* team disposed */ }
    }
    return true
  }

  /** Prepare a specialized worker and begin its independent work. */
  spawn(request: ManagedAgentSpawnRequest, signal?: AbortSignal): Promise<ManagedAgentWorker> {
    return this.spawning.spawn(request, signal)
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
    return managedRoleSchema(this.roles)
  }

  /**
   * Tell the lead what one of its workers did.
   *
   * Quiet WHILE THE LEAD IS STILL IN ITS TURN: the report appends to history
   * and the next model round rebuilds its request from history, so the lead
   * reads it without an extra turn being scheduled. Holding that turn open is
   * the lead's turn hooks's job.
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
    if (delivery === 'quiet') this.leadCoordination.markUnread()
    try {
      const signal = combineSignals(runtime.controller.signal, this.lifecycle.signal,
        AbortSignal.timeout(this.spawnTimeoutMs))
      await abortable(this.team.sendMessage(managedTeamNoticeRequest({
        from: worker,
        target: this.leadName,
        message: `Worker '${worker}' ${truncate(summary, Math.min(this.maxDependencyReportBytes,
          Math.max(64, Math.floor(this.team.messageByteLimit / 4))))}`,
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
    return Object.freeze([...this.workerRuntimes.values()].map(runtime => managedWorkerView(runtime)))
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
    runtime.closeTask ??= Promise.resolve().then(() => closeManagedWorker(runtime, reason, {
      team: this.team, scheduling: this.scheduling, closeTimeoutMs: this.closeTimeoutMs,
      workerRuntimes: this.workerRuntimes,
    }))
    return runtime.closeTask
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
    if (runtime.status === 'pending' || runtime.status === 'running' || !runtime.settledComplete
      || runtime.session.isRunning) {
      throw new Error(`cannot remove running managed worker '${address}'`)
    }
    this.team.detach(address)
    this.workerRuntimes.delete(address)
  }

  private controlTools(): readonly ToolDefinition<any>[] {
    return managedControlTools({
      options: this.options, spawnTimeoutMs: this.spawnTimeoutMs, workerTimeoutMs: this.workerTimeoutMs,
      roleSchema: () => this.roleSchema(),
      spawn: (request, signal) => this.spawn(request, signal),
      workerRuntime: name => this.workerRuntimes.get(name),
      closeWorker: name => this.closeWorker(name),
    })
  }


}

export function createManagedAgentTeam(options: ManagedAgentTeamOptions): ManagedAgentTeam {
  return new ManagedAgentTeam(options)
}
