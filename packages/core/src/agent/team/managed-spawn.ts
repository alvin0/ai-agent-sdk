/** Resolves, prepares, and dispatches newly commissioned managed workers. */
import { createTextMessage } from '../../message/index.ts'
import { cloneAgent, type DefinedAgent } from '../define/definition.ts'
import type { AgentSession, AgentSessionOptions } from '../define/session.ts'
import { History } from '../history/index.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import type { AgentTeam } from './team.ts'
import type { ManagedWorkerExecution } from './managed-worker.ts'
import type { ManagedWorkerScheduling } from './managed-scheduling.ts'
import { managedDependencyReadTool } from './managed-dependency-tool.ts'
import { managedWorkerView } from './managed-reports.ts'
import type {
  ManagedAgentRole, ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest,
  ManagedAgentWorker, ManagedAgentTeamOptions, WorkerRuntime,
} from './managed-types.ts'
import {
  mergeTools, spawnContext, memberName, nonEmpty, boundedString, errorMessage,
  abortable, combineSignals, normalizeWriteScope, recordEvidence, completedHistoryPrefix, SETTLED_WORKER_STATUS,
} from './managed-support.ts'

interface ManagedSpawnHost {
  readonly options: ManagedAgentTeamOptions
  readonly team: AgentTeam
  readonly signal: AbortSignal
  readonly workerRuntimes: Map<string, WorkerRuntime>
  readonly preparing: Map<string, {
    readonly request: ResolvedManagedAgentSpawnRequest
    readonly dependencies: readonly WorkerRuntime[]
    readonly settled: Promise<void>
  }>
  readonly roles: ReadonlyMap<string, ManagedAgentRole>
  readonly maxWorkers: number
  readonly maxTaskBytes: number
  readonly maxSpecialtyBytes: number
  readonly spawnTimeoutMs: number
  readonly maxDependencyReportBytes: number
  readonly leadName: string
  readonly execution: ManagedWorkerExecution
  readonly scheduling: ManagedWorkerScheduling
  lead(): AgentSession
}

export class ManagedWorkerSpawning {
  private workerSequence = 0

  constructor(private readonly host: ManagedSpawnHost) {}

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
    this.checkSpawnSignals(signal)
    const resolved = this.resolveSpawnRequest(request)
    const dependencies = resolved.dependsOn.map(name => this.host.workerRuntimes.get(name)!)
    this.assertSpawnAvailable(resolved)

    let markPrepared!: () => void
    const prepared = new Promise<void>(resolve => { markPrepared = resolve })
    this.host.preparing.set(resolved.name, { request: resolved, dependencies, settled: prepared })
    let runtime: WorkerRuntime | undefined
    try {
      const warnings = this.host.scheduling.checkWriteScopes(resolved, dependencies)
      const operationSignal = combineSignals(signal, this.host.signal, AbortSignal.timeout(this.host.spawnTimeoutMs))
      const definition = await abortable(this.workerDefinition(resolved), operationSignal)
      operationSignal.throwIfAborted()
      const scopedSessionOptions = this.host.options.workerSessionOptionsFactory === undefined
        ? undefined
        : await abortable(Promise.resolve(this.host.options.workerSessionOptionsFactory(resolved)), operationSignal)
      operationSignal.throwIfAborted()
      const session = this.createSpawnSession(definition, resolved, dependencies, scopedSessionOptions)
      runtime = this.createSpawnRuntime(resolved, session, { dependencies, warnings })
      this.host.workerRuntimes.set(resolved.name, runtime)
      this.host.preparing.delete(resolved.name)

      const deliverySignal = combineSignals(operationSignal, runtime.controller.signal)
      await abortable(this.host.team.sendMessage({
        from: this.host.leadName,
        target: resolved.name,
        message: resolved.task,
        delivery: 'quiet',
        signal: deliverySignal,
      }), deliverySignal)
      deliverySignal.throwIfAborted()
      this.captureSpawnObjective(definition, session, resolved)

      if (this.holdSpawnForDependencies(runtime, dependencies)) return managedWorkerView(runtime)
      await this.host.execution.startWorker(runtime, deliverySignal)
      return managedWorkerView(runtime)
    } catch (error: unknown) {
      if (this.failSpawn(runtime, resolved, error)) await this.host.scheduling.releaseDependents(runtime!)
      throw error
    } finally {
      this.host.preparing.delete(resolved.name)
      markPrepared()
    }
  }

  private checkSpawnSignals(signal: AbortSignal | undefined): void {
    this.host.signal.throwIfAborted()
    signal?.throwIfAborted()
  }

  private captureSpawnObjective(
    definition: DefinedAgent, session: AgentSession, resolved: ResolvedManagedAgentSpawnRequest,
  ): void {
    if (definition.memory.autoCaptureObjective) {
      session.memory.captureOriginalObjective(createTextMessage(resolved.task))
    }
  }

  private createSpawnRuntime(
    resolved: ResolvedManagedAgentSpawnRequest, session: AgentSession,
    input: { readonly dependencies: readonly WorkerRuntime[]; readonly warnings: readonly string[] },
  ): WorkerRuntime {
    const { dependencies, warnings } = input
    const controller = new AbortController()
    let markSettled!: () => void
    const runtime: WorkerRuntime = {
      request: resolved,
      session,
      dependencies,
      starting: false,
      settledComplete: false,
      closeTask: undefined,
      status: 'pending',
      leadDriven: this.host.lead().isRunning,
      closing: false,
      deadline: undefined,
      controller,
      settled: new Promise<void>((resolve) => { markSettled = resolve }),
      markSettled: () => { recordEvidence(runtime); runtime.settledComplete = true; markSettled() },
      start: undefined,
      warnings,
      result: undefined,
      error: undefined,
      evidence: { status: 'pending', result: undefined, error: undefined },
    }
    return runtime
  }

  private resolveSpawnRequest(request: ManagedAgentSpawnRequest): ResolvedManagedAgentSpawnRequest {
    const resolved: ResolvedManagedAgentSpawnRequest = {
      name: memberName(request.name ?? this.nextWorkerName()),
      task: boundedString(request.task, 'worker task', this.host.maxTaskBytes),
      ...(request.specialty === undefined
        ? {}
        : { specialty: boundedString(request.specialty, 'worker specialty', this.host.maxSpecialtyBytes) }),
      context: spawnContext(request.context ?? this.host.options.defaultSpawnContext ?? 'fresh'),
      ...(request.role === undefined ? {} : { role: this.requireRole(request.role) }),
      dependsOn: this.host.scheduling.resolveDependencies(request.dependsOn ?? []),
      writes: [...new Set((request.writes ?? []).map(normalizeWriteScope))],
    }
    Object.freeze(resolved.dependsOn)
    Object.freeze(resolved.writes)
    Object.freeze(resolved)
    return resolved
  }

  private assertSpawnAvailable(resolved: ResolvedManagedAgentSpawnRequest): void {
    if (this.host.workerRuntimes.size + this.host.preparing.size >= this.host.maxWorkers) {
      throw new Error(`managed agent team reached its ${this.host.maxWorkers}-worker limit`)
    }
    if (this.host.preparing.has(resolved.name) || this.host.workerRuntimes.has(resolved.name)
      || this.host.team.members().some(member => member.name === resolved.name)) {
      throw new Error(`managed worker '${resolved.name}' already exists`)
    }

  }

  private createSpawnSession(
    definition: DefinedAgent, resolved: ResolvedManagedAgentSpawnRequest,
    dependencies: readonly WorkerRuntime[], scopedSessionOptions: ManagedAgentTeamOptions['workerSessionOptions'],
  ): AgentSession {
    const sessionOptions = { ...this.host.options.workerSessionOptions, ...scopedSessionOptions }
    const workerTeamTools = this.host.options.workerTeamTools ?? 'reporting'
    return definition.createSession({
      ...sessionOptions,
      ...(dependencies.length === 0 ? {} : { tools: mergeTools(sessionOptions.tools,
        [this.dependencyReadTool(dependencies)]) }),
      ...(resolved.context === 'fork' ? { history: this.forkLeadHistory(sessionOptions.historyLimits) } : {}),
      registry: this.host.options.registry,
      team: {
        team: this.host.team,
        name: resolved.name,
        role: 'peer',
        tools: workerTeamTools,
        instructions: [
          `You are managed worker '${resolved.name}'; lead: '${this.host.leadName}'.`,
          'Return only the caller-requested result in the caller’s format; include explanation only when requested.',
          'Your terminal result is delivered automatically.',
          ...(workerTeamTools === false ? [] : [
            'send_message is context, not a substitute result; it cannot target yourself.',
          ]),
        ].join(' '),
        ...(resolved.specialty === undefined ? {} : { description: resolved.specialty }),
      },
    })
  }

  private holdSpawnForDependencies(runtime: WorkerRuntime, dependencies: readonly WorkerRuntime[]): boolean {
    const resolved = runtime.request
    if (dependencies.length > 0 && !this.host.scheduling.dependenciesSettled(dependencies, resolved.writes)) {
      // Held, not started. The promise handed to the team is what makes the
      // wait honest: without it `wait_agents` asks an idle session whether it
      // is finished, is told yes, and the lead reads a worker that never ran
      // as one that had nothing to report.
      const held = new Promise<void>((resolve) => { runtime.start = resolve })
      this.host.team.markPending(resolved.name, held)
      for (const dependency of dependencies) {
        if (SETTLED_WORKER_STATUS.has(dependency.status) && this.host.scheduling.workerHasWork(dependency)) {
          // A completed worker may be running a team-scheduled follow-up.
          // Its original managed watcher has already finished.
          void this.host.team.whenIdle(dependency.request.name)
            .then(() => this.host.scheduling.releaseDependents(dependency)).catch(() => {})
        }
      }
      return true
    }
    return false
  }

  private failSpawn(
    runtime: WorkerRuntime | undefined, resolved: ResolvedManagedAgentSpawnRequest, error: unknown,
  ): boolean {
    if (runtime !== undefined && this.host.workerRuntimes.get(resolved.name) === runtime && !runtime.closing) {
      runtime.status = 'failed'
      runtime.error = errorMessage(error)
      runtime.start = undefined
      runtime.dependencies = []
      try { this.host.team.markPending(resolved.name, undefined) } catch { /* team already disposed */ }
      runtime.markSettled()
      this.host.workerRuntimes.delete(resolved.name)
      try { this.host.team.detach(resolved.name) } catch { /* registration already removed */ }
      return true
    }
    return false
  }

  /** Resolve a declared role name, or say which ones exist. */
  private requireRole(name: unknown): string {
    const value = nonEmpty(name, 'worker role')
    if (this.host.roles.size === 0) {
      throw new Error('this managed team declares no roles, so spawn_agent takes no role')
    }
    if (!this.host.roles.has(value)) {
      throw new Error(
        `unknown worker role '${value}'; declared roles are ${[...this.host.roles.keys()].join(', ')}`,
      )
    }
    return value
  }

  /** Only this worker's commissioned producer instances are readable, including after closure. */
  private dependencyReadTool(dependencies: readonly WorkerRuntime[]): ToolDefinition {
    return managedDependencyReadTool(dependencies, this.host.maxDependencyReportBytes)
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
    const entries = completedHistoryPrefix(this.host.lead().snapshot().history)
    return History.fromSnapshot(
      { version: 1, entries },
      limits ?? {},
    )
  }

  private async workerDefinition(
    request: ResolvedManagedAgentSpawnRequest,
  ): Promise<DefinedAgent> {
    if (this.host.options.workerFactory !== undefined) return this.host.options.workerFactory(request)
    const template = this.host.options.workerTemplate ?? this.host.options.lead
    const role = request.role === undefined ? undefined : this.host.roles.get(request.role)
    const roleText = role === undefined
      ? ''
      : ` You are the '${role.name}' worker. ${role.instructions ?? role.description}`
    const specialty = request.specialty === undefined
      ? ''
      : ` Your specialization is: ${request.specialty}.`
    return cloneAgent(template, {
      id: request.name,
      name: request.name,
      instructions: `${template.instructions}\n\nYou are dynamically assigned worker '${request.name}'.`
        + `${roleText}${specialty}`,
    })
  }

  private nextWorkerName(): string {
    while (true) {
      const candidate = `worker_${++this.workerSequence}`
      if (!this.host.preparing.has(candidate) && !this.host.workerRuntimes.has(candidate)
        && !this.host.team.members().some(member => member.name === candidate)) return candidate
    }
  }
}
