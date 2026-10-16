/** Resolves, prepares, and dispatches newly commissioned managed workers. */
import { startBatchWorker, spawnManagedBatch,
  type BatchSpawnCallbacks, type BatchWorkerView } from './managed-batch-spawn.ts'
import { ManagedSpawnQueue } from './managed-spawn-queue.ts'
import { createTextMessage } from '../../message/index.ts'
import { cloneAgent, type DefinedAgent } from '../define/definition.ts'
import type { AgentSession, AgentSessionOptions } from '../define/session.ts'
import { History } from '../history/index.ts'
import type { ToolDefinition } from '../tool/definition.ts'
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
import { mergeTools } from './managed-tool-input.ts'
import { completedHistoryPrefix } from './managed-history.ts'
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
    queued: boolean
  }>
  readonly roles: ReadonlyMap<string, ManagedAgentRole>
  readonly maxWorkers: number
  readonly maxQueued: number
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
type PreparedWorker = ManagedSpawnHost['preparing'] extends Map<string, infer T> ? T & { finish(): void } : never

function mergeWorkerSessionOptions(
  base: ManagedAgentTeamOptions['workerSessionOptions'], scoped: ScopedSessionOptions | undefined,
): NonNullable<ManagedAgentTeamOptions['workerSessionOptions']> {
  // Omitted scoped values must not erase base tool restrictions or policy hooks.
  return { ...base, ...Object.fromEntries(Object.entries(scoped ?? {}).filter(([, value]) => value !== undefined)) }
}

export class ManagedWorkerSpawning {
  private workerSequence = 0
  private readonly queue: ManagedSpawnQueue<PreparedWorker>

  /** Queue reservations are address/write claims, never worker slots. */
  get busy(): number {
    return [...this.host.preparing.values()].filter(item => !item.queued).length
      + [...this.host.workerRuntimes.values()].filter(runtime => this.host.workerBusy(runtime)).length
  }

  drainQueue(): void { this.queue.drain() }

  constructor(private readonly host: ManagedSpawnHost) {
    this.queue = new ManagedSpawnQueue(host.signal, () => host.maxWorkers - this.busy)
  }

  /** Create and start one worker without waiting for its result. */
  async spawn(
    request: ManagedAgentSpawnRequest,
    signal?: AbortSignal,
  ): Promise<ManagedAgentWorker> {
    this.checkSpawnSignals(signal)
    const resolved = this.resolveSpawnRequest(request)
    this.assertSpawnAvailable(resolved)
    return this.startPrepared(this.prepare(resolved), signal)
  }

  /** Reserve the complete fan-out before starting asynchronous setup. */
  spawnBatch(requests: readonly ManagedAgentSpawnRequest[], signal: AbortSignal,
    callbacks: BatchSpawnCallbacks,
  ): Promise<readonly BatchWorkerView[]> {
    this.checkSpawnSignals(signal)
    const start = (prepared: PreparedWorker, warnings: readonly string[]) => startBatchWorker(
      prepared.request.name, callbacks, {
        start: () => this.startPrepared(prepared, signal, warnings, callbacks.started),
        worker: name => this.host.workerRuntimes.get(name),
        cancelled: () => signal.aborted || this.host.signal.aborted || prepared.controller.signal.aborted,
        drain: () => this.drainQueue(),
      })
    return spawnManagedBatch(requests, callbacks, {
      maxWorkers: this.host.maxWorkers, maxQueued: this.host.maxQueued,
      busy: this.busy, queued: this.queue.size,
      resolve: (request, reserved) => this.resolveSpawnRequest(request, reserved),
      check: request => this.assertSpawnAvailable(request, false),
      prepare: (request, queued) => this.prepare(request, queued),
      finish: prepared => this.finishPreparing(prepared),
      warnings: prepared => this.host.scheduling.checkWriteScopes(prepared.request, prepared.dependencies),
      start, enqueue: (prepared, warnings) => this.queue.enqueue(prepared, signal,
        () => start(prepared, warnings), () => {
          this.finishPreparing(prepared)
          callbacks.settled(prepared.request.name, 'cancelled', false)
        }),
    })
  }
  private prepare(resolved: ResolvedManagedAgentSpawnRequest, queued = false): PreparedWorker {
    const dependencies = resolved.dependsOn.map(name => this.host.workerRuntimes.get(name)!)
    let markPrepared!: () => void
    const prepared = { request: resolved, dependencies, queued, controller: new AbortController(),
      settled: new Promise<void>(resolve => { markPrepared = resolve }), finish: () => markPrepared() }
    this.host.preparing.set(resolved.name, prepared)
    return prepared
  }
  private finishPreparing(prepared: PreparedWorker): void {
    if (this.host.preparing.get(prepared.request.name) === prepared) this.host.preparing.delete(prepared.request.name)
    prepared.finish()
  }
  private async startPrepared(prepared: PreparedWorker, signal?: AbortSignal,
    checkedWarnings?: readonly string[], started?: (name: string) => void,
  ): Promise<ManagedAgentWorker> {
    const { request: resolved, dependencies } = prepared
    let runtime: WorkerRuntime | undefined
    try {
      const warnings = checkedWarnings ?? this.host.scheduling.checkWriteScopes(resolved, dependencies)
      const operationSignal = combineSignals(signal, this.host.signal, prepared.controller.signal,
        AbortSignal.timeout(this.host.spawnTimeoutMs))
      operationSignal.throwIfAborted()
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
      started?.(resolved.name)

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
      this.finishPreparing(prepared)
      this.drainQueue()
    }
  }
  private checkSpawnSignals(signal: AbortSignal | undefined): void {
    this.host.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (atManagedDepthLimit(this.host.options)) throw new Error('managed agent delegation depth limit reached')
    this.drainQueue() // Older backlog gets newly freed slots before another admission.
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
  private resolveSpawnRequest(request: ManagedAgentSpawnRequest, reserved?: ReadonlySet<string>) {
    const resolved: ResolvedManagedAgentSpawnRequest = {
      name: memberName(request.name ?? this.nextWorkerName(reserved)),
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
  private assertSpawnAvailable(resolved: ResolvedManagedAgentSpawnRequest, checkCapacity = true): void {
    if (checkCapacity && this.busy >= this.host.maxWorkers) {
      throw new Error(`managed agent team reached its ${this.host.maxWorkers}-worker limit`
        + (this.queue.size > 0 ? '; queued batch items are ahead of this spawn in FIFO order' : ''))
    }
    if (this.host.preparing.has(resolved.name) || this.host.workerRuntimes.has(resolved.name)
      || this.host.team.members().some(member => member.name === resolved.name)) {
      throw new Error(`managed worker '${resolved.name}' already exists`)
    }
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
    return worker.createSession({
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
    })
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
      // Keep joins pending until dependency dispatch actually starts this worker.
      const held = new Promise<void>((resolve) => { runtime.start = resolve })
      this.host.team.markPending(resolved.name, held)
      for (const dependency of dependencies) {
        if (SETTLED_WORKER_STATUS.has(dependency.status) && this.host.scheduling.workerHasWork(dependency)) {
          // Team-scheduled follow-ups outlive the original watcher.
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

  /** Copy completed lead turns using the worker's history limits. */
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
  private nextWorkerName(reserved?: ReadonlySet<string>): string {
    while (true) {
      const candidate = `worker_${++this.workerSequence}`
      if (!reserved?.has(candidate) && !this.host.preparing.has(candidate) && !this.host.workerRuntimes.has(candidate)
        && !this.host.team.members().some(member => member.name === candidate)) return candidate
    }
  }
}
