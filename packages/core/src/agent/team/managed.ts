/** Codex-style dynamic worker creation and delegation over AgentTeam. */

import { awaitManagedWorker } from './managed-await.ts'
import { ManagedModelSurface } from './managed-model-surface.ts'
import { ManagedModelInput } from './managed-model-input.ts'
import { ManagedLazyTools } from './managed-lazy-tools.ts'
import { leanControlTools, leanLeadInstructions } from './managed-model-tools.ts'
import { ManagedTeamCollaboration } from './managed-collaboration.ts'
import { filterToolsByDepth } from './managed-capabilities.ts'
import type { TeamPort } from './contracts.ts'
import { ManagedSettlements } from './managed-settlements.ts'
import { createUserMessage } from '../../message/index.ts'
import {
  type AgentInput, type AgentInvocationOptions, type AgentResponse, type AgentSession,
} from '../define/session.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { AgentTeam } from './team.ts'
import { managedLeadInstructions, managedControlTools, managedRoleSchema } from './managed-controls.ts'
import { managedWorkerView } from './managed-reports.ts'
import { ManagedWorkerSpawning } from './managed-spawn.ts'
import { ManagedWorkerExecution } from './managed-worker.ts'
import { closeManagedWorker } from './managed-close.ts'
import { ManagedWorkerScheduling } from './managed-scheduling.ts'
import { joinManagedTeam } from './managed-join.ts'
import { ManagedLeadCoordination } from './managed-lead.ts'
export { DEFAULT_HOLD_WAIT_MS, DEFAULT_SPAWN_SETUP_TIMEOUT_MS,
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS } from './managed-config.ts'
import type {
  ManagedAgentRole, ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest, ManagedAgentWorkerResult,
  ManagedAgentWorkerStatus, ManagedAgentWorker, ManagedAgentTeamOptions, WorkerRuntime,
} from './managed-types.ts'
export type {
  ManagedAgentSpawnContext, ManagedAgentRole, WriteScopeConflictPolicy,
  ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest,
  ManagedAgentWorkerResult, ManagedAgentWorkerStatus, ManagedAgentWorker, ManagedAgentTeamOptions,
} from './managed-types.ts'
import { memberName, positiveInteger } from './managed-validation.ts'
import { mergeTools } from './managed-tool-input.ts'
import { abortable, combineSignals } from './managed-cancellation.ts'
import { managedTimeouts, managedRoles, managedControlPlane } from './managed-options.ts'
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
  readonly collaboration: ManagedTeamCollaboration | undefined
  private readonly modelInput: ManagedModelInput
  private readonly modelSurface: ManagedModelSurface
  private readonly lazyTools = new ManagedLazyTools()
  private readonly sessionTeam: TeamPort
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
    readonly controller: AbortController
  }>()
  private readonly lifecycle = new AbortController()
  private readonly closingWorkers = new Set<Promise<ManagedAgentWorkerStatus>>()
  private disposeTask: Promise<void> | undefined
  private readonly maxDependencyReportBytes: number
  private readonly unguardWake: () => void
  private readonly settlements: ManagedSettlements
  private joining = false
  private invocation: { signal: AbortSignal | undefined; workers: Set<WorkerRuntime> } | undefined
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
    this.modelInput = this.createModelInput()
    this.modelSurface = this.createModelSurface(options)
    this.collaboration = this.createCollaboration(options)
    this.sessionTeam = this.collaboration ?? this.basePort()
    this.scheduling = new ManagedWorkerScheduling({
      options, team: this.team, signal: this.lifecycle.signal, workers: this.workerRuntimes,
      preparing: () => this.preparing.values(), startWorker: runtime => this.execution.startWorker(runtime),
      hasInputs: runtime => this.modelInput.outstanding().some(job => job.name === runtime.request.name),
    })
    this.settlements = new ManagedSettlements({
      options, team: this.team, leadName: this.leadName, signal: this.lifecycle.signal,
      workers: this.workerRuntimes, lead: () => this.lead, joining: () => this.joining,
      invocationSignal: () => this.invocation?.signal,
      releaseDependents: runtime => this.scheduling.releaseDependents(runtime),
    })
    this.leadCoordination = new ManagedLeadCoordination({
      onLeadEnd: (canContinue: boolean) => this.collaboration?.onLeadEnd(canContinue, this.invocation?.signal),
      shouldYield: () => options.autoLeadCoordination !== false && !this.lead.hasUnansweredInput()
        && (this.preparing.size > 0 || this.modelInput.outstanding().length > 0
          || [...this.workerRuntimes.values()].some(runtime => this.workerBusy(runtime))),
      deferReports: () => this.settlements.deferReports(),
      flushReports: () => this.settlements.flushReports(),
    })
    this.execution = new ManagedWorkerExecution({
      options, team: this.team, signal: this.lifecycle.signal, workerRuntimes: this.workerRuntimes,
      leadName: this.leadName, workerTimeoutMs: this.workerTimeoutMs, observerTimeoutMs: this.observerTimeoutMs,
      spawnTimeoutMs: this.spawnTimeoutMs, maxDependencyReportBytes: this.maxDependencyReportBytes,
      notifyLead: runtime => this.settlements.notify(runtime),
      releaseDependents: runtime => this.scheduling.releaseDependents(runtime),
    })
    this.spawning = new ManagedWorkerSpawning({
      options, team: this.team, signal: this.lifecycle.signal, workerRuntimes: this.workerRuntimes,
      sessionTeam: this.sessionTeam, collaboration: this.collaboration,
      workerBusy: runtime => this.workerBusy(runtime),
      preparing: this.preparing, roles: this.roles, maxWorkers: this.maxWorkers,
      maxTaskBytes: this.maxTaskBytes, maxSpecialtyBytes: this.maxSpecialtyBytes,
      spawnTimeoutMs: this.spawnTimeoutMs, maxDependencyReportBytes: this.maxDependencyReportBytes,
      leadName: this.leadName, execution: this.execution, scheduling: this.scheduling, lead: () => this.lead,
    })
    this.lead = this.createLeadSession(options)
    this.unguardWake = this.team.guardWake(target => this.admitFollowup(target))
  }
  private basePort(): TeamPort {
    return this.options.modelToolSurface === 'legacy' ? this.team : this.modelSurface.port
  }
  private createModelInput(): ManagedModelInput {
    const options = this.options
    return new ManagedModelInput({
      team: this.team, signal: this.lifecycle.signal, timeoutMs: this.workerTimeoutMs,
      maxPendingInputs: positiveInteger(options.maxPendingInputs ?? 64, 'maxPendingInputs'),
      worker: name => this.workerRuntimes.get(name),
      run: (runtime, signal) => this.execution.runInput(runtime, signal),
      report: runtime => this.settlements.notify(runtime),
      releaseDependents: runtime => this.scheduling.releaseDependents(runtime),
      admit: runtime => this.admitFollowup(runtime.request.name),
    })
  }
  private createModelSurface(options: ManagedAgentTeamOptions): ManagedModelSurface {
    return new ManagedModelSurface({ team: this.team, options, input: this.modelInput,
      filterCatalog: (sender, catalog) => sender === this.leadName ? this.lazyTools.filter(catalog, options) : catalog,
      worker: name => this.workerRuntimes.get(name),
      ...(options.collaboration ? { peerSend: (sender: string, target: string, message: string,
        delivery: { signal: AbortSignal; interrupt: boolean }) =>
        this.collaboration!.sendInput(sender, target, message, delivery) } : {}),
    })
  }
  private createCollaboration(options: ManagedAgentTeamOptions): ManagedTeamCollaboration | undefined {
    const basePort = this.basePort()
    return !options.collaboration ? undefined
      : new ManagedTeamCollaboration(options.collaboration === true ? {} : options.collaboration, {
        team: this.team, basePort, lead: this.leadName, signal: this.lifecycle.signal,
        workerTimeoutMs: this.workerTimeoutMs,
        redirect: (sender, target, message) => this.modelInput.enqueue(sender, target, message, true),
        joinMembers: signal => this.joinMembers(signal),
        initialWork: () => [...[...this.workerRuntimes.values()].filter(runtime => this.workerBusy(runtime))
          .map(runtime => runtime.settled), ...[...this.preparing.values()].map(prepared => prepared.settled)],
        cancelMembers: (reason, activeOnly) => this.cancelCollaborationMembers(reason, activeOnly),
        injectLead: text => this.lead.inject(createUserMessage({ source: { kind: 'app', producer: 'managed-team' },
          content: [{ type: 'text', text }] })),
      })
  }

  private workerBusy(runtime: WorkerRuntime): boolean {
    return !runtime.settledComplete || this.scheduling.workerHasWork(runtime)
      || this.modelInput.outstanding().some(job => job.name === runtime.request.name)
  }

  private async joinMembers(signal?: AbortSignal): Promise<void> {
    const outstanding = [...this.workerRuntimes.values()].filter(runtime => this.workerBusy(runtime))
    await abortable(Promise.all([
      ...outstanding.map(async runtime => {
        await this.modelInput.whenIdle(runtime.request.name, signal)
        await runtime.settled
      }),
      ...[...this.preparing.values()].map(prepared => prepared.settled),
    ]), signal)
  }

  private async cancelCollaborationMembers(reason: unknown, activeOnly = false): Promise<void> {
    const members = new Map(this.team.members().map(member => [member.name, member]))
    const workers = [...this.workerRuntimes.values()].filter(runtime => !activeOnly || !runtime.settledComplete
      || runtime.session.isRunning || members.get(runtime.request.name)?.status === 'running')
    const preparing = [...this.preparing.values()]
    for (const runtime of workers) runtime.closing = true
    for (const prepared of preparing) prepared.controller.abort(reason)
    await Promise.allSettled([
      ...workers.map(runtime => this.closeWorker(runtime.request.name, reason)),
      ...preparing.map(prepared => prepared.settled),
    ])
  }

  private leadTools(options: ManagedAgentTeamOptions): ReturnType<typeof mergeTools> {
    const tools = mergeTools(options.leadSessionOptions?.tools, this.controlTools())
    return mergeTools(undefined, filterToolsByDepth(tools.names().map(name => tools.get(name)!), options))
  }

  private createLeadSession(options: ManagedAgentTeamOptions): AgentSession {
    return options.lead.createSession({
      ...options.leadSessionOptions,
      runtimeLimits: { ...options.leadSessionOptions?.runtimeLimits,
        finalizeSteps: options.leadSessionOptions?.runtimeLimits?.finalizeSteps ?? 0 },
      hooks: this.leadCoordination.hooks(options.leadSessionOptions?.hooks),
      registry: options.registry,
      tools: this.leadTools(options),
      team: {
        team: this.sessionTeam,
        name: this.leadName,
        role: 'lead',
        instructions: options.modelToolSurface === 'legacy'
          ? managedLeadInstructions(options) : leanLeadInstructions(options),
        ...(options.leadDescription === undefined ? {} : { description: options.leadDescription }),
      },
    })
  }

  private admitFollowup(target: string): void {
    const runtime = this.workerRuntimes.get(target)
    if (runtime === undefined || this.workerBusy(runtime)) return
    const busy = [...this.workerRuntimes.values()].filter(worker => this.workerBusy(worker)).length
      + this.preparing.size
    if (busy >= this.maxWorkers) throw new Error(`managed agent team reached its ${this.maxWorkers}-worker limit`)
    this.scheduling.checkWriteScopes(runtime.request, [])
    this.invocation?.workers.add(runtime)
  }

  async run(input: AgentInput, invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    this.lifecycle.signal.throwIfAborted()
    if (this.invocation !== undefined) throw new Error('managed lead is already running')
    const owned = { signal: invocation.signal, workers: new Set<WorkerRuntime>() }
    this.invocation = owned
    this.settlements.latestResponse = undefined
    this.settlements.leadFailure = undefined
    this.joining = this.options.autoLeadCoordination !== false
    this.settlements.resumeReports()
    try {
      const execute = () => this.lead.run(input, invocation)
      const response = this.collaboration === undefined ? await execute()
        : await this.collaboration.runLead(execute, combineSignals(invocation.signal, this.lifecycle.signal))
      if (!this.joining) return response
      await this.whenQuiet(combineSignals(invocation.signal, this.lifecycle.signal))
      this.settlements.throwLeadFailure()
      return this.settlements.latestResponse ?? response
    } finally {
      this.joining = false
      if (invocation.signal?.aborted === true) {
        void this.team.cancel(this.leadName, invocation.signal.reason).catch(() => undefined)
        await Promise.allSettled([...owned.workers].map(runtime =>
          this.closeWorker(runtime.request.name, invocation.signal!.reason)))
      }
      this.invocation = undefined
    }
  }

  steer(text: string): boolean {
    this.lifecycle.signal.throwIfAborted()
    this.lead.inject(text)
    this.settlements.resumeReports()
    try { this.team.notifySteer(this.leadName) } catch { /* team disposed */ }
    if (!this.lead.isRunning) {
      try { this.team.wake(this.leadName) } catch { /* team disposed */ }
    }
    return true
  }

  async spawn(request: ManagedAgentSpawnRequest, signal?: AbortSignal): Promise<ManagedAgentWorker> {
    const worker = await this.spawning.spawn(request, signal)
    this.lazyTools.disclose()
    return worker
  }

  async whenQuiet(signal?: AbortSignal): Promise<void> {
    return joinManagedTeam({
      settlements: this.settlements, team: this.team, leadName: this.leadName, lead: () => this.lead,
      workers: () => [...this.workerRuntimes.values()], preparing: () => [...this.preparing.values()],
      workerBusy: runtime => this.workerBusy(runtime), hasInputs: () => this.modelInput.outstanding().length > 0,
      needsSynthesis: () => this.needsSynthesis(), closing: () => [...this.closingWorkers],
      joinMembers: signal => this.joinMembers(signal),
      joinCollaboration: signal => this.collaboration?.onLeadEnd(true, signal),
    }, signal)
  }

  private needsSynthesis(): boolean {
    return this.options.autoLeadCoordination !== false && this.lead.lastOutcome()?.yielded === true
  }

  workers(): readonly ManagedAgentWorker[] {
    return Object.freeze([...this.workerRuntimes.values()].map(runtime => managedWorkerView(runtime)))
  }

  async awaitWorker(
    name: string,
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ManagedAgentWorkerResult | undefined> {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    return awaitManagedWorker(runtime, options)
  }

  async closeWorker(
    name: string,
    reason: unknown = new Error('managed worker closed'),
  ): Promise<ManagedAgentWorkerStatus> {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    runtime.closing = true
    this.collaboration?.closeMember(address)
    this.modelInput.cancel(address)
    runtime.closeTask ??= this.closeAndReport(runtime, reason)
    return runtime.closeTask

  }

  private closeAndReport(runtime: WorkerRuntime, reason: unknown): Promise<ManagedAgentWorkerStatus> {
    const task = closeManagedWorker(runtime, reason, {
      team: this.team, scheduling: this.scheduling, closeTimeoutMs: this.closeTimeoutMs,
      workerRuntimes: this.workerRuntimes,
    }).then(async previous => {
      if (previous === 'pending' || previous === 'running') this.settlements.pending(runtime)
      if (await this.settlements.flushReports()) this.settlements.wakeForReport(runtime)
      return previous
    }).finally(() => { this.closingWorkers.delete(task) })
    this.closingWorkers.add(task)
    return task
  }

  dispose(reason: unknown = new Error('managed agent team disposed')): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.lifecycle.abort(reason)
    this.settlements.dispose()
    this.unguardWake()
    const names = [...this.workerRuntimes.keys()]
    this.disposeTask = Promise.allSettled([
      ...[...this.preparing.values()].map(prepared => prepared.settled),
      ...names.map(name => this.closeWorker(name, reason)),
      ...this.modelInput.outstanding().map(job => job.settled),
    ]).then(() => undefined)
    return this.disposeTask
  }

  removeWorker(name: string): void {
    const address = memberName(name)
    const runtime = this.workerRuntimes.get(address)
    if (runtime === undefined) throw new Error(`unknown managed worker '${address}'`)
    if (this.workerBusy(runtime)
      || runtime.session.isRunning) {
      throw new Error(`cannot remove running managed worker '${address}'`)
    }
    this.collaboration?.closeMember(address)
    this.team.detach(address)
    this.workerRuntimes.delete(address)
  }

  private controlTools(): readonly ToolDefinition<any>[] {
    const controls = this.options.modelToolSurface === 'legacy' ? managedControlTools : leanControlTools
    return controls({
      options: this.options, spawnTimeoutMs: this.spawnTimeoutMs, workerTimeoutMs: this.workerTimeoutMs,
      roleSchema: () => managedRoleSchema(this.roles),
      spawn: async (request, signal) => {
        const owner = this.invocation
        const worker = await this.spawn(request, signal)
        const runtime = this.workerRuntimes.get(worker.name)
        if (runtime !== undefined) owner?.workers.add(runtime)
        return worker
      },
      workerBusy: name => this.modelInput.outstanding().some(job => job.name === name),
      workerRuntime: name => this.workerRuntimes.get(name),
      closeWorker: name => this.closeWorker(name),
    })
  }
}

export function createManagedAgentTeam(options: ManagedAgentTeamOptions): ManagedAgentTeam {
  return new ManagedAgentTeam(options)
}
