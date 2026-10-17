import { teamObservationContext } from './team-observation-internal.ts'
import { timeoutValue } from '../../platform/config.ts'
import { AgentTeam } from './team.ts'
import type { ManagedAgentTeamOptions, ManagedAgentRole } from './managed-types.ts'
import { positiveInteger, spawnContext } from './managed-validation.ts'
import { DEFAULT_MAX_RETAINED_WORKERS } from './managed-retention.ts'
import {
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS,
} from './managed-config.ts'

function dependencyReportBytes(value: number | undefined): number {
  const bytes = positiveInteger(value ?? 8 * 1024, 'maxDependencyReportBytes')
  if (bytes < 4) throw new TypeError('maxDependencyReportBytes must be at least 4')
  return bytes
}

/** Validated numeric limits and timeouts for one managed harness. */
export function managedLimits(options: ManagedAgentTeamOptions) {
  const maxWorkers = positiveInteger(options.maxWorkers ?? 7, 'maxWorkers')
  const maxDependencyReportBytes = dependencyReportBytes(options.maxDependencyReportBytes)
  return Object.freeze({
    maxWorkers, maxQueued: managedMaxQueued(options, maxWorkers), maxDependencyReportBytes,
    maxRetainedWorkers: positiveInteger(options.maxRetainedWorkers ?? DEFAULT_MAX_RETAINED_WORKERS,
      'maxRetainedWorkers'),
    maxTaskBytes: positiveInteger(options.maxTaskBytes ?? 64 * 1024, 'maxTaskBytes'),
    maxSpecialtyBytes: positiveInteger(options.maxSpecialtyBytes ?? 8 * 1024, 'maxSpecialtyBytes'),
    // Opt-in: a default deadline would discard a long worker's spent tokens.
    workerTimeoutMs: options.workerTimeoutMs === undefined ? undefined : timeoutValue(options.workerTimeoutMs),
    observerTimeoutMs: timeoutValue(options.observerTimeoutMs ?? 1_000),
    closeTimeoutMs: timeoutValue(options.closeTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS),
    spawnTimeoutMs: options.spawnTimeoutMs === undefined ? undefined : timeoutValue(options.spawnTimeoutMs),
  })
}

export function managedRoles(options: ManagedAgentTeamOptions): Map<string, ManagedAgentRole> {
  const roles = new Map((options.roles ?? []).map(role => [role.name, Object.freeze({
    ...role,
    ...(role.context === undefined ? {} : { context: spawnContext(role.context) }),
    ...(role.tools === undefined ? {} : { tools: Object.freeze([...role.tools]) }),
  })]))
  if (roles.size !== (options.roles ?? []).length) {
    throw new Error('managed agent roles contain a duplicate name')
  }
  return roles
}

export function managedControlPlane(options: ManagedAgentTeamOptions, maxWorkers: number): AgentTeam {
  return options.team instanceof AgentTeam
    ? options.team
    : new AgentTeam({
        ...teamObservationContext(options.leadSessionOptions?.observation),
        ...options.team,
        maxMembers: options.team?.maxMembers ?? maxWorkers + 1,
        mailboxOverflow: options.team?.mailboxOverflow ?? 'evict-oldest',
      })
}

/** Host queue capacity is bounded even when callers bypass TypeScript. */
export function managedMaxQueued(options: ManagedAgentTeamOptions, maxWorkers: number): number {
  const value = options.maxQueued ?? Math.min(1024, 2 * maxWorkers)
  if (!Number.isSafeInteger(value) || value < 0 || value > 1024) {
    throw new TypeError('maxQueued must be an integer between 0 and 1024')
  }
  return value
}
