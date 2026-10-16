/** Resolves, prepares, and dispatches newly commissioned managed workers. */
import { observeTeamSession, recordTeamTimeline } from './team-observation-internal.ts'
import { createTextMessage } from '../../message/index.ts'
import { cloneAgent, type DefinedAgent } from '../define/definition.ts'
import type { AgentSession, AgentSessionOptions } from '../define/session.ts'
import { History } from '../history/index.ts'
import type { ToolDefinition } from '../tool/definition.ts'
import type { TeamSpawnRejection } from './team-timeline.ts'
import type { TeamPort } from './contracts.ts'
import type { AgentTeam } from './team.ts'
import type { ManagedWorkerExecution } from './managed-worker.ts'
import type { ManagedWorkerScheduling } from './managed-scheduling.ts'
import { managedDependencyReadTool } from './managed-dependency-tool.ts'
import { managedWorkerView } from './managed-reports.ts'
import { atManagedDepthLimit, managedWorkerTools, managedWorkerInstructions } from './managed-capabilities.ts'
import type {
  ManagedAgentRole, ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest,
  ManagedAgentWorker, ManagedAgentTeamOptions, WorkerRuntime,
} from './managed-types.ts'
import {
  spawnContext, memberName, nonEmpty, boundedString,
} from './managed-validation.ts'
import {
  mergeTools,
} from './managed-tool-input.ts'
import {
  completedHistoryPrefix,
} from './managed-history.ts'
import {
  abortable, combineSignals,
} from './managed-cancellation.ts'
import {
  normalizeWriteScope,
} from './managed-write-scopes.ts'
import {
  errorMessage, recordEvidence, SETTLED_WORKER_STATUS,
} from './managed-outcomes.ts'

interface ManagedSpawnHost {
  readonly options: ManagedAgentTeamOptions
  readonly sessionTeam: TeamPort
  readonly collaboration?: TeamPort | undefined
  readonly workerBusy: (runtime: WorkerRuntime) => boolean
  readonly team: AgentTeam
  readonly signal: AbortSignal
  readonly workerRuntimes: Map<string, WorkerRuntime>
  readonly preparing: Map<string, {
    readonly request: ResolvedManagedAgentSpawnRequest
    readonly dependencies: readonly WorkerRuntime[]
    readonly settled: Promise<void>
    readonly controller: AbortController
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

type ScopedSessionOptions = Awaited<ReturnType<NonNullable<ManagedAgentTeamOptions['workerSessionOptionsFactory']>>>

function mergeWorkerSessionOptions(
  base: ManagedAgentTeamOptions['workerSessionOptions'], scoped: ScopedSessionOptions | undefined,
): NonNullable<ManagedAgentTeamOptions['workerSessionOptions']> {
  // Omitted scoped values must not erase base tool restrictions or policy hooks.
  return { ...base, ...Object.fromEntries(Object.entries(scoped ?? {}).filter(([, value]) => value !== undefined)) }
}

export class ManagedWorkerSpawning {
  private workerSequence = 0

  constructor(private readonly host: ManagedSpawnHost) {}

  /** Create and dispatch without awaiting the result; signal cancels setup. */
  async spawn(
    request: ManagedAgentSpawnRequest,
    signal?: AbortSignal,
  ): Promise<ManagedAgentWorker> {
    const resolved = this.resolveChecked(request, signal)
    const dependencies = resolved.dependsOn.map(name => this.host.workerRuntimes.get(name)!)
    this.assertSpawnAvailable(resolved)

    let markPrepared!: () => void
    const prepared = { request: resolved, dependencies, controller: new AbortController(),
      settled: new Promise<void>(resolve => { markPrepared = resolve }) }
    this.host.preparing.set(resolved.name, prepared)
    let runtime: WorkerRuntime | undefined
    try {
      const warnings = this.host.scheduling.checkWriteScopes(resolved, dependencies)
      const operationSignal = combineSignals(signal, this.host.signal, prepared.controller.signal,
        AbortSignal.timeout(this.host.spawnTimeoutMs))
      const definition = await abortable(this.workerDefinition(resolved), operationSignal)
      operationSignal.throwIfAborted()
      const scopedSessionOptions = this.host.options.workerSessionOptionsFactory === undefined
        ? undefined
        : await abortable(Promise.resolve(this.host.options.workerSessionOptionsFactory(resolved)), operationSignal)
      operationSignal.throwIfAborted()
      const session = this.createSpawnSession(definition, resolved, dependencies, scopedSessionOptions)
      recordTeamTimeline(this.host.team, { kind: 'spawn-accepted', member: resolved.name })
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
      if (await this.failSpawn(runtime, resolved, error)) await this.host.scheduling.releaseDependents(runtime!)
      throw error
    } finally {
      this.releasePreparation(resolved.name, markPrepared)
    }
  }

  private releasePreparation(member: string, markPrepared: () => void): void {
    if (this.host.preparing.delete(member)) recordTeamTimeline(this.host.team, { kind: 'slot-released', member })
    markPrepared()
  }

  private resolveChecked(request: ManagedAgentSpawnRequest, signal?: AbortSignal): ResolvedManagedAgentSpawnRequest {
    try {
      this.checkSpawnSignals(signal)
      return this.resolveSpawnRequest(request)
    } catch (error) {
      this.rejectSpawn(typeof request?.name === 'string' ? request.name.slice(0, 128) : '<unresolved>',
        'invalid', 'TEAM_SPAWN_INVALID')
      throw error
    }
  }
  private checkSpawnSignals(signal: AbortSignal | undefined): void {
    this.host.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (atManagedDepthLimit(this.host.options)) throw new Error('managed agent delegation depth limit reached')
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
      context: this.resolveContext(request),
      ...(request.role === undefined ? {} : { role: this.requireRole(request.role) }),
      dependsOn: this.host.scheduling.resolveDependencies(request.dependsOn ?? []),
      writes: [...new Set((request.writes ?? []).map(normalizeWriteScope))],
    }
    Object.freeze(resolved.dependsOn)
    Object.freeze(resolved.writes)
    Object.freeze(resolved)
    return resolved
  }

  private resolveContext(request: ManagedAgentSpawnRequest) {
    return spawnContext(this.host.roles.get(request.role ?? '')?.context
      ?? request.context ?? this.host.options.defaultSpawnContext ?? 'fresh')
  }

  private assertSpawnAvailable(resolved: ResolvedManagedAgentSpawnRequest): void {
    recordTeamTimeline(this.host.team, { kind: 'spawn-requested', member: resolved.name, context: resolved.context })
    if (this.host.preparing.has(resolved.name) || this.host.workerRuntimes.has(resolved.name)
      || this.host.team.members().some(member => member.name === resolved.name)) {
      this.rejectSpawn(resolved.name, 'duplicate', 'TEAM_WORKER_ALREADY_EXISTS')
      throw new Error(`managed worker '${resolved.name}' already exists`)
    }
    if ([...this.host.workerRuntimes.values()].filter(runtime => this.host.workerBusy(runtime)).length
      + this.host.preparing.size >= this.host.maxWorkers) {
      recordTeamTimeline(this.host.team, { kind: 'budget', member: this.host.leadName,
        budget: 'workers', action: 'exhausted', limit: this.host.maxWorkers })
      this.rejectSpawn(resolved.name, 'capacity', 'TEAM_WORKER_LIMIT')
      throw new Error(`managed agent team reached its ${this.host.maxWorkers}-worker limit`)
    }
  }

  private rejectSpawn(member: string, reason: TeamSpawnRejection, code: string): void {
    recordTeamTimeline(this.host.team, { kind: 'spawn-rejected', member, reason, code,
      busy: [...this.host.workerRuntimes.values()].filter(runtime => this.host.workerBusy(runtime)).length,
      preparing: this.host.preparing.size, limit: this.host.maxWorkers })
  }

  private createSpawnSession(
    definition: DefinedAgent, resolved: ResolvedManagedAgentSpawnRequest,
    dependencies: readonly WorkerRuntime[], scopedSessionOptions: ScopedSessionOptions | undefined,
  ): AgentSession {
    const sessionOptions = mergeWorkerSessionOptions(this.host.options.workerSessionOptions, scopedSessionOptions)
    const role = this.host.roles.get(resolved.role ?? '')
    const restricted = role?.tools !== undefined
    const workerTeamTools = this.workerTeamToolAccess(restricted)
    const worker = cloneAgent(definition, {
      id: definition.id, tools: [],
      ...(restricted ? { nativeTools: [], skills: [], skillIds: [] } : {}),
    })
    return worker.createSession(observeTeamSession(this.host.team, resolved.name, {
      ...sessionOptions,
      ...(restricted ? { skills: [], experimentalPrograms: [] } : {}),
      tools: mergeTools(managedWorkerTools(this.host.options, definition, sessionOptions, role),
        dependencies.length === 0 ? [] : [this.dependencyReadTool(dependencies)]),
      ...(resolved.context === 'fork' ? { history: this.forkLeadHistory(sessionOptions.historyLimits) } : {}),
      registry: this.host.options.registry,
      team: {
        team: this.host.sessionTeam,
        name: resolved.name,
        role: 'peer',
        tools: workerTeamTools,
        instructions: this.workerInstructions(resolved, role, workerTeamTools),
        ...(resolved.specialty === undefined ? {} : { description: resolved.specialty }),
      },
    }))
  }

  private workerInstructions(resolved: ResolvedManagedAgentSpawnRequest,
    role: ManagedAgentRole | undefined, access: false | 'full' | 'reporting'): string {
    let instructions = managedWorkerInstructions(resolved.name, role)
    if (this.host.collaboration !== undefined) instructions = instructions.replace(
      'Keep inter-worker coordination in the parent.', 'Coordinate with peers through the board and bounded messages.')
    const scope = resolved.writes.length === 0 ? 'none declared' : resolved.writes.join(', ')
    return [instructions, `Assigned write scope: ${scope}.`, ...access === false ? [] : [this.toolInstructions(access)]]
      .join(' ')
  }

  private toolInstructions(access: 'full' | 'reporting'): string {
    if (this.host.collaboration !== undefined) {
      return 'Publish shared findings on the task board; send_input wakes peers with bounded turn credits.'
    }
    if (this.host.options.modelToolSurface === 'legacy') {
      return 'send_message is context, not a substitute result; it cannot target yourself.'
    }
    return access === 'full'
      ? 'send_input queues worker tasks or sends context to the lead. Return your final answer to finish.'
      : 'send_input sends context to the lead (or to a peer only when instructed). Return your final answer to finish.'
  }

  private workerTeamToolAccess(restricted: boolean): false | 'reporting' | 'full' {
    const access = this.host.options.workerTeamTools ?? 'reporting'
    return restricted && access === 'full' ? 'reporting' : access
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

  private async failSpawn(
    runtime: WorkerRuntime | undefined, resolved: ResolvedManagedAgentSpawnRequest, error: unknown,
  ): Promise<boolean> {
    this.rejectSpawn(resolved.name, 'setup', 'TEAM_SPAWN_SETUP_FAILED')
    recordTeamTimeline(this.host.team, { kind: 'spawn-failed', member: resolved.name,
      reason: 'setup', code: 'TEAM_SPAWN_SETUP_FAILED' })
    if (runtime !== undefined && this.host.workerRuntimes.get(resolved.name) === runtime && !runtime.closing) {
      runtime.status = 'failed'
      runtime.error = errorMessage(error)
      // Cancel queued wakes before releasing their hold: failed setup must not
      // start the model, and waiters still need the held promise to settle.
      const cancelled = this.host.team.cancel(resolved.name, error)
      runtime.start?.()
      runtime.start = undefined
      runtime.dependencies = []
      try { this.host.team.markPending(resolved.name, undefined) } catch { /* team already disposed */ }
      runtime.markSettled()
      try { await abortable(cancelled, AbortSignal.timeout(this.host.spawnTimeoutMs)) } catch { /* bounded cleanup */ }
      if (this.host.workerRuntimes.get(resolved.name) === runtime) {
        this.host.workerRuntimes.delete(resolved.name)
        try { this.host.team.detach(resolved.name) } catch { /* registration already removed */ }
      }
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

  /** Fork the completed lead conversation using the worker's configured history limits. */
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
    const template = this.host.options.workerTemplate ?? {
      ...this.host.options.lead,
      // Clear the source allowlist too, so explicit worker session skills remain usable.
      ...(this.host.options.inheritLeadTools === false ? { nativeTools: [], skills: [], skillIds: undefined } : {}),
    }
    const specialty = request.specialty === undefined
      ? ''
      : ` Your specialization is: ${request.specialty}.`
    return cloneAgent(template, {
      id: request.name,
      name: request.name,
      instructions: template.instructions + specialty,
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
