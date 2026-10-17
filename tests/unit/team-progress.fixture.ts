import type { MockInstance } from 'vitest'
import type { TeamSnapshot } from '../../packages/core/src/agent/team/team-timeline.ts'
import { afterEach, beforeEach, vi } from 'vitest'
import { AgentTeam } from '../../packages/core/src/agent/team/team.ts'
import { ManagedProgress } from '../../packages/core/src/agent/team/managed-progress.ts'
import { progressActivity } from '../../packages/core/src/agent/team/team-progress-internal.ts'
import { recordTeamTimeline } from '../../packages/core/src/agent/team/team-observation-internal.ts'
import type { TeamProgressEvent, TeamProgressOptions } from '../../packages/core/src/agent/team/team-progress.ts'
import type { AgentSession } from '../../packages/core/src/agent/define/session.ts'

export const events: TeamProgressEvent[] = []
let dispose = () => {}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  events.length = 0
})
afterEach(() => { dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

interface ProgressFixture {
  progress: ManagedProgress; team: AgentTeam; controller: AbortController; invocation: AbortController
  busy: Set<string>; session: AgentSession; snapshotSpy: MockInstance<() => TeamSnapshot>
  start(targets?: string[]): ReturnType<ManagedProgress['configure']>
  activity(member?: string): void
  tool(args?: unknown): void
  settled(member: string): void
}
export function fixture(options: TeamProgressOptions = {}, observer?: (event: TeamProgressEvent) => void):
ProgressFixture {
  const team = new AgentTeam({ id: 'progress-test', onEvent: event => {
    if (event.type === 'team-progress') { events.push(event); return observer?.(event) }
  } })
  const controller = new AbortController()
  const invocation = new AbortController()
  const busy = new Set(['a', 'b'])
  const snapshot = team.snapshot()
  const snapshotSpy = vi.spyOn(team, 'snapshot').mockImplementation(() => ({ ...snapshot,
    occurredAt: new Date().toISOString(), members: ['a', 'b'].map(name => ({ name, agentId: name,
      role: 'peer' as const, attached: true, status: busy.has(name) ? 'running' : 'completed',
      attachedAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(),
      modelCalls: 2, durationMs: 0, runs: 1, activeRuns: Number(busy.has(name)),
    })) }))
  const session = { whenIdle: async () => {}, lastOutcome: () => ({ yielded: true }) } as unknown as AgentSession
  const progress = new ManagedProgress({ team, lead: 'lead', signal: controller.signal,
    session: () => session, workers: () => ['a', 'b'], busy: name => busy.has(name), owned: () => false,
  }, { minIntervalMs: 10, maxIntervalMs: 100, ...options })
  progressActivity(team, { kind: 'invocation', member: 'lead', signal: invocation.signal })
  dispose = () => progress.dispose()
  return { progress, team, controller, invocation, busy, session, snapshotSpy,
    start: (targets?: string[]) => progress.configure({ interval_ms: 10, ...targets === undefined ? {} : { targets } }),
    activity: (member = 'a') => recordTeamTimeline(team, { kind: 'model-requested', member, runId: 'run' }),
    tool: (args: unknown = { path: '/src/file.ts', token: 'secret' }) => progressActivity(team,
      { kind: 'tool', member: 'a', name: 'read_file', args }),
    settled: (member: string) => {
      busy.delete(member)
      recordTeamTimeline(team, { kind: 'worker-settled', member, status: 'completed' })
    },
  }
}
