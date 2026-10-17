import type { MockInstance } from 'vitest'
import type { TeamSnapshot } from '../../packages/core/src/agent/team/team-timeline.ts'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { AgentTeam } from '../../packages/core/src/agent/team/team.ts'
import { ManagedProgress } from '../../packages/core/src/agent/team/managed-progress.ts'
import { progressActivity } from '../../packages/core/src/agent/team/team-progress-internal.ts'
import { recordTeamTimeline } from '../../packages/core/src/agent/team/team-observation-internal.ts'
import type { TeamProgressEvent, TeamProgressOptions } from '../../packages/core/src/agent/team/team-progress.ts'
import type { AgentSession } from '../../packages/core/src/agent/define/session.ts'

export const events: TeamProgressEvent[] = []
const stopTimers: number[] = []
let dispose = async () => {}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  events.length = 0
  stopTimers.length = 0
})
afterEach(async () => {
  await dispose()
  try {
    expect(stopTimers).toEqual(stopTimers.map(() => 0))
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.restoreAllMocks(); vi.useRealTimers() }
})

interface ProgressFixture {
  progress: ManagedProgress; team: AgentTeam; controller: AbortController; invocation: AbortController
  busy: Set<string>; workers: string[]; session: AgentSession; snapshotSpy: MockInstance<() => TeamSnapshot>
  start(targets?: string[]): ReturnType<ManagedProgress['configure']>
  activity(member?: string): void
  tool(args?: unknown): void
  settled(member: string): void
  endLead(): void
}
interface FixtureSession {
  isRunning?: boolean
  yielded?: boolean
  whenIdle?: () => Promise<void>
}
export function fixture(
  options: TeamProgressOptions = {}, observer?: (event: TeamProgressEvent) => void, owner?: object,
  lead: FixtureSession = {},
): ProgressFixture {
  const team = new AgentTeam({ id: 'progress-test', onEvent: event => {
    if (event.type === 'team-progress') {
      events.push(event)
      if (event.phase === 'stopped') stopTimers.push(vi.getTimerCount())
      return observer?.(event)
    }
  } })
  dispose = async () => { await team.dispose() }
  const controller = new AbortController()
  const invocation = new AbortController()
  const busy = new Set(['a', 'b'])
  const workers = ['a', 'b']
  const snapshot = team.snapshot()
  const snapshotSpy = vi.spyOn(team, 'snapshot').mockImplementation(() => ({ ...snapshot,
    occurredAt: new Date().toISOString(), members: workers.map(name => ({ name, agentId: name,
      role: 'peer' as const, attached: true, status: busy.has(name) ? 'running' : 'completed',
      attachedAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(),
      modelCalls: 2, durationMs: 0, runs: 1, activeRuns: Number(busy.has(name)),
    })) }))
  let endIdle!: () => void
  const idle = new Promise<void>(resolve => { endIdle = resolve })
  const session = { get isRunning() { return lead.isRunning ?? true },
    whenIdle: () => lead.whenIdle?.() ?? idle,
    lastOutcome: () => ({ yielded: lead.yielded ?? true }) } as unknown as AgentSession
  const progress = new ManagedProgress({ team, lead: 'lead', signal: controller.signal,
    session: () => session, workers: () => workers, busy: name => busy.has(name),
  }, { minIntervalMs: 10, maxIntervalMs: 100, ...options })
  if (owner !== undefined) progress.beginManagedInvocation(invocation.signal)
  progressActivity(team, { kind: 'invocation', member: 'lead', signal: invocation.signal })
  dispose = async () => { progress.dispose(); await team.dispose() }
  return { progress, team, controller, invocation, busy, workers, session, snapshotSpy,
    start: (targets?: string[]) => progress.configure({ interval_ms: 10, ...targets === undefined ? {} : { targets } }),
    activity: (member = 'a') => recordTeamTimeline(team, { kind: 'model-requested', member, runId: 'run' }),
    tool: (args: unknown = { path: '/src/file.ts', token: 'secret' }) => progressActivity(team,
      { kind: 'tool', member: 'a', name: 'read_file', args }),
    endLead: () => { lead.isRunning = false; endIdle() },
    settled: (member: string) => {
      busy.delete(member)
      recordTeamTimeline(team, { kind: 'worker-settled', member, status: 'completed' })
    },
  }
}
