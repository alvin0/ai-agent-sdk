import { describe, expect, it } from 'vitest'
import { CollaborationAdapter, answer, call, deferred, execute, managed } from './collaboration-support.ts'

describe('combined managed team', () => {
  it('uses lean tools and shared joins in collaboration with one result delivery', async () => {
    const started = deferred(), finish = deferred()
    const adapter = new CollaborationAdapter(async (name, round) => {
      if (name !== 'lead') { started.resolve(); await finish.promise; return answer('unique worker evidence') }
      if (round === 1) return call('spawn_agent', { task: 'Inspect; return evidence.', writes: ['src/worker'] })
      if (round === 2) return call('wait_agents', {})
      return answer('synthesized answer')
    })
    const team = managed(adapter, { modelToolSurface: 'lean', maxWorkers: 1 })
    const running = team.run('Investigate together')
    await started.promise
    expect(adapter.requests[0]!.options.tools?.map(tool => tool.name)).toEqual([
      'spawn_agent', 'spawn_agents', 'close_agent', 'progress_updates',
        'send_input', 'wait_agents', 'get_agent_result',
      'task_create', 'task_list', 'task_update',
    ])
    finish.resolve()
    expect((await running).text).toBe('synthesized answer')
    const request = adapter.requests.filter(request => request.name === 'lead').at(-1)!.options
    const evidence = request.messages.flatMap(message => message.content).filter(block =>
      (block.type === 'text' && block.text.includes('unique worker evidence'))
      || (block.type === 'tool-result' && JSON.stringify(block.content).includes('unique worker evidence')))
    expect(evidence).toHaveLength(1)
    expect(adapter.rounds.get('lead')).toBeLessThanOrEqual(4)
    await team.spawn({ name: 'next', task: 'Read-only verification.' })
    await team.awaitWorker('next')
    expect(team.workers()).toHaveLength(2) // Finished addresses do not occupy active slots.
    await team.closeWorker('worker_1')
    const retained = await execute(team, 'lead', 'get_agent_result', { target: 'worker_1' })
    expect(JSON.stringify(retained)).toContain('unique worker evidence')
  })

  it.each(['reporting', 'full'] as const)('caps lean %s peer wakes and retains board authorization', async access => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter, { modelToolSurface: 'lean', workerTeamTools: access,
      collaboration: { maxPeerTurnsPerPair: 1 } })
    await team.spawn({ name: 'alice', task: 'Inspect' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'Review' }); await team.awaitWorker('bob')
    const tools = team.collaboration!.toolsFor('alice', access)
    expect(tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining(['send_message', 'followup_task']))
    const sending = tools.find(tool => tool.name === 'send_input')!
    const ctx = { signal: new AbortController().signal } as never
    await sending.execute(sending.parse!({ target: 'bob', message: 'Check finding' }), ctx)
    await team.collaboration!.whenMembersIdle()
    expect(adapter.rounds.get('bob')).toBe(2)
    await expect(sending.execute(sending.parse!({ target: 'bob', message: 'Repeat' }), ctx))
      .rejects.toMatchObject({ code: 'TEAM_PEER_TURN_LIMIT' })
    const update = tools.find(tool => tool.name === 'task_update')!
    expect((update.parameters.properties as { action: { enum: string[] } }).action.enum).not.toContain('reopen')
  })

  it('keeps default lean delegation explicit when selected and enforces inheritance policy', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter, { modelToolSurface: 'lean', collaboration: false,
      delegationMode: 'explicit', maxDepth: 0 })
    await team.run('Work directly')
    expect(adapter.requests[0]!.options.tools?.map(tool => tool.name)).not.toContain('spawn_agent')
    expect(adapter.requests[0]!.options.system).toContain('Delegation depth limit reached')
    await expect(team.spawn({ task: 'Forbidden nested work' })).rejects.toThrow('depth limit')
  })
})
