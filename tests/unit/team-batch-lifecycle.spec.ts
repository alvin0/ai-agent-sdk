import { describe, expect, it, vi } from 'vitest'
import type { ManagedAgentTeam, ToolInterceptor } from '../../packages/core/src/agent/index.ts'
import { execute, fixture, gate, notices, tasks } from './helpers/team-batch-fixture.ts'

function expectTeamAccount(team: ManagedAgentTeam) {
  const accounts = team.lead.history.messages().filter(message => message.content.some(block =>
    block.type === 'text' && block.text.startsWith('Managed batch settlement: ')))
  expect(accounts).toHaveLength(1)
  expect(accounts[0]!.source).toEqual({ kind: 'app', producer: 'managed-team-settlement' })
  expect(JSON.stringify(accounts)).not.toContain('A2A message')
}

function expectFinalEvidence(team: ManagedAgentTeam, text: string) {
  for (const name of ['a', 'b', 'c']) {
    expect(text).toContain(`evidence/${name}/complete`)
    expect(notices(team).filter(message => JSON.stringify(message).includes(`evidence/${name}/complete`)))
      .toHaveLength(1)
  }
  expect(team.workers().map(worker => worker.status)).toEqual(['completed', 'completed', 'completed'])
  expectTeamAccount(team)
}

describe('batch ownership across lead turns (round 3 reviewer probes)', () => {
  it.each([false, true])('joins all FIFO waves after the call signal ends (join=%s)', async join => {
    let callSignal!: AbortSignal
    let callResult: unknown
    const interceptors: ToolInterceptor[] = [{ name: 'observe-batch-lifetime', around: async (call, next) => {
      const result = await next()
      if (call.toolName === 'spawn_agents' && !result.isError) {
        callSignal = call.signal
        callResult = result.value
      }
      return result
    } }]
    const { adapter, team } = fixture({ maxWorkers: 1,
      team: { minWaitTimeoutMs: 10, waitTimeoutMs: 100 },
      leadSessionOptions: { runtimeLimits: { maxToolDurationMs: 500 }, interceptors },
      workerSessionOptions: { interceptors },
    })
    adapter.join = join
    adapter.synthesize = options => {
      const input = JSON.stringify(options.messages)
      return ['a', 'b', 'c'].map(name => `evidence/${name}/complete`)
        .filter(text => input.includes(text)).join(', ') || 'waiting for evidence'
    }
    let returned = false
    const running = team.run('Map every partition and synthesize all results.')
      .then(response => { returned = true; return response })
    await vi.waitFor(() => {
      expect(callResult).toBeDefined()
      expect(team.lead.isRunning).toBe(false)
      expect(callSignal.aborted).toBe(true)
    })
    expect(callResult).toMatchObject({ workers: [
      { target: 'a', status: 'running' }, { target: 'b', status: 'queued' }, { target: 'c', status: 'queued' },
    ] })
    if (join) expect(callResult).toMatchObject({ timed_out: true, coverage: { pending: ['a', 'b', 'c'] } })
    expect(adapter.leads).toHaveLength(2)
    for (const name of ['a', 'b', 'c']) {
      await vi.waitFor(() => expect(adapter.workers.has(name)).toBe(true))
      expect(returned).toBe(false) // F4: no completed run with a queued or active partition.
      expect(team.workers().filter(worker => worker.status === 'running')).toHaveLength(1)
      adapter.finishes.get(name)!.resolve()
    }
    const response = await running
    expect(response.outcome.yielded).not.toBe(true)
    expectFinalEvidence(team, response.text)
    const finalInput = JSON.stringify(adapter.leads.at(-1)!.messages)
    expect(finalInput).toContain(String.raw`completed\":3`)
    expect((await execute(team, 'wait_agents', {})).results).toEqual([])
    const leadCalls = adapter.leads.length
    await team.whenQuiet()
    expect(adapter.leads).toHaveLength(leadCalls)
  })

  it('ignores a tool deadline after returning while the lead is still running (P2)', async () => {
    const deadline = new AbortController()
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 500 ? deadline.signal : originalTimeout(ms))
    const leadStep = gate()
    const enteredStep = gate()
    let steps = 0
    const { adapter, team } = fixture({ maxWorkers: 1,
      leadSessionOptions: { runtimeLimits: { maxToolDurationMs: 500 }, hooks: {
        beforeStep: async () => {
          if (++steps === 2) { enteredStep.resolve(); await leadStep.promise }
          return { kind: 'proceed' }
        },
      } },
    })
    adapter.join = false
    const running = team.run('Map every partition')
    await enteredStep.promise
    expect(team.lead.isRunning).toBe(true)
    deadline.abort(new DOMException('tool deadline elapsed', 'TimeoutError'))
    for (const name of ['a', 'b', 'c']) {
      await vi.waitFor(() => expect(adapter.workers.has(name)).toBe(true))
      adapter.finishes.get(name)!.resolve()
    }
    leadStep.resolve()
    await running
    expect(team.workers().map(worker => worker.status)).toEqual(['completed', 'completed', 'completed'])
  })

  it.each([false, true])('keeps invocation cancellation attached after returning (join=%s)', async join => {
    const { adapter, team } = fixture({ maxWorkers: 1,
      team: { minWaitTimeoutMs: 10, waitTimeoutMs: 100 },
    })
    adapter.join = join
    const controller = new AbortController()
    const running = team.run('Map all partitions', { signal: controller.signal })
    const finished = running.catch(() => undefined)
    await vi.waitFor(() => {
      expect(adapter.leads).toHaveLength(2)
      expect(team.lead.isRunning).toBe(false)
    })
    controller.abort(new Error('cancel invocation after the batch call returned'))
    await finished
    expect(adapter.leads).toHaveLength(2)
    await team.whenQuiet()
    expect([...adapter.workers.keys()]).toEqual(['a'])
    expect(team.workers()).toEqual([])
    expect(adapter.workers.get('a')!.signal!.aborted).toBe(true)
    await team.spawn({ name: 'b', task: 'The old queued reservation was released' })
    await vi.waitFor(() => expect(adapter.workers.has('b')).toBe(true))
    adapter.finishes.get('b')!.resolve()
    await team.awaitWorker('b')
  })

  it('explains that queued batch items have FIFO priority over single spawns (P6)', async () => {
    const { adapter, team } = fixture({ maxWorkers: 1, autoLeadCoordination: false })
    await execute(team, 'spawn_agents', { tasks: tasks() })
    await expect(execute(team, 'spawn_agent', { name: 'z', task: 'Do not bypass the queue' }))
      .rejects.toThrow('queued batch items are ahead of this spawn in FIFO order')
    for (const name of ['a', 'b', 'c']) {
      await vi.waitFor(() => expect(adapter.workers.has(name)).toBe(true))
      adapter.finishes.get(name)!.resolve()
    }
    await team.whenQuiet()
    expect([...adapter.workers.keys()]).toEqual(['a', 'b', 'c'])
  })
})
