import { describe, expect, it, vi } from 'vitest'
import { defineAgent } from '../../packages/core/src/agent/index.ts'
import { ModelRegistry } from '../../packages/core/src/index.ts'
import { execute, fixture, gate, notices, tasks, tool } from './helpers/team-batch-fixture.ts'
import { assertBatchMetadataBudget, BATCH_PAYLOAD_BYTES, batchPayload }
  from '../../packages/core/src/agent/team/managed-batch-payload.ts'
import { DELEGATION_STRATEGY } from '../../packages/core/src/agent/team/managed-controls.ts'

describe('managed batch queue and review regressions', () => {
  it('starts free slots and drains the default bounded queue FIFO without lead calls', async () => {
    const factory = vi.fn(async () => ({}))
    const { adapter, team } = fixture({ maxWorkers: 2, workerSessionOptionsFactory: factory })
    const work = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => ({ name, task: `Read ${name}`, item_id: `id-${name}` }))
    const result = await execute(team, 'spawn_agents', { tasks: work })
    expect(result.workers.map((worker: { status: string }) => worker.status))
      .toEqual(['running', 'running', 'queued', 'queued', 'queued', 'queued'])
    expect(result.coverage).toEqual({ completed: 0, failed: [], pending: work.map(item => item.item_id), deficit: [] })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(tool(team, 'spawn_agents').parameters)).toContain('\"maxItems\":6')
    await expect(execute(team, 'spawn_agents', { tasks: [{ task: 'overflow' }] }))
      .rejects.toThrow('0 free slots, 4 queued')
    await vi.waitFor(() => expect(adapter.workers.size).toBe(2))
    for (const [done, next] of [['a', 'c'], ['b', 'd'], ['c', 'e'], ['d', 'f']]) {
      adapter.finishes.get(done!)!.resolve()
      await vi.waitFor(() => expect(adapter.workers.has(next!)).toBe(true))
      expect(team.workers().filter(worker => worker.status === 'running').length).toBeLessThanOrEqual(2)
      expect(adapter.leads).toHaveLength(0)
    }
    adapter.finishes.get('e')!.resolve()
    adapter.finishes.get('f')!.resolve()
    await team.whenQuiet()
    const final = JSON.stringify(team.lead.snapshot().history)
    expect(final).toContain('Managed batch settlement')
    expect(final).toContain(String.raw`completed\":6`)
  })

  it('joins queued items across waves with exactly-once results and no waiting model calls', async () => {
    const { adapter, team } = fixture({ maxWorkers: 1 })
    const running = team.run('Map all three partitions')
    for (const name of ['a', 'b', 'c']) {
      await vi.waitFor(() => expect(adapter.workers.has(name)).toBe(true))
      expect(adapter.leads).toHaveLength(1)
      adapter.finishes.get(name)!.resolve()
    }
    await running
    expect(adapter.leads).toHaveLength(2)
    const result = adapter.leads[1]!.messages.flatMap(message => message.content)
      .find(block => block.type === 'tool-result')!
    expect(JSON.stringify(result)).toContain(String.raw`completed\":3`)
    for (const name of ['a', 'b', 'c']) {
      expect(JSON.stringify(result).split(`evidence/${name}/complete`)).toHaveLength(2)
    }
    expect(notices(team)).toHaveLength(0)
  })

  it.each([false, true])('drains queued items on call cancellation and returns addresses (join=%s)', async join => {
    const setup = gate()
    const { adapter, team } = fixture({ maxWorkers: 2, autoLeadCoordination: false,
      workerSessionOptionsFactory: async request => {
        if (request.name === 'b') await setup.promise
        return {}
      },
    })
    const controller = new AbortController()
    const starting = execute(team, 'spawn_agents', { tasks: tasks(), join }, controller.signal)
    await vi.waitFor(() => expect(adapter.workers.size).toBe(1))
    controller.abort(new Error('stop batch'))
    const result = await starting
    expect(result.workers.map((worker: { target: string }) => worker.target)).toEqual(['a', 'b', 'c'])
    expect(result).toMatchObject({ cancelled: true, coverage: { pending: ['a'], deficit: ['b', 'c'] } })
    setup.resolve()
    adapter.finishes.get('a')!.resolve()
    await team.whenQuiet()
    expect(adapter.workers.size).toBe(1)
    await team.spawn({ name: 'replacement', task: 'Slot is reusable' })
  })

  it('drains queued invocation-owned tasks when the lead invocation aborts', async () => {
    const { adapter, team } = fixture({ maxWorkers: 1 })
    const controller = new AbortController()
    const running = team.run('Map all partitions', { signal: controller.signal }).catch(() => undefined)
    await vi.waitFor(() => expect(adapter.workers.size).toBe(1))
    controller.abort(new Error('cancel invocation'))
    await running
    await team.whenQuiet()
    expect(adapter.workers.size).toBe(1)
    expect(team.workers()).toHaveLength(0)
    expect(adapter.leads).toHaveLength(1)
  })

  it('drains queued items on disposal without setup or late starts', async () => {
    const setup = vi.fn(async () => ({}))
    const { adapter, team } = fixture({ maxWorkers: 1, workerSessionOptionsFactory: setup })
    const joining = execute(team, 'spawn_agents', { tasks: tasks(), join: true })
    await vi.waitFor(() => expect(adapter.workers.size).toBe(1))
    await team.dispose()
    const result = await joining
    expect(result).toMatchObject({ cancelled: true, coverage: { pending: ['a'], deficit: ['b', 'c'] } })
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it.each(['depends_on', 'dependsOn'])('rejects %s on batch tasks before setup', async field => {
    const setup = vi.fn(async () => ({}))
    const { team } = fixture({ maxWorkers: 1, workerSessionOptionsFactory: setup })
    await expect(execute(team, 'spawn_agents', { tasks: [tasks()[0], { ...tasks()[1], [field]: ['a'] }] }))
      .rejects.toThrow('dependencies are not allowed')
    expect(setup).not.toHaveBeenCalled()
  })

  it.each(['lean', 'legacy'] as const)('blocks dependency and peer waits on queued siblings (%s)', async surface => {
    const { team } = fixture({ maxWorkers: 1, workerTeamTools: 'full', modelToolSurface: surface })
    await execute(team, 'spawn_agents', { tasks: tasks() })
    await expect(team.spawn({ task: 'Unsafe dependency', dependsOn: ['b'] })).rejects.toThrow('unknown dependency')
    expect(() => team.team.beginWait('a', ['b'])).toThrow('cannot peer-wait on a queued worker')
  })

  it('reports item ids for setup failure, worker failure and successful coverage', async () => {
    const { adapter, team } = fixture({ workerSessionOptionsFactory: request => {
      if (request.name === 'b') throw new Error('setup failed')
      return {}
    } })
    adapter.fail = 'c'
    const joining = execute(team, 'spawn_agents', {
      tasks: tasks().map(task => ({ ...task, item_id: `row-${task.name}` })), join: true,
    })
    await vi.waitFor(() => expect(adapter.workers.size).toBe(2))
    for (const finish of adapter.finishes.values()) finish.resolve()
    expect((await joining).coverage).toEqual({ completed: 1, failed: ['row-b', 'row-c'],
      pending: [], deficit: ['row-b', 'row-c'] })
  })

  it('marks empty successful output as a coverage deficit and pushes one final compact account', async () => {
    const { adapter, team } = fixture({ maxWorkers: 1 })
    adapter.textFor = () => ''
    await execute(team, 'spawn_agents', { tasks: [{ name: 'a', task: 'Read', item_id: 'row-1' }] })
    await vi.waitFor(() => expect(adapter.workers.has('a')).toBe(true))
    adapter.finishes.get('a')!.resolve()
    await team.whenQuiet()
    const history = JSON.stringify(team.lead.snapshot().history)
    expect(history.split('Managed batch settlement')).toHaveLength(2)
    expect(history).toContain('row-1')
    expect(history).toContain('deficit')
    expect(history).toContain(String.raw`completed\":0`)
  })

  it('rejects duplicate coverage ids before setup, including collisions with default addresses', async () => {
    const setup = vi.fn(async () => ({}))
    const { team } = fixture({ workerSessionOptionsFactory: setup })
    await expect(execute(team, 'spawn_agents', { tasks: [tasks()[0], { ...tasks()[1], item_id: 'a' }] }))
      .rejects.toThrow('duplicate batch item_id')
    expect(setup).not.toHaveBeenCalled()
    expect((await execute(team, 'spawn_agents', { tasks: tasks() })).workers).toHaveLength(3)
  })

  it('does not claim archived results through the inner barrier after reused-address setup fails', async () => {
    const { team } = fixture({ workerSessionOptionsFactory: () => { throw new Error('setup failed') } })
    const old = defineAgent({ id: 'old', provider: 'test', model: 'scripted', instructions: 'Read' })
      .createSession({ registry: new ModelRegistry() })
    team.team.attach(old, { name: 'a' })
    team.team.recordOutcome('a', { kind: 'completed', text: 'archived prior evidence' })
    team.team.detach('a')
    await execute(team, 'spawn_agents', { tasks: [tasks()[0]], join: true })
    expect(team.team.takeResults('lead', ['a'])).toMatchObject([{ text: 'archived prior evidence' }])
  })

  it('bounds the entire escaped join payload, including all diagnostics, and lists omitted targets', () => {
    const workers = Array.from({ length: 100 }, (_, index) => ({ target: `w${index}`, status: 'failed' as const,
      error: 'error'.repeat(500), warnings: ['warning'.repeat(1000)] }))
    const results = workers.map(worker => ({ target: worker.target, status: 'failed' as const,
      partial_result: '🧪\"'.repeat(2000), error: 'failed'.repeat(500) }))
    const result = batchPayload(workers, { completed: 0, failed: [], pending: [], deficit: [] }, results)
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(BATCH_PAYLOAD_BYTES)
    const workerTargets = new Set(workers.map(worker => worker.target))
    expect(result.omitted.length).toBeGreaterThan(0)
    expect(result.omitted.every(target => workerTargets.has(target))).toBe(true)
  })

  it('bounds worker warnings before returning nonjoining addresses', async () => {
    const { team } = fixture({ writeScopePolicy: 'warn' })
    const writes = Array.from({ length: 12 }, (_, index) => `src/${index}/${'long'.repeat(80)}`)
    const result = await execute(team, 'spawn_agents', { tasks: tasks().map(task => ({ ...task, writes })) })
    for (const worker of result.workers) {
      expect(worker.warnings.length).toBeLessThanOrEqual(4)
      expect(new TextEncoder().encode(JSON.stringify(worker.warnings)).byteLength).toBeLessThan(1100)
    }
  })

  it('exports tool-neutral delegation strategy and validates bounded host queue capacity', () => {
    expect(DELEGATION_STRATEGY).not.toContain('spawn_agents')
    for (const maxQueued of [-1, 1.5, 1025, Number.NaN]) {
      expect(() => fixture({ maxQueued })).toThrow('maxQueued')
    }
  })

  it('returns nonjoining addresses when aborted after a worker starts during sibling setup', async () => {
    const setup = gate()
    const { adapter, team } = fixture({ workerSessionOptionsFactory: async request => {
      if (request.name === 'b') await setup.promise
      return {}
    } })
    const controller = new AbortController()
    const starting = execute(team, 'spawn_agents', { tasks: tasks() }, controller.signal)
    await vi.waitFor(() => expect(adapter.workers.size).toBe(2))
    controller.abort(new Error('cancel during setup'))
    const result = await starting
    expect(result).toMatchObject({ cancelled: true, workers: [
      { target: 'a', status: 'running' }, { target: 'b', status: 'cancelled' }, { target: 'c', status: 'running' },
    ] })
    setup.resolve()
    for (const finish of adapter.finishes.values()) finish.resolve()
    await team.whenQuiet()
    expect(adapter.workers.size).toBe(2)
  })

  it('ignores late call cancellation and preserves final failed/completed coverage exactly once (P3)', async () => {
    const { adapter, team } = fixture({ maxWorkers: 1, workerSessionOptionsFactory: request => {
      if (request.name === 'a') throw new Error('first setup failed')
      return {}
    } })
    const controller = new AbortController()
    await execute(team, 'spawn_agents', { tasks: tasks(), join: false }, controller.signal)
    await vi.waitFor(() => expect(adapter.workers.has('b')).toBe(true))
    controller.abort(new Error('cancel remaining queue'))
    controller.abort(new Error('repeated late abort'))
    adapter.finishes.get('b')!.resolve()
    await vi.waitFor(() => expect(adapter.workers.has('c')).toBe(true))
    adapter.finishes.get('c')!.resolve()
    await team.whenQuiet()
    const messages = team.lead.history.messages().flatMap(message => message.content)
      .filter(block => block.type === 'text' && block.text.startsWith('Managed batch settlement: '))
    expect(messages).toHaveLength(1)
    const text = messages[0]!
    if (text.type !== 'text') throw new Error('missing account')
    expect(JSON.parse(text.text.slice('Managed batch settlement: '.length))).toEqual({ coverage: {
      completed: 2, failed: ['a'], pending: [], deficit: ['a'],
    } })
    expect(adapter.workers.has('c')).toBe(true)
  })

  it('reserves FIFO backlog capacity atomically across concurrent batches', async () => {
    const setup = gate()
    const factory = vi.fn(async () => { await setup.promise; return {} })
    const { adapter, team } = fixture({ maxWorkers: 1, maxQueued: 2, workerSessionOptionsFactory: factory })
    const first = execute(team, 'spawn_agents', { tasks: tasks().slice(0, 2) })
    const second = await execute(team, 'spawn_agents', { tasks: [tasks()[2]] })
    expect(second.workers).toEqual([{ target: 'c', status: 'queued' }])
    await expect(execute(team, 'spawn_agents', { tasks: [{ task: 'overflow' }] }))
      .rejects.toThrow('0 free slots, 2 queued')
    expect(factory).toHaveBeenCalledTimes(1)
    setup.resolve()
    await first
    for (const name of ['a', 'b', 'c']) {
      await vi.waitFor(() => expect(adapter.workers.has(name)).toBe(true))
      adapter.finishes.get(name)!.resolve()
    }
    await team.whenQuiet()
  })

  it('validates mandatory response bytes before admission so even metadata fits the aggregate budget', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `${index}-${'x'.repeat(120)}`)
    expect(() => assertBatchMetadataBudget(ids, ids)).toThrow('48 KiB payload budget')
  })

})
