/** Spawn admission facts shared by single and batch dispatch. */
import type { AgentTeam } from './team.ts'
import type { ManagedAgentSpawnRequest, ResolvedManagedAgentSpawnRequest } from './managed-types.ts'
import type { TeamSpawnRejection } from './team-timeline.ts'
import { recordTeamTimeline } from './team-observation-internal.ts'

export class ManagedSpawnObservation {
  constructor(private readonly team: AgentTeam, private readonly lead: string,
    private readonly capacityView: () => { busy: number; preparing: number; limit: number }) {}

  resolve<T>(request: ManagedAgentSpawnRequest, resolve: () => T, aborted: () => boolean): T {
    try { return resolve() } catch (error) {
      this.reject(typeof request?.name === 'string' ? request.name.slice(0, 128) : '<unresolved>',
        aborted() ? 'aborted' : 'invalid', aborted() ? 'TEAM_SPAWN_ABORTED' : 'TEAM_SPAWN_INVALID')
      throw error
    }
  }

  checkBatch(requests: readonly ManagedAgentSpawnRequest[], check: () => void, aborted: () => boolean): void {
    try { check() } catch (error) {
      for (const request of requests) this.reject(request.name ?? '<unresolved>',
        aborted() ? 'aborted' : 'invalid', aborted() ? 'TEAM_SPAWN_ABORTED' : 'TEAM_SPAWN_INVALID')
      throw error
    }
  }

  requested(request: Pick<ResolvedManagedAgentSpawnRequest, 'name' | 'context'>): void {
    recordTeamTimeline(this.team, { kind: 'spawn-requested', member: request.name, context: request.context })
  }

  capacity(member: string): void {
    recordTeamTimeline(this.team, { kind: 'budget', member: this.lead,
      budget: 'workers', action: 'exhausted', limit: this.capacityView().limit })
    this.reject(member, 'capacity', 'TEAM_WORKER_LIMIT')
  }

  reject(member: string, reason: TeamSpawnRejection, code: string): void {
    recordTeamTimeline(this.team, { kind: 'spawn-rejected', member: member.slice(0, 128), reason, code,
      ...this.capacityView() })
  }

  rejectBatch(request: ManagedAgentSpawnRequest, reason: TeamSpawnRejection, code: string,
    context: () => ResolvedManagedAgentSpawnRequest['context']): void {
    const member = request.name?.slice(0, 128) ?? '<unresolved>'
    if (reason === 'capacity' || reason === 'duplicate') {
      let resolved: 'fresh' | 'fork' = 'fresh'
      try { resolved = context() } catch { /* capacity rejection may precede input validation */ }
      this.requested({ name: member, context: resolved })
    }
    if (reason === 'capacity') {
      recordTeamTimeline(this.team, { kind: 'budget', member: this.lead,
        budget: 'workers', action: 'exhausted', limit: this.capacityView().limit })
    }
    this.reject(member, reason, code)
  }

  failed(member: string): void {
    this.reject(member, 'setup', 'TEAM_SPAWN_SETUP_FAILED')
    recordTeamTimeline(this.team, { kind: 'spawn-failed', member, reason: 'setup', code: 'TEAM_SPAWN_SETUP_FAILED' })
  }
}
