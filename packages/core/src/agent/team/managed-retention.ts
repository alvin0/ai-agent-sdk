/** Long-lived teams forget their oldest settled workers once the lead has received those results. */
import { teamInternals } from './team-internal.ts'
import type { AgentTeam } from './team.ts'
import type { WorkerRuntime } from './managed-types.ts'

export const DEFAULT_MAX_RETAINED_WORKERS = 256

export interface ManagedRetentionHost {
  readonly team: AgentTeam
  readonly leadName: string
  readonly limit: number
  readonly workers: ReadonlyMap<string, WorkerRuntime>
  evictable(runtime: WorkerRuntime): boolean
  remove(name: string): void
}

/** Removes the oldest delivered, idle workers above the bound; their results move to the closed archive. */
export function evictRetainedWorkers(host: ManagedRetentionHost): void {
  let excess = host.workers.size - host.limit
  if (excess <= 0) return
  const members = new Map(host.team.members().map(member => [member.name, member]))
  const internals = teamInternals(host.team)
  for (const [name, runtime] of [...host.workers]) {
    if (excess <= 0) return
    const member = members.get(name)
    if (member === undefined || !host.evictable(runtime) || !internals.resultDelivered(host.leadName, member)) continue
    try {
      host.remove(name)
      excess--
    } catch { /* became busy since the check */ }
  }
}
