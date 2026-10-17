/** Team admission guards owned by a managed harness. */
import { teamInternals } from './team-internal.ts'
import type { AgentTeam } from './team.ts'

export function guardManagedCoordination(team: AgentTeam, leadName: string,
  admitFollowup: (target: string) => void, queued: (target: string) => boolean): () => void {
  const internals = teamInternals(team)
  const unguardWake = internals.guardWake(admitFollowup)
  const unguardWait = internals.guardWait((sender, targets) => {
    if (sender !== leadName && targets.some(queued)) {
      throw new Error('cannot peer-wait on a queued worker; return work to the lead')
    }
  })
  return () => { unguardWake(); unguardWait() }
}
