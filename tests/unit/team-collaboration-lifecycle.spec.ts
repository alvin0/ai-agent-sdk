import { describe, expect, it, vi } from 'vitest'
import { CollaborationAdapter, answer, call, deferred, execute, managed, runTool } from './collaboration-support.ts'

describe('managed collaboration lifecycle', () => {
  it('is opt-in and preserves ordinary quiet delegation tools', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter, { collaboration: false })
    await team.spawn({ name: 'worker', task: 'Work' }); await team.awaitWorker('worker')
    expect(team.collaboration).toBeUndefined()
    await team.team.sendMessage({ from: 'lead', target: 'worker', message: 'Context', delivery: 'quiet' })
    expect(adapter.rounds.get('worker')).toBe(1)
    expect(team.team.toolsFor('worker', 'reporting').map(tool => tool.name))
      .toEqual(['list_agents', 'get_agent_result', 'send_message'])
    expect(adapter.requests[0]?.options.tools?.map(tool => tool.name)).not.toContain('task_create')
  })

  it('wakes an idle peer with sender framing and exposes board tools', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter)
    await team.spawn({ name: 'alice', task: 'Investigate' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'Review' }); await team.awaitWorker('bob')
    await execute(team, 'alice', 'send_message', { target: 'bob', message: 'Inspect line 7' })
    await team.team.whenIdle('bob')
    expect(adapter.rounds.get('bob')).toBe(2)
    const request = adapter.requests.filter(request => request.name === 'bob').at(-1)!.options
    expect(request.messages).toMatchObject(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ kind: 'agent-message', sender: 'alice' }),
        content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('from alice:') })]) }),
    ]))
    expect(request.tools?.map(tool => tool.name))
      .toEqual(expect.arrayContaining(['task_create', 'task_list', 'task_update']))
    expect(request.system).toContain('steers busy members')
    expect(request.system).not.toContain('only for quiet local context')
  })

  it('steers busy peers at the next step and does not lose their final-step message', async () => {
    const started = deferred(), finish = deferred()
    const adapter = new CollaborationAdapter(async (name, round) => {
      if (name === 'bob' && round === 2) { started.resolve(); await finish.promise }
      return answer(`${name} ${round}`)
    })
    const team = managed(adapter)
    await team.spawn({ name: 'alice', task: 'A' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'B' }); await team.awaitWorker('bob')
    await execute(team, 'alice', 'send_message', { target: 'bob', message: 'First request' })
    await started.promise
    await execute(team, 'alice', 'send_message', { target: 'bob', message: 'Correction during final step' })
    finish.resolve()
    await team.team.whenIdle('bob')
    expect(adapter.rounds.get('bob')).toBe(3)
    expect(JSON.stringify(adapter.requests.filter(request => request.name === 'bob').at(-1)?.options.messages))
      .toContain('Correction during final step')
  })

  it('wakes a blocked task claimant when its last dependency completes', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter)
    const board = team.collaboration!.board
    await board.create('lead', { id: 'research', title: 'Research' })
    await board.create('lead', { id: 'review', title: 'Review', blockedBy: ['research'] })
    await team.spawn({ name: 'bob', task: 'Wait for findings' }); await team.awaitWorker('bob')
    await board.update('bob', { id: 'review', expectedRevision: 1, action: 'claim' })
    await board.update('lead', { id: 'research', expectedRevision: 1, action: 'claim' })
    await board.update('lead', { id: 'research', expectedRevision: 2, action: 'complete', result: 'Found bug' })
    await team.team.whenIdle('bob')
    expect(adapter.rounds.get('bob')).toBe(2)
    expect(JSON.stringify(adapter.requests.at(-1)?.options.messages)).toContain("'review' is now unblocked")
    expect(board.list()[1]).toMatchObject({ owner: 'bob', ready: true })
  })

  it('bounds autonomous peer ping-pong and removes the duplicate full-access alias', async () => {
    const adapter = new CollaborationAdapter((name, round, options) => {
      if (round === 1 || name === 'lead') return answer('ready')
      const messages = options.messages
      const lastPeer = messages.findLastIndex(message => message.source.kind === 'agent-message')
      const lastTool = messages.findLastIndex(message => message.source.kind === 'tool')
      if (lastTool > lastPeer) return answer('message sent or capped')
      return call('send_message', { target: name === 'alice' ? 'bob' : 'alice', message: 'Please check this finding' })
    })
    const team = managed(adapter, { collaboration: { maxPeerTurnsPerPair: 3 }, workerTeamTools: 'full' })
    await team.spawn({ name: 'alice', task: 'A' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'B' }); await team.awaitWorker('bob')
    await execute(team, 'lead', 'send_message', { target: 'alice', message: 'Coordinate with bob' })
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(3000))
    const peerMessages = team.team.messages().filter(message =>
      ['alice', 'bob'].includes(message.sender) && ['alice', 'bob'].includes(message.target))
    expect(peerMessages).toHaveLength(3)
    expect(team.collaboration!.toolsFor('alice').map(tool => tool.name)).not.toContain('followup_task')
    await expect(execute(team, 'alice', 'send_message', { target: 'bob', message: 'Again' }))
      .rejects.toMatchObject({ code: 'TEAM_PEER_TURN_LIMIT' })
  })

  it('joins the initial worker before returning a synthesized lead answer', async () => {
    const started = deferred(), finish = deferred(), attemptedAnswer = deferred()
    const adapter = new CollaborationAdapter(async (name, round) => {
      if (name !== 'lead') { started.resolve(); await finish.promise; return answer('verified evidence') }
      if (round === 1) return call('spawn_agent', { name: 'worker', task: 'Investigate' })
      if (round === 2) { attemptedAnswer.resolve(); return answer('premature answer') }
      return answer('synthesized verified evidence')
    })
    const team = managed(adapter, { autoLeadCoordination: false })
    let done = false
    const running = team.run('Solve one problem').then(result => { done = true; return result })
    await started.promise; await attemptedAnswer.promise
    expect(done).toBe(false)
    finish.resolve()
    expect((await running).text).toBe('synthesized verified evidence')
    await team.whenQuiet(AbortSignal.timeout(1000))
    expect(adapter.rounds.get('lead')).toBe(3)
  })

  it('joins later peer wakes after original managed worker outcomes have settled', async () => {
    const wakeStarted = deferred(), finish = deferred(), leadAnswered = deferred()
    const adapter = new CollaborationAdapter(async (name, round) => {
      if (name === 'bob' && round === 2) { wakeStarted.resolve(); await finish.promise }
      if (name === 'lead' && round === 1) { leadAnswered.resolve(); return answer('tentative') }
      return answer(`${name} final`)
    })
    const team = managed(adapter)
    await team.spawn({ name: 'alice', task: 'A' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'B' }); await team.awaitWorker('bob')
    await execute(team, 'alice', 'send_message', { target: 'bob', message: 'Verify again' })
    await wakeStarted.promise
    let done = false
    const running = team.run('Synthesize').then(result => { done = true; return result })
    await leadAnswered.promise
    expect(done).toBe(false)
    finish.resolve()
    expect((await running).text).toBe('lead final')
    expect(adapter.rounds.get('lead')).toBe(2)
  })

  it('terminates with an unfinished board once all members are idle', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter)
    await team.collaboration!.board.create('lead', { id: 'unowned', title: 'Needs missing input' })
    const result = await team.run('Report blockers')
    expect(result.outcome.completed).toBe(true)
    expect(adapter.rounds.get('lead')).toBe(1)
    expect(JSON.stringify(adapter.requests.at(-1)?.options.system)).toContain('report those blockers')
    expect(team.collaboration!.board.list()[0]?.status).toBe('pending')
  })

  it('cancels stalled workers at a deterministic join deadline', async () => {
    const adapter = new CollaborationAdapter(async (name, round, options) => {
      if (name !== 'lead') {
        await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
        options.signal!.throwIfAborted()
      }
      if (round === 1) return call('spawn_agent', { name: 'worker', task: 'Stall' })
      return answer('partial result; worker cancelled')
    })
    const team = managed(adapter, { collaboration: { joinTimeoutMs: 20 } })
    const result = await team.run('Investigate')
    expect(result.text).toContain('worker cancelled')
    expect(team.workers()).toEqual([])
    expect(adapter.rounds.get('lead')).toBe(3)
    expect(JSON.stringify(adapter.requests.at(-1)?.options.messages)).toContain('join deadline expired')
  })

  it('cancels initial work and peer wake turns when the lead invocation is aborted', async () => {
    const workerStarted = deferred(), controller = new AbortController()
    const adapter = new CollaborationAdapter(async (name, round, options) => {
      if (name !== 'lead') {
        workerStarted.resolve()
        await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
        options.signal!.throwIfAborted()
      }
      return round === 1 ? call('spawn_agent', { name: 'worker', task: 'Work until cancelled' }) : answer('tentative')
    })
    const team = managed(adapter)
    const running = team.run('Investigate', { signal: controller.signal })
    await workerStarted.promise
    controller.abort(new Error('user cancelled'))
    await running.catch(() => undefined)
    await vi.waitFor(() => expect(team.workers()).toEqual([]))
    const rounds = adapter.rounds.get('lead')
    await team.whenQuiet(AbortSignal.timeout(1000))
    expect(adapter.rounds.get('lead')).toBe(rounds)
  })
  it('rejects invalid tool arguments and exposes notes/results through the actual tools', async () => {
    const team = managed()
    await execute(team, 'lead', 'task_create', { id: 'a', title: 'A' })
    await execute(team, 'lead', 'task_update', { id: 'a', expectedRevision: 1, action: 'annotate', notes: 'Finding' })
    expect(await execute(team, 'lead', 'task_list', {})).toMatchObject([{ revision: 2 }])
    expect(await execute(team, 'lead', 'task_list', {})).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ notes: expect.any(String) })]))
    expect(await execute(team, 'lead', 'task_list', { ids: ['a'] }))
      .toMatchObject([{ notes: 'Finding', revision: 2 }])
    expect(await execute(team, 'lead', 'task_list', { status: 'claimed' })).toEqual([])
    expect(() => execute(team, 'lead', 'task_update', { id: 'a', expectedRevision: 2, action: 'claim', result: 'bad' }))
      .toThrow('unsupported task action')
    expect(() => execute(team, 'lead', 'task_update', { id: 'a', expectedRevision: 2, action: 'edit' }))
      .toThrow('unsupported task action')
    expect(() => execute(team, 'lead', 'task_create', { id: 'b', title: 'B', writes: ['src'] }))
      .toThrow('unknown task argument')
    expect(() => execute(team, 'lead', 'task_list', { ids: 'a' })).toThrow('ids must')
    expect(() => execute(team, 'lead', 'task_list', { status: 'invalid' })).toThrow('unknown task status')
  })

  it('revokes old tools before reusing an address and preserves unfinished claims for recovery', async () => {
    const team = managed()
    await team.spawn({ name: 'alice', task: 'A' }); await team.awaitWorker('alice')
    const oldTools = team.collaboration!.toolsFor('alice')
    await execute(team, 'alice', 'task_create', { id: 'a', title: 'A' })
    await execute(team, 'alice', 'task_update', { id: 'a', expectedRevision: 1, action: 'claim' })
    await team.closeWorker('alice')
    await team.spawn({ name: 'alice', task: 'New commission' }); await team.awaitWorker('alice')
    await expect(runTool(oldTools.find(tool => tool.name === 'task_create')!, { id: 'bad', title: 'Old writer' }))
      .rejects.toThrow('closed')
    expect(team.collaboration!.board.list()[0]).toMatchObject({ owner: 'alice', status: 'claimed' })
    await execute(team, 'lead', 'task_update', { id: 'a', expectedRevision: 2, action: 'release' })
    await execute(team, 'alice', 'task_create', { id: 'good', title: 'New writer' })
    expect(team.collaboration!.board.list().map(task => task.id)).toEqual(['a', 'good'])
  })

  it('cancels a peer wake during lead join and prevents late board mutations', async () => {
    const wakeStarted = deferred(), leadAnswered = deferred(), controller = new AbortController()
    const adapter = new CollaborationAdapter(async (name, round, options) => {
      if (name === 'bob' && round === 2) {
        wakeStarted.resolve()
        await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
        options.signal!.throwIfAborted()
      }
      if (name === 'lead') leadAnswered.resolve()
      return answer('done')
    })
    const team = managed(adapter)
    await team.spawn({ name: 'alice', task: 'A' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'B' }); await team.awaitWorker('bob')
    const tools = team.collaboration!.toolsFor('bob')
    await execute(team, 'alice', 'send_message', { target: 'bob', message: 'More work' })
    await wakeStarted.promise
    const running = team.run('Join', { signal: controller.signal })
    await leadAnswered.promise
    controller.abort(new Error('cancel peers'))
    await running.catch(() => undefined)
    expect(team.workers()).toEqual([])
    await expect(runTool(tools.find(tool => tool.name === 'task_create')!, { id: 'late', title: 'Late' }))
      .rejects.toThrow('closed')
  })

  it('honors disabled worker team tools while retaining collaboration joining', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter, { workerTeamTools: false })
    await team.spawn({ name: 'worker', task: 'A' }); await team.awaitWorker('worker')
    const tools = adapter.requests[0]?.options.tools?.map(tool => tool.name) ?? []
    expect(tools).not.toContain('task_create')
    expect(tools).not.toContain('send_message')
    await team.run('Synthesize')
    await team.whenQuiet(AbortSignal.timeout(1000))
  })
})
