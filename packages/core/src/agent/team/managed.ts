/** Codex-style dynamic worker creation and delegation over AgentTeam. */
import { guardManagedCoordination } from './managed-guards.ts'
import { evictRetainedWorkers } from './managed-retention.ts'
import type { TeamSnapshot } from './team-timeline.ts'
import { recordTeamTimeline } from './team-observation-internal.ts'
import { createManagedLeadSession } from './managed-lead-session.ts'
import { awaitManagedWorker } from './managed-await.ts'
import { ManagedModelSurface } from './managed-model-surface.ts'
import { ManagedModelInput } from './managed-model-input.ts'
import { hasSuccessfulTeamSpawn, ManagedLazyTools } from './managed-lazy-tools.ts'
import { ManagedTeamCollaboration } from './managed-collaboration.ts'
import { assertWorkerToolInheritance, filterToolsByDepth } from './managed-capabilities.ts'
import type { TeamPort } from './contracts.ts'
import { ManagedSettlements } from './managed-settlements.ts'
import { createUserMessage } from '../../message/index.ts'
import type { AgentInput, AgentInvocationOptions, AgentResponse, AgentSession } from '../define/session.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import { AgentTeam } from './team.ts'
import { managedTools } from './managed-tools.ts'
import { ManagedProgress } from './managed-progress.ts'
import type { TeamProgressHostStopReason } from './team-progress.ts'
import { managedWorkerView } from './managed-reports.ts'
import { ManagedWorkerSpawning } from './managed-spawn.ts'
import { ManagedWorkerExecution } from './managed-worker.ts'
import { closeManagedWorker } from './managed-close.ts'
import { ManagedWorkerScheduling } from './managed-scheduling.ts'
import { joinManagedTeam } from './managed-join.ts'
import { finishManagedRun, managedFinishingSignal } from './managed-run-finish.ts'
import { ManagedLeadCoordination } from './managed-lead.ts'
export { DEFAULT_SPAWN_SETUP_TIMEOUT_MS,
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
import { hookTimeout } from '../loop/turn/hooks.ts'
import { managedLimits, managedRoles, managedControlPlane } from './managed-options.ts'
export { completedHistoryPrefix } from './managed-support.ts'
/** Dynamic worker harness. Dependencies retain producer identity across address closure. */
export class ManagedAgentTeam {
  readonly team: AgentTeam
  readonly lead: AgentSession
  readonly leadName: string
  readonly collaboration: ManagedTeamCollaboration | undefined
  private readonly progress: ManagedProgress
  private readonly modelInput: ManagedModelInput
  private readonly modelSurface: ManagedModelSurface
  private readonly lazyTools = new ManagedLazyTools()
  private readonly sessionTeam: TeamPort
  private readonly leadCoordination: ManagedLeadCoordination
  private readonly workerRuntimes = new Map<string, WorkerRuntime>()
  private readonly spawning: ManagedWorkerSpawning
  private readonly execution: ManagedWorkerExecution
  private readonly scheduling: ManagedWorkerScheduling
  private readonly preparing = new Map<string, {
    readonly request: ResolvedManagedAgentSpawnRequest
    readonly dependencies: readonly WorkerRuntime[]
    readonly settled: Promise<void>
    readonly controller: AbortController
    queued: boolean
  }>()
  private readonly lifecycle = new AbortController()
  private readonly closingWorkers = new Set<Promise<ManagedAgentWorkerStatus>>()
  private disposeTask: Promise<void> | undefined
  private readonly unguardWake: () => void
  private readonly settlements: ManagedSettlements
  private joining = false
  private finishingSignal: AbortSignal | undefined // Suppress aborted settlement wakes during cleanup.
  private invocation: { signal: AbortSignal | undefined; workers: Set<WorkerRuntime> } | undefined
  private readonly roles: Map<string, ManagedAgentRole>
  private readonly limits: ReturnType<typeof managedLimits>
  constructor(private readonly options: ManagedAgentTeamOptions) {
    this.limits = managedLimits(options)
    assertWorkerToolInheritance(options)
    this.roles = managedRoles(options)
    this.team = managedControlPlane(options, this.limits.maxWorkers)
    this.leadName = memberName(options.leadName ?? options.lead.id)
    this.progress = this.createProgress(options)
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
      invocationSignal: () => this.invocation !== undefined ? this.invocation.signal : this.finishingSignal,
      releaseDependents: runtime => this.releaseDependents(runtime),
    })
    this.leadCoordination = new ManagedLeadCoordination({
      onLeadEnd: (canContinue: boolean) => this.collaboration?.onLeadEnd(canContinue, this.invocation?.signal),
      shouldYield: () => options.autoLeadCoordination !== false && !this.lead.hasUnansweredInput()
        && (this.preparing.size > 0 || this.modelInput.outstanding().length > 0
          || [...this.workerRuntimes.values()].some(runtime => this.workerBusy(runtime))),
      deferReports: () => this.settlements.deferReports(),
      flushReports: () => this.settlements.flushReports(),
      yielded: reason => recordTeamTimeline(this.team, { kind: 'lead-yielded', member: this.leadName, reason }),
    })
    this.execution = new ManagedWorkerExecution({
      options, team: this.team, signal: this.lifecycle.signal, workerRuntimes: this.workerRuntimes,
      leadName: this.leadName, workerTimeoutMs: this.limits.workerTimeoutMs,
      observerTimeoutMs: this.limits.observerTimeoutMs,
      spawnTimeoutMs: this.limits.spawnTimeoutMs, maxDependencyReportBytes: this.limits.maxDependencyReportBytes,
      notifyLead: runtime => this.settlements.notify(runtime),
      releaseDependents: runtime => this.releaseDependents(runtime),
    })
    this.spawning = new ManagedWorkerSpawning({
      options, team: this.team, signal: this.lifecycle.signal, workerRuntimes: this.workerRuntimes,
      sessionTeam: this.sessionTeam, collaboration: this.collaboration,
      workerBusy: runtime => this.workerBusy(runtime), accepted: () => this.accepted(),
      preparing: this.preparing, roles: this.roles, ...this.limits,
      leadName: this.leadName, execution: this.execution, scheduling: this.scheduling, lead: () => this.lead,
    })
    this.lead = this.createLeadSession(options)
    this.unguardWake = this.guardCoordination()
  }
  private accepted(): void {
    this.lazyTools.disclose()
    evictRetainedWorkers({ team: this.team, leadName: this.leadName, limit: this.limits.maxRetainedWorkers,
      workers: this.workerRuntimes, remove: name => this.removeWorker(name),
      evictable: runtime => !runtime.closing && !this.settlements.isPending(runtime) && !this.workerBusy(runtime) })
  }
  private guardCoordination(): () => void { // Followups and peer waits respect admission and queue state.
    return guardManagedCoordination(this.team, this.leadName, target => this.admitFollowup(target),
      target => this.preparing.get(target)?.queued === true) }
  private createProgress(options: ManagedAgentTeamOptions): ManagedProgress {
    return new ManagedProgress({ team: this.team, lead: this.leadName, signal: this.lifecycle.signal,
      session: () => this.lead, workers: () => [...this.workerRuntimes.keys(), ...this.preparing.keys()],
      busy: name => this.preparing.has(name) || (this.workerRuntimes.has(name)
        && this.workerBusy(this.workerRuntimes.get(name)!)),
    }, options.progressUpdates)
  }
  private async releaseDependents(runtime: WorkerRuntime): Promise<void> {
    await this.scheduling.releaseDependents(runtime)
    this.spawning.drainQueue()
  }
  private basePort(): TeamPort {
    return this.options.modelToolSurface === 'legacy' ? this.team : this.modelSurface.port
  }
  private createModelInput(): ManagedModelInput {
    const options = this.options
    return new ManagedModelInput({
      team: this.team, signal: this.lifecycle.signal, timeoutMs: this.limits.workerTimeoutMs,
      maxPendingInputs: positiveInteger(options.maxPendingInputs ?? 64, 'maxPendingInputs'),
      worker: name => this.workerRuntimes.get(name),
      run: (runtime, signal) => this.execution.runInput(runtime, signal),
      report: runtime => this.settlements.notify(runtime),
      releaseDependents: runtime => this.releaseDependents(runtime),
      admit: runtime => this.admitFollowup(runtime.request.name),
    })
  }
  private createModelSurface(options: ManagedAgentTeamOptions): ManagedModelSurface {
    return new ManagedModelSurface({ team: this.team, options, input: this.modelInput,
      worker: name => this.workerRuntimes.get(name),
      resume: targets => this.settlements.resumeCaptured(targets),
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
        workerTimeoutMs: this.limits.workerTimeoutMs,
        leadHookTimeoutMs: hookTimeout(options.leadSessionOptions?.runtimeLimits?.hookTimeoutMs),
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
    return createManagedLeadSession(options, {
      team: this.team, name: this.leadName, port: this.sessionTeam, tools: this.leadTools(options),
      hooks: this.leadCoordination.hooks(options.leadSessionOptions?.hooks),
      filterCatalog: catalog => this.lazyTools.filter(catalog, options, () =>
        this.team.members().some(member => member.name !== this.leadName)
          || hasSuccessfulTeamSpawn(this.lead.history.entries())),
    })
  }
  private admitFollowup(target: string): void {
    const runtime = this.workerRuntimes.get(target)
    if (runtime === undefined || this.workerBusy(runtime)) return
    this.spawning.drainQueue()
    const busy = this.spawning.busy
    const max = this.limits.maxWorkers
    if (busy >= max) throw new Error(`managed agent team reached its ${max}-worker limit`)
    this.scheduling.checkWriteScopes(runtime.request, [])
    this.invocation?.workers.add(runtime)
  }
  private leadBusy(): boolean { return this.invocation !== undefined || this.lead.isRunning }
  async run(input: AgentInput, invocation: AgentInvocationOptions = {}): Promise<AgentResponse> {
    this.lifecycle.signal.throwIfAborted()
    if (this.leadBusy()) throw new Error('managed lead is already running')
    // A failed run aborts its own signal too, so queued and still-starting model spawns never start.
    const failure = new AbortController(),
      owned = { signal: combineSignals(invocation.signal, failure.signal), workers: new Set<WorkerRuntime>() }
    const signal = combineSignals(invocation.signal, this.lifecycle.signal)
    let progressOwner: ReturnType<ManagedProgress['beginManagedInvocation']> | null = null
    let failed: { error: unknown } | undefined
    try {
      this.invocation = owned
      progressOwner = this.progress.beginManagedInvocation(signal)
      this.settlements.latestResponse = undefined
      this.settlements.leadFailure = undefined
      this.joining = this.options.autoLeadCoordination !== false
      this.settlements.resumeReports()
      const execute = () => this.lead.run(input, { ...invocation, signal })
      const response = this.collaboration === undefined ? await execute()
        : await this.collaboration.runLead(execute, signal)
      this.finalBoundary('lead-returned')
      if (!this.joining) return response
      await this.whenQuiet(signal)
      this.settlements.throwLeadFailure()
      this.finalBoundary('team-joined')
      return this.settlements.latestResponse ?? response
    } catch (error: unknown) {
      failed = { error }
      throw error
    } finally {
      this.invocation = undefined
      const finishing = managedFinishingSignal(signal, failed)
      this.finishingSignal = finishing
      if (finishing !== signal) failure.abort(finishing.reason)
      this.joining = false
      await finishManagedRun({ cancelLead: reason => this.team.cancel(this.leadName, reason),
        closeWorker: (name, reason) => this.closeWorker(name, reason), workerBusy: runtime => this.workerBusy(runtime),
        finishProgress: aborted => this.progress.finishInvocation(aborted ? 'aborted' : 'run-ended', progressOwner),
      }, signal, finishing, owned.workers)
      if (this.finishingSignal === finishing) this.finishingSignal = undefined
    }
  }
  private finalBoundary(kind: 'lead-returned' | 'team-joined'): void {
    recordTeamTimeline(this.team, { kind, member: this.leadName,
      busy: [...this.workerRuntimes.values()].filter(runtime => this.workerBusy(runtime)).length,
      preparing: this.preparing.size })
  }
  steer(text: string): boolean {
    this.lifecycle.signal.throwIfAborted()
    this.progress.stop('steered')
    this.lead.inject(text)
    this.settlements.resumeReports()
    try { this.team.notifySteer(this.leadName) } catch { /* team disposed */ }
    if (!this.lead.isRunning) {
      try { this.team.wake(this.leadName, 'steering') } catch { /* team disposed */ }
    }
    return true
  }
  async spawn(request: ManagedAgentSpawnRequest, signal?: AbortSignal): Promise<ManagedAgentWorker> {
    return this.spawning.spawn(request, signal)
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
  /** Team metadata and completed-run usage, including retained/closed members. */
  snapshot(): TeamSnapshot { return this.team.snapshot() }
  progressUpdates() { return this.progress.state() }
  stopProgressUpdates(reason: TeamProgressHostStopReason = 'host'): void {
    if (!['host', 'run-ended', 'aborted'].includes(reason)) throw new TypeError('invalid host progress stop reason')
    this.progress.stop(reason)
  }
  workers(): readonly ManagedAgentWorker[] {
    return Object.freeze([...this.workerRuntimes.values()].map(runtime => managedWorkerView(runtime)))
  }
  async awaitWorker(name: string, options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}):
  Promise<ManagedAgentWorkerResult | undefined> {
    const runtime = this.workerRuntimes.get(memberName(name))
    if (runtime === undefined) throw new Error(`unknown managed worker '${name}'`)
    return awaitManagedWorker(runtime, options)
  }
  async closeWorker(name: string, reason: unknown = new Error('managed worker closed')):
  Promise<ManagedAgentWorkerStatus> {
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
      team: this.team, scheduling: this.scheduling, closeTimeoutMs: this.limits.closeTimeoutMs,
      workerRuntimes: this.workerRuntimes,
    }).then(async previous => {
      this.spawning.drainQueue()
      if (previous === 'pending' || previous === 'running') this.settlements.pending(runtime)
      // A close is not news while other work that will itself wake the lead is outstanding.
      const wakes = (other: WorkerRuntime) => this.joining || other.leadDriven
      const others = (this.joining && this.preparing.size > 0) || [...this.workerRuntimes.values()]
        .some(other => other !== runtime && this.workerBusy(other) && wakes(other))
      if (await this.settlements.flushReports() && !others) this.settlements.wakeForReport(runtime)
      return previous
    }).finally(() => { this.closingWorkers.delete(task) })
    this.closingWorkers.add(task)
    return task
  }
  dispose(reason: unknown = new Error('managed agent team disposed')): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.progress.dispose()
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
    if (this.workerBusy(runtime) || runtime.session.isRunning) {
      throw new Error(`cannot remove running managed worker '${address}'`)
    }
    this.collaboration?.closeMember(address)
    this.team.detach(address)
    this.workerRuntimes.delete(address)
  }
  private controlTools(): readonly ToolDefinition<any>[] {
    return managedTools({
      options: this.options, team: this.team, leadName: this.leadName, lazyTools: this.lazyTools,
      spawning: this.spawning, settlements: this.settlements, roles: this.roles,
      maxWorkers: this.limits.maxWorkers, maxQueued: this.limits.maxQueued, spawnTimeoutMs: this.limits.spawnTimeoutMs,
      workerTimeoutMs: this.limits.workerTimeoutMs, workers: this.workerRuntimes, owner: () => this.invocation?.workers,
      signal: () => combineSignals(this.lifecycle.signal, this.invocation?.signal),
      spawn: (request, signal) => this.spawn(request, signal), progress: this.progress,
      busy: name => this.modelInput.outstanding().some(job => job.name === name),
      close: name => this.closeWorker(name),
    })
  }
}
export function createManagedAgentTeam(options: ManagedAgentTeamOptions): ManagedAgentTeam {
  return new ManagedAgentTeam(options)
}
