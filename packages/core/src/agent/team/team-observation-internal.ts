/** Internal runtime bridge. Not exported from the package surface. */
import type { ObservationPort } from '../../observation/index.ts'
import type { TeamObservation, TeamObservedSessionOptions } from './team-observation.ts'
import type { TeamTimelineData } from './team-timeline.ts'

const observations = new WeakMap<object, TeamObservation>()
const contexts = new WeakMap<ObservationPort, { parentTeamId: string; depth: number }>()
export function registerTeamObservation(team: object, observation: TeamObservation): void {
  observations.set(team, observation)
  observation.bindProgress(team)
}
export function recordTeamTimeline(team: object, data: TeamTimelineData): void {
  observations.get(team)?.record(data)
}
export function observeTeamSession<T extends TeamObservedSessionOptions>(team: object, member: string, options: T): T {
  const observation = observations.get(team)
  if (observation === undefined) return options
  const composed = observation.sessionOptions(member, options)
  if (composed.observation !== undefined) contexts.set(composed.observation, observation.childContext)
  return composed
}
export function teamObservationContext(port?: ObservationPort) {
  return port === undefined ? undefined : contexts.get(port)
}
