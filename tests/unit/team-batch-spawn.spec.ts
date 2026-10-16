import { describe, expect, it, vi } from 'vitest'
import { defineAgent, defineTool, ToolRegistry } from '../../packages/core/src/agent/index.ts'
import { ModelRegistry } from '../../packages/core/src/index.ts'
import { execute, fixture, gate, notices, tasks } from './helpers/team-batch-fixture.ts'
import { managedWorkerTools } from '../../packages/core/src/agent/team/managed-capabilities.ts'

describe('managed batch fan-out', () => {
  it.each(['lean', 'legacy'] as const)('one %s model call starts N workers and joins once', async modelToolSurface => {
    const { adapter, team } = fixture({ modelToolSurface })
    const running = team.run('Extract all independent inputs.')
    await vi.waitFor(() => expect(adapter.workers.size).toBe(3))
    expect(adapter.leads).toHaveLength(1)
    adapter.finishes.get('b')!.resolve()
    await team.awaitWorker('b')
    expect(adapter.leads).toHaveLength(1) // No lead model calls while the remaining workers are running.
    adapter.finishes.get('a')!.resolve()
    adapter.finishes.get('c')!.resolve()
    expect((await running).text).toBe('synthesis')
    expect(adapter.leads).toHaveLength(2)
    const result = adapter.leads[1]!.messages.flatMap(message => message.content)
      .find(block => block.type === 'tool-result')!
    for (const name of ['a', 'b', 'c']) expect(JSON.stringify(result)).toContain(`evidence/${name}/complete`)
    expect(notices(team)).toHaveLength(0)
    const wait = await execute(team, 'wait_agents', { targets: ['a', 'b', 'c'] })
    expect(wait.results).toEqual([])
    expect(team.workers()).toHaveLength(3)
    await team.spawn({ task: 'Next wave' }) // Finished slots are released without closing retained addresses.
    await vi.waitFor(() => expect(adapter.workers.has('worker_1')).toBe(true))
    adapter.finishes.get('worker_1')!.resolve()
    await team.awaitWorker('worker_1')
  })

  it('returns addresses without join and pushes each terminal result once', async () => {
    const { adapter, team } = fixture()
    const result = await execute(team, 'spawn_agents', { tasks: tasks() })
    expect(result.workers).toEqual(['a', 'b', 'c'].map(target => ({ target, status: 'running' })))
    await vi.waitFor(() => expect(adapter.workers.size).toBe(3))
    for (const finish of adapter.finishes.values()) finish.resolve()
    await team.whenQuiet()
    for (const name of ['a', 'b', 'c']) {
      expect(notices(team).filter(message => JSON.stringify(message).includes(`evidence/${name}/complete`)))
        .toHaveLength(1)
    }
    expect((await execute(team, 'wait_agents', {})).results).toEqual([])
  })

  it('captures fast workers while a sibling is still preparing', async () => {
    const setup = gate()
    const { adapter, team } = fixture({ workerSessionOptionsFactory: async request => {
      if (request.name === 'b') await setup.promise
      return {}
    } })
    const joining = execute(team, 'spawn_agents', { tasks: tasks().slice(0, 2), join: true })
    await vi.waitFor(() => expect(adapter.workers.has('a')).toBe(true))
    adapter.finishes.get('a')!.resolve()
    await team.awaitWorker('a')
    expect(notices(team)).toHaveLength(0)
    setup.resolve()
    await vi.waitFor(() => expect(adapter.workers.has('b')).toBe(true))
    adapter.finishes.get('b')!.resolve()
    expect((await joining).results).toEqual(expect.arrayContaining(['a', 'b'].map(target => ({
      target, status: 'completed', result: `evidence/${target}/complete`,
    }))))
    expect(notices(team)).toHaveLength(0)
  })

  it('excludes archived evidence from an earlier worker reusing the same address', async () => {
    const { adapter, team } = fixture()
    const old = defineAgent({ id: 'old', provider: 'test', model: 'scripted', instructions: 'Read' })
      .createSession({ registry: new ModelRegistry() })
    team.team.attach(old, { name: 'a' })
    team.team.recordOutcome('a', { kind: 'completed', text: 'prior generation evidence' })
    team.team.detach('a')
    const joining = execute(team, 'spawn_agents', { tasks: [tasks()[0]], join: true })
    await vi.waitFor(() => expect(adapter.workers.has('a')).toBe(true))
    adapter.finishes.get('a')!.resolve()
    expect((await joining).results).toEqual([
      { target: 'a', status: 'completed', result: 'evidence/a/complete' },
    ])
  })

  it('rejects overflow before setup and counts all in-flight reservations', async () => {
    const setup = gate()
    const factory = vi.fn(async () => { await setup.promise; return {} })
    const { adapter, team } = fixture({ maxWorkers: 2, maxQueued: 0, workerSessionOptionsFactory: factory })
    await expect(execute(team, 'spawn_agents', { tasks: tasks() })).rejects.toThrow('2 free slots, 0 queued')
    expect(factory).not.toHaveBeenCalled()
    const starting = execute(team, 'spawn_agents', { tasks: tasks().slice(0, 2) })
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    await expect(execute(team, 'spawn_agents', { tasks: [tasks()[2]] })).rejects.toThrow('0 free slots, 0 queued')
    await expect(team.spawn({ task: 'Concurrent host work' })).rejects.toThrow('2-worker limit')
    setup.resolve()
    await starting
    expect(adapter.workers.size).toBeLessThanOrEqual(2)
  })

  it('generates distinct addresses even when later items explicitly name worker_N', async () => {
    const { team } = fixture()
    const result = await execute(team, 'spawn_agents', { tasks: [
      { task: 'Read first partition' }, { name: 'worker_1', task: 'Read second partition' },
    ] })
    expect(result.workers.map((worker: { target: string }) => worker.target)).toEqual(['worker_2', 'worker_1'])
  })

  it('returns partial results on a bounded join timeout and later pushes the rest', async () => {
    const deadline = new AbortController()
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 1000 ? deadline.signal : originalTimeout(ms))
    const { adapter, team } = fixture()
    const joining = execute(team, 'spawn_agents', { tasks: tasks(), join: true })
    await vi.waitFor(() => expect(adapter.workers.size).toBe(3))
    adapter.finishes.get('a')!.resolve()
    await team.awaitWorker('a')
    deadline.abort(new DOMException('join budget expired', 'TimeoutError'))
    expect(await joining).toMatchObject({ timed_out: true,
      results: [{ target: 'a', result: 'evidence/a/complete' }] })
    adapter.finishes.get('b')!.resolve()
    adapter.finishes.get('c')!.resolve()
    await team.whenQuiet()
    expect(JSON.stringify(notices(team))).not.toContain('evidence/a/complete')
    expect(JSON.stringify(notices(team))).toContain('evidence/b/complete')
  })

  it('stops a standalone join on cancellation while preserving retained evidence and running siblings', async () => {
    const { adapter, team } = fixture()
    const controller = new AbortController()
    const joining = execute(team, 'spawn_agents', { tasks: tasks(), join: true }, controller.signal)
    await vi.waitFor(() => expect(adapter.workers.size).toBe(3))
    adapter.finishes.get('a')!.resolve()
    await team.awaitWorker('a')
    controller.abort(new Error('stop waiting'))
    expect(await joining).toMatchObject({ cancelled: true, workers: tasks().map(({ name }) => ({ target: name })) })
    expect(team.workers().find(worker => worker.name === 'b')!.status).toBe('running')
    expect(JSON.stringify(await execute(team, 'get_agent_result', { target: 'a' })))
      .toContain('evidence/a/complete')
    adapter.finishes.get('b')!.resolve()
    adapter.finishes.get('c')!.resolve()
    await team.whenQuiet()
    expect(notices(team).filter(message => JSON.stringify(message).includes('evidence/a/complete'))).toHaveLength(1)
    expect(JSON.stringify(notices(team))).toContain('evidence/b/complete')
  })

  it.each(['duplicate', 'role', 'writes'] as const)('rejects invalid %s batches before setup', async kind => {
    const factory = vi.fn(async () => ({}))
    const { team } = fixture({ workerSessionOptionsFactory: factory })
    let invalid: unknown = tasks().map(task => ({ ...task, writes: ['src/shared'] }))
    if (kind === 'duplicate') invalid = [tasks()[0], tasks()[0]]
    if (kind === 'role') invalid = [tasks()[0], { ...tasks()[1], role: 'unknown' }]
    await expect(execute(team, 'spawn_agents', { tasks: invalid })).rejects.toThrow()
    expect(factory).not.toHaveBeenCalled()
    expect(team.workers()).toEqual([])
    // Failed preflight releases every reservation.
    expect((await execute(team, 'spawn_agents', { tasks: tasks() })).workers).toHaveLength(3)
  })

  it('reports setup failure per worker and joins successful siblings', async () => {
    const { adapter, team } = fixture({ workerSessionOptionsFactory: request => {
      if (request.name === 'b') throw new Error('worker setup unavailable')
      return {}
    } })
    const joining = execute(team, 'spawn_agents', { tasks: tasks(), join: true })
    await vi.waitFor(() => expect(adapter.workers.size).toBe(2))
    for (const finish of adapter.finishes.values()) finish.resolve()
    const result = await joining
    expect(result.workers[1]).toEqual({ target: 'b', status: 'failed', error: 'worker setup unavailable' })
    expect(result.results).toHaveLength(2)
    expect(result.timed_out).toBe(false)
    expect(notices(team)).toHaveLength(0)
  })

  it('keeps worker failures explicit in joined evidence', async () => {
    const { adapter, team } = fixture()
    adapter.fail = 'b'
    const joining = execute(team, 'spawn_agents', { tasks: tasks(), join: true })
    await vi.waitFor(() => expect(adapter.workers.size).toBe(3))
    for (const finish of adapter.finishes.values()) finish.resolve()
    const result = await joining
    expect(result.results).toHaveLength(3)
    expect(result.results.find((item: { target: string }) => item.target === 'b'))
      .toMatchObject({ status: 'failed', error: expect.stringContaining('worker verification failed') })
    expect(notices(team)).toHaveLength(0)
  })

  it('returns captured partial results on user steering then pushes remaining results', async () => {
    const { adapter, team } = fixture({ autoLeadCoordination: false })
    const joining = execute(team, 'spawn_agents', { tasks: tasks(), join: true })
    await vi.waitFor(() => expect(adapter.workers.size).toBe(3))
    adapter.finishes.get('a')!.resolve()
    await team.awaitWorker('a')
    team.steer('Use the partial evidence')
    expect(await joining).toMatchObject({ interrupted: true, timed_out: false,
      results: [{ target: 'a', result: 'evidence/a/complete' }] })
    adapter.finishes.get('b')!.resolve()
    adapter.finishes.get('c')!.resolve()
    await team.whenQuiet()
    expect(JSON.stringify(notices(team))).not.toContain('evidence/a/complete')
    expect(JSON.stringify(notices(team))).toContain('evidence/b/complete')
  })

  it.each([false, true])('cancels invocation-owned workers, including during sibling setup (%s)', async slowSetup => {
    const setup = gate()
    const { adapter, team } = fixture({ workerSessionOptionsFactory: async request => {
      if (slowSetup && request.name === 'b') await setup.promise
      return {}
    } })
    const controller = new AbortController()
    const running = team.run('Start the batch', { signal: controller.signal })
    const finished = running.catch(() => undefined)
    await vi.waitFor(() => expect(adapter.workers.size).toBe(slowSetup ? 2 : 3))
    controller.abort(new Error('user cancelled batch'))
    await finished
    setup.resolve()
    await vi.waitFor(() => expect(team.workers()).toHaveLength(0))
    expect(adapter.leads).toHaveLength(1)
    expect([...adapter.workers.values()].every(request => request.signal!.aborted)).toBe(true)
  })

  it('does not transfer a standalone batch into an invocation that begins during setup', async () => {
    const setup = gate(), leadStep = gate(), enteredLead = gate()
    const { adapter, team } = fixture({ autoLeadCoordination: false,
      workerSessionOptionsFactory: async () => { await setup.promise; return {} },
      leadSessionOptions: { hooks: { beforeStep: async () => {
        enteredLead.resolve(); await leadStep.promise; return { kind: 'proceed' }
      } } },
    })
    adapter.spawn = false
    const starting = execute(team, 'spawn_agents', { tasks: tasks() })
    const controller = new AbortController()
    const running = team.run('Independent lead task', { signal: controller.signal }).catch(() => undefined)
    await enteredLead.promise
    setup.resolve()
    await starting
    await vi.waitFor(() => expect(adapter.workers.size).toBe(3))
    controller.abort(new Error('cancel independent lead'))
    leadStep.resolve()
    await running
    expect(team.workers()).toHaveLength(3)
    expect(team.workers().every(worker => worker.status === 'running')).toBe(true)
    for (const finish of adapter.finishes.values()) finish.resolve()
    await team.whenQuiet()
  })

  it('aborts preparing workers without late starts or leaked slots', async () => {
    const setup = gate()
    const { adapter, team } = fixture({ workerSessionOptionsFactory: async () => { await setup.promise; return {} } })
    const controller = new AbortController()
    const starting = execute(team, 'spawn_agents', { tasks: tasks(), join: true }, controller.signal)
    controller.abort(new Error('cancel setup'))
    expect(await starting).toMatchObject({ cancelled: true, coverage: { deficit: ['a', 'b', 'c'] } })
    setup.resolve()
    expect(team.workers()).toEqual([])
    expect(adapter.workers.size).toBe(0)
    expect((await execute(team, 'spawn_agents', { tasks: tasks() })).workers).toHaveLength(3)
  })

  it('filters batch spawning at depth limits and from inherited lead tools', async () => {
    const custom = defineTool({ name: 'spawn_agents', description: 'Host control',
      parameters: { type: 'object', properties: {} }, execute: () => 'unsafe' })
    const { team } = fixture({ maxDepth: 0, leadSessionOptions: { tools: [custom] } })
    expect((team.lead.options.tools as ToolRegistry).get('spawn_agents')).toBeUndefined()
    expect(team.lead.options.team!.instructions).not.toContain('spawn_agents')
    const lead = defineAgent({ id: 'lead', provider: 'test', model: 'scripted',
      instructions: 'Solve it.', tools: [custom] })
    expect(managedWorkerTools({ registry: new ModelRegistry(), lead, maxDepth: 2 }, lead, undefined, undefined)
      .names()).not.toContain('spawn_agents')
  })

})
