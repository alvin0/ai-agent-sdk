/** Atomic batch validation; slots and backlog are reserved before asynchronous setup. */
import type { ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest,
  ManagedAgentWorker, WorkerRuntime } from './managed-types.ts'
import { errorMessage } from './managed-outcomes.ts'
import type { TeamSpawnRejection } from './team-timeline.ts'
import { truncate } from './managed-report-text.ts'

export interface BatchWorkerView {
  readonly target: string
  readonly status: ManagedAgentWorker['status'] | 'queued' | 'cancelled'
  readonly error?: string
  readonly warnings?: readonly string[]
}

export interface BatchSpawnCallbacks {
  reserved(targets: readonly string[]): void
  started(name: string): void
  queued(name: string): void
  settled(name: string, status: 'completed' | 'failed' | 'cancelled', usable: boolean): void
}

interface BatchSpawnHost<T> {
  readonly maxWorkers: number
  readonly maxQueued: number
  readonly busy: number
  readonly queued: number
  rejected(request: ManagedAgentSpawnRequest, reason: TeamSpawnRejection, code: string): void
  resolve(request: ManagedAgentSpawnRequest, reserved: ReadonlySet<string>): ResolvedManagedAgentSpawnRequest
  check(request: ResolvedManagedAgentSpawnRequest): void
  prepare(request: ResolvedManagedAgentSpawnRequest, queued: boolean): T
  finish(prepared: T): void
  warnings(prepared: T): readonly string[]
  start(prepared: T, warnings: readonly string[]): Promise<BatchWorkerView>
  enqueue(prepared: T, warnings: readonly string[]): void
}

export async function spawnManagedBatch<T>(requests: readonly ManagedAgentSpawnRequest[],
  callbacks: BatchSpawnCallbacks, host: BatchSpawnHost<T>,
): Promise<readonly BatchWorkerView[]> {
  const free = Math.max(0, host.maxWorkers - host.busy)
  if (requests.length > free + host.maxQueued - host.queued) {
    for (const request of requests) host.rejected(request, 'capacity', 'TEAM_BATCH_QUEUE_LIMIT')
    throw new Error(`spawn_agents queue overflow: ${free} free slots, ${host.queued} queued`
      + ` (maxWorkers=${host.maxWorkers}, maxQueued=${host.maxQueued}); requested ${requests.length}`)
  }
  const resolved = resolveBatch(requests, host)
  const names = resolved.map(request => request.name)
  const prepared = resolved.map((request, index) => host.prepare(request, index >= free))
  let admitted = false
  try {
    const warnings = validateReservations(requests, () => prepared.map(item => host.warnings(item)), host)
    validateReservations(requests, () => callbacks.reserved(names), host)
    admitted = true
    return await Promise.all(prepared.map(async (item, index) => {
      if (index >= free) {
        callbacks.queued(resolved[index]!.name)
        host.enqueue(item, warnings[index]!)
        return { target: resolved[index]!.name, status: 'queued' as const }
      }
      return host.start(item, warnings[index]!)
    }))
  } finally {
    if (!admitted) for (const item of prepared) host.finish(item)
  }
}

export function failedBatchWorker(name: string, error: unknown, cancelled: boolean): BatchWorkerView {
  return { target: name, status: cancelled ? 'cancelled' : 'failed',
    error: truncate(errorMessage(error), 1024) }
}

export function batchWorkerView(worker: ManagedAgentWorker): BatchWorkerView {
  return { target: worker.name, status: worker.status,
    ...(worker.error === undefined ? {} : { error: truncate(worker.error, 1024) }),
    ...(worker.warnings?.length
      ? { warnings: worker.warnings.slice(0, 4).map(warning => truncate(warning, 256)) } : {}) }
}

export async function startBatchWorker(name: string, callbacks: BatchSpawnCallbacks, host: {
  start(): Promise<ManagedAgentWorker>
  worker(name: string): WorkerRuntime | undefined
  cancelled(): boolean
  drain(): void
}): Promise<BatchWorkerView> {
  try {
    const worker = await host.start()
    const runtime = host.worker(name)!
    void runtime.settled.then(() => {
      const completed = runtime.evidence.status === 'completed'
      let status: 'completed' | 'cancelled' | 'failed' = 'failed'
      if (completed) status = 'completed'
      else if (runtime.controller.signal.aborted) status = 'cancelled'
      callbacks.settled(name, status, completed
        && (Boolean(runtime.evidence.result?.text.trim()) || runtime.evidence.result?.structured !== undefined))
    })
    return batchWorkerView(worker)
  } catch (error: unknown) {
    const cancelled = host.cancelled()
    callbacks.settled(name, cancelled ? 'cancelled' : 'failed', false)
    return failedBatchWorker(name, error, cancelled)
  } finally { host.drain() }
}

function resolveBatch<T>(requests: readonly ManagedAgentSpawnRequest[], host: BatchSpawnHost<T>) {
  let reason: TeamSpawnRejection = 'invalid'
  try {
    const reserved = new Set(requests.flatMap(request => request.name === undefined ? [] : [request.name]))
    const resolved = requests.map(request => {
      const item = host.resolve(request, reserved)
      reserved.add(item.name)
      return item
    })
    reason = 'duplicate'
    const names = new Set<string>()
    for (const request of resolved) {
      host.check(request)
      if (names.has(request.name)) throw new Error(`duplicate batch worker '${request.name}'`)
      names.add(request.name)
    }
    return resolved
  } catch (error) {
    for (const request of requests) host.rejected(request, reason,
      reason === 'duplicate' ? 'TEAM_WORKER_ALREADY_EXISTS' : 'TEAM_SPAWN_INVALID')
    throw error
  }
}

function validateReservations<T, R>(requests: readonly ManagedAgentSpawnRequest[],
  validate: () => R, host: BatchSpawnHost<T>): R {
  try { return validate() } catch (error) {
    for (const request of requests) host.rejected(request, 'invalid', 'TEAM_SPAWN_INVALID')
    throw error
  }
}
