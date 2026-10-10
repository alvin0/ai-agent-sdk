import { timeoutValue } from '../../platform/config.ts'
import { AgentTeam } from './team.ts'
import type { ManagedAgentTeamOptions, ManagedAgentRole } from './managed-types.ts'
import {
  DEFAULT_WORKER_CLOSE_TIMEOUT_MS, DEFAULT_HOLD_WAIT_MS, DEFAULT_SPAWN_SETUP_TIMEOUT_MS,
} from './managed-config.ts'

export function managedTimeouts(options: ManagedAgentTeamOptions) {
  return {
    workerTimeoutMs: timeoutValue(options.workerTimeoutMs ?? 10 * 60_000),
    observerTimeoutMs: timeoutValue(options.observerTimeoutMs ?? 1_000),
    closeTimeoutMs: timeoutValue(options.closeTimeoutMs ?? DEFAULT_WORKER_CLOSE_TIMEOUT_MS),
    holdWaitMs: timeoutValue(options.holdWaitMs ?? DEFAULT_HOLD_WAIT_MS),
    spawnTimeoutMs: timeoutValue(options.spawnTimeoutMs ?? DEFAULT_SPAWN_SETUP_TIMEOUT_MS),
  }
}

export function managedRoles(options: ManagedAgentTeamOptions): Map<string, ManagedAgentRole> {
  const roles = new Map((options.roles ?? []).map(role => [role.name, role]))
  if (roles.size !== (options.roles ?? []).length) {
    throw new Error('managed agent roles contain a duplicate name')
  }
  return roles
}

export function managedControlPlane(options: ManagedAgentTeamOptions, maxWorkers: number): AgentTeam {
  return options.team instanceof AgentTeam
    ? options.team
    : new AgentTeam({
        ...options.team,
        maxMembers: options.team?.maxMembers ?? maxWorkers + 1,
      })
}
