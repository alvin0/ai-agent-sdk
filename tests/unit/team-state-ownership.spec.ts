import { describe, expect, it } from 'vitest'
import { AgentTeam } from '../../packages/core/src/agent/team/team.ts'
import type { TeamSessionPort } from '../../packages/core/src/agent/team/contracts.ts'

function session(id: string, inject: TeamSessionPort['inject'] = () => 1): TeamSessionPort {
  return {
    definition: { id }, conversationId: `${id}-conversation`, isRunning: false, inject,
    whenIdle: async () => {}, runPending: async () => ({ text: 'done' }),
  }
}

describe('team state ownership across registration, delivery and disposal', () => {
  it('leaves the roster unchanged after metadata validation fails', async () => {
    const events: string[] = []
    const team = new AgentTeam({ maxMembers: 1, maxMetadataBytes: 4, onEvent: event => events.push(event.type) })
    expect(() => team.attach(session('worker'), { description: 'too long' })).toThrow()
    expect(team.members()).toEqual([])
    expect(events).toEqual([])
    team.attach(session('worker'), { description: 'ok' })
    expect(team.members()[0]).toMatchObject({ name: 'worker', role: 'lead' })
    await team.dispose()
  })

  it('releases the delivery reservation when a local session rejects admission', async () => {
    const team = new AgentTeam({ maxMessages: 1 })
    let reject = true
    let delivered = 0
    team.attach(session('lead'))
    team.attach(session('worker', () => {
      if (reject) throw new Error('history full')
      return ++delivered
    }))
    const request = { from: 'lead', target: 'worker', message: 'context' }
    await expect(team.sendMessage(request)).rejects.toThrow('history full')
    expect(team.messages()).toEqual([])
    reject = false
    await expect(team.sendMessage(request)).resolves.toMatchObject({ status: 'accepted' })
    expect(delivered).toBe(1)
    expect(team.messages()).toHaveLength(1)
    await team.dispose()
  })

  it('accounts for an accepted message and its pending reservation during a reentrant observer', async () => {
    let nested: Promise<unknown> | undefined
    let observedCount = 0
    const team = new AgentTeam({
      maxMessages: 2,
      onEvent(event) {
        if (event.type !== 'message-accepted') return
        observedCount = team.messages().length
        nested = team.sendMessage({ from: 'lead', target: 'worker', message: 'nested' })
      },
    })
    team.attach(session('lead'))
    team.attach(session('worker'))
    await team.sendMessage({ from: 'lead', target: 'worker', message: 'first' })
    expect(observedCount).toBe(1)
    expect(nested).toBeDefined()
    await expect(nested!).rejects.toThrow('2-message mailbox limit')
    expect(team.messages()).toHaveLength(1)
    await team.dispose()
  })

  it('releases remote reply capacity after a rejected result so a subsequent send can succeed', async () => {
    const team = new AgentTeam({ maxMessages: 1, maxLinkedResultBytes: 256 })
    team.attach(session('lead'))
    let oversized = true
    team.linkAgent({
      name: 'remote',
      transport: {
        protocol: 'test', agentId: 'remote-agent',
        async send() {
          return { kind: 'message', succeeded: true, text: oversized ? 'x'.repeat(1024) : 'ok', contextId: 'ctx' }
        },
      },
    })
    await expect(team.followup('lead', 'remote', 'work')).rejects.toThrow('256-byte limit')
    oversized = false
    await expect(team.followup('lead', 'remote', 'retry')).resolves.toMatchObject({ status: 'accepted' })
    expect(team.messages()).toHaveLength(1)
    expect(team.members().find(member => member.name === 'remote')?.status).toBe('idle')
    await team.dispose()
  })

  it('returns the same disposal task and clears state once after cancellation settles', async () => {
    const events: string[] = []
    const team = new AgentTeam({ onEvent: event => events.push(event.type) })
    team.attach(session('lead'))
    team.attach(session('worker'))
    await team.sendMessage({ from: 'lead', target: 'worker', message: 'context' })
    const first = team.dispose()
    expect(team.dispose()).toBe(first)
    expect(() => team.attach(session('late'))).toThrow('disposed')
    await first
    expect(team.members()).toEqual([])
    expect(team.messages()).toEqual([])
    expect(events.filter(type => type === 'team-disposed')).toHaveLength(1)
    expect(team.dispose()).toBe(first)
  })
})
