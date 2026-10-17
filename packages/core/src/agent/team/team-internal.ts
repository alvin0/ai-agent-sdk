/** Internal managed-runtime bridge to an AgentTeam. Not exported from the package surface. */
import type { ToolRunContext } from '../tool/definition.ts'
import type { TeamResults } from './team-results.ts'
import type { AgentMemberOutcome, AgentTeamMember } from './types.ts'

export interface TeamInternals {
  /** Host admission hooks run before wake-up input is accepted. Throw to refuse work. */
  guardWake(guard: (target: string) => void): () => void
  guardWait(guard: (sender: string, targets: readonly string[]) => void): () => void
  /** Claim compact results; shares delivery state with wait_agents. */
  takeResults(sender: string, targets: readonly string[], maxBytes?: number,
    settled?: ReadonlyMap<string, AgentMemberOutcome>): ReturnType<TeamResults['take']>
  /** Register an active join against the same per-outcome delivery ledger as notices. */
  captureResults(sender: string, targets: readonly string[], retained?: boolean): ReturnType<TeamResults['capture']>
  waitForBatch(sender: string, targets: readonly string[],
    whenIdle: (target: string, signal?: AbortSignal) => Promise<void>, ctx: ToolRunContext): Promise<unknown>
  /** Retain a managed worker's address while releasing its concurrency reservation. */
  releaseSlot(name: string): void
  /** Claims released by cancelled joins since the last call, keyed by member. */
  takeReleasedClaims(recipient: string): ReadonlyMap<string, AgentMemberOutcome>
  /** Whether the recipient already claimed the member's current settled outcome. */
  resultDelivered(recipient: string, member: AgentTeamMember): boolean
}

const internals = new WeakMap<object, TeamInternals>()

export function registerTeamInternals(team: object, value: TeamInternals): void { internals.set(team, value) }

export function teamInternals(team: object): TeamInternals {
  const value = internals.get(team)
  if (value === undefined) throw new TypeError('managed agent team requires an SDK AgentTeam instance')
  return value
}
