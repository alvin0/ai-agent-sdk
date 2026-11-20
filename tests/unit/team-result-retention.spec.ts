import { describe, expect, it } from 'vitest'
import { TeamResults } from '../../packages/core/src/agent/team/team-results.ts'
import { AgentTeam } from '../../packages/core/src/agent/team/team.ts'
import { teamInternals } from '../../packages/core/src/agent/team/team-internal.ts'
import type { AgentTeamMember } from '../../packages/core/src/agent/team/types.ts'
import type { TeamSessionPort } from '../../packages/core/src/agent/team/contracts.ts'

function member(name: string, text = name): AgentTeamMember {
  return { name, agentId: name, kind: 'local', role: 'peer', status: 'idle', deliveries: ['quiet'],
    outcome: { kind: 'completed', text } }
}

describe('team result recipient lifecycle', () => {
  it('delivers retained live evidence to a replacement attached session', async () => {
    const team = new AgentTeam()
    const session = (id: string, conversationId: string): TeamSessionPort => ({ definition: { id }, conversationId,
      isRunning: false, inject: () => 1, whenIdle: async () => {}, runPending: async () => {} })
    try {
      team.attach(session('producer', 'producer-conversation'))
      team.attach(session('peer', 'first-conversation'))
      team.recordOutcome('producer', { kind: 'completed', text: 'live evidence' })
      expect(teamInternals(team).takeResults('peer', ['producer'])).toHaveLength(1)
      team.detach('peer')
      team.attach(session('peer', 'replacement-conversation'))

      expect(teamInternals(team).takeResults('peer', ['producer'])).toMatchObject([
        { worker: 'producer', text: 'live evidence' },
      ])
    } finally { await team.dispose() }
  })

  it('lets a replacement recipient read results already read by its closed predecessor', () => {
    const results = new TeamResults()
    const producer = member('producer', 'existing evidence')
    expect(results.take('peer', [producer])).toHaveLength(1)
    expect(results.take('peer', [producer])).toHaveLength(0)

    results.archive(member('peer'))
    results.forget('peer')

    expect(results.take('peer', [producer])).toEqual([
      { worker: 'producer', status: 'completed', text: 'existing evidence' },
    ])
  })

  it('releases full outcome receipt maps when recipients close over many worker waves', () => {
    const results = new TeamResults()
    const producer = member('producer', 'x'.repeat(64 * 1024))
    for (let index = 0; index < 1_000; index++) {
      const name = `peer-${index}`
      results.take(name, [producer])
      results.archive(member(name))
    }

    const retained = results as unknown as { delivered: Map<string, unknown> }
    expect(retained.delivered.size).toBe(0)
    expect(results.retained('peer-999')).toBeDefined()
  })
})
