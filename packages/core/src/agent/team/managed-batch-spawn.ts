/** Synchronous batch admission followed by concurrent, independently reported worker setup. */
import type { ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest,
  ManagedAgentWorker } from './managed-types.ts'
import { errorMessage } from './managed-outcomes.ts'
import { truncate } from './managed-report-text.ts'

export interface BatchWorkerView {
  readonly target: string
  readonly status: ManagedAgentWorker['status']
  readonly error?: string
  readonly warnings?: readonly string[]
}

export interface BatchSpawnCallbacks {
  reserved(targets: readonly string[]): void
  started(name: string): void
}

interface BatchSpawnHost<T> {
  readonly maxWorkers: number
  readonly busy: number
  resolve(request: ManagedAgentSpawnRequest, reserved: ReadonlySet<string>): ResolvedManagedAgentSpawnRequest
  check(request: ResolvedManagedAgentSpawnRequest): void
  prepare(request: ResolvedManagedAgentSpawnRequest): T
  finish(prepared: T): void
  warnings(prepared: T): readonly string[]
  start(prepared: T, warnings: readonly string[]): Promise<ManagedAgentWorker>
}

export async function spawnManagedBatch<T>(requests: readonly ManagedAgentSpawnRequest[],
  callbacks: BatchSpawnCallbacks, host: BatchSpawnHost<T>,
): Promise<readonly BatchWorkerView[]> {
  const available = host.maxWorkers - host.busy
  if (requests.length > available) {
    throw new Error(`spawn_agents requested ${requests.length} workers but only ${available} slots are available`
      + ` (maxWorkers=${host.maxWorkers}); split into smaller batches after workers settle`)
  }
  const reserved = new Set(requests.flatMap(request => request.name === undefined ? [] : [request.name]))
  const resolved = requests.map(request => {
    const item = host.resolve(request, reserved)
    reserved.add(item.name)
    return item
  })
  const names = new Set<string>()
  for (const request of resolved) {
    host.check(request)
    if (names.has(request.name)) throw new Error(`duplicate batch worker '${request.name}'`)
    names.add(request.name)
  }
  const prepared = resolved.map(request => host.prepare(request))
  try {
    // Include all sibling reservations in conflict checks before any worker starts.
    const warnings = prepared.map(item => host.warnings(item))
    callbacks.reserved([...names])
    return await Promise.all(prepared.map(async (item, index) => {
      try {
        const worker = await host.start(item, warnings[index]!)
        return { target: worker.name, status: worker.status,
          ...(worker.error === undefined ? {} : { error: truncate(worker.error, 1024) }),
          ...(worker.warnings?.length ? { warnings: worker.warnings } : {}) }
      } catch (error: unknown) {
        return { target: resolved[index]!.name, status: 'failed' as const, error: truncate(errorMessage(error), 1024) }
      }
    }))
  } finally {
    for (const item of prepared) host.finish(item)
  }
}
