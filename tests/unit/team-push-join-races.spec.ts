import { describe, expect, it, vi } from 'vitest'
import type { ManagedAgentTeam } from '@alvin0/ai-agent-sdk-core/agent'
import { isManagedTeamNotice } from '../../packages/core/src/agent/history/input-work.ts'
import { ManagedSettlements } from '../../packages/core/src/agent/team/managed-settlements.ts'
import { GatedTeam, create, deferred, tool } from './team-push-join.fixture.ts'

describe('managed settlement handoff races', () => {
  it('rejects a synthesis wake that throws before agent-end instead of re-waking forever', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter)
    const running = team.run('Research')
    const rejected = expect(running).rejects.toThrow('Lead synthesis failed: preparation failed')
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    const wake = vi.spyOn(team.lead, 'runPending').mockRejectedValue(new Error('preparation failed'))
    adapter.gates.get('w')!.resolve()
    await rejected
    expect(wake).toHaveBeenCalledTimes(1)
    expect(team.lead.lastOutcome()?.yielded).toBe(true)
  })

  it('bounds synthesis wakes when a host hook keeps yielding without new reports', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter, { leadSessionOptions: { hooks: {
      onTurnEnd: () => ({ kind: 'yield' }),
    } } })
    const running = team.run('Research')
    const rejected = expect(running).rejects.toThrow('yielded after 3 synthesis wakes without new worker reports')
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    const wake = vi.spyOn(team.lead, 'runPending')
    adapter.gates.get('w')!.resolve()
    await rejected
    expect(wake).toHaveBeenCalledTimes(4)
  })

  it('joins synthesis when the worker settles inside the lead agent-end observer', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter)
    let observerRan = false
    const response = await team.run('Research', { onEvent: async event => {
      if (event.type !== 'agent-end') return
      expect(team.lead.isRunning).toBe(true)
      expect(event.outcome.yielded).toBe(true)
      adapter.gates.get('w')!.resolve()
      await team.awaitWorker('w')
      observerRan = true
    } })
    expect(observerRan).toBe(true)
    expect(response.text).toBe('synthesis')
    expect(response.outcome.yielded).not.toBe(true)
    expect(adapter.leadRequests).toHaveLength(3)
  })

  it('joins settlements from an async scheduler-owned lead onAgentEvent observer', async () => {
    const adapter = new GatedTeam(['a', 'b'])
    let team!: ManagedAgentTeam
    let observed = false
    team = create(adapter, { team: { onAgentEvent: async (member, event) => {
      if (member !== 'lead' || event.type !== 'agent-end' || observed) return
      observed = true
      adapter.gates.get('b')!.resolve()
      await team.awaitWorker('b')
    } } })
    const running = team.run('Research')
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    adapter.gates.get('a')!.resolve()
    const response = await running
    expect(observed).toBe(true)
    expect(response.text).toBe('synthesis')
    expect(response.outcome.yielded).not.toBe(true)
    expect((await tool(team, 'wait_agents', { targets: ['a', 'b'] })).results).toEqual([])
  })

  it('never returns a yield across 40 seeded randomized settlement schedules', async () => {
    let seed = 0x19283
    for (let run = 0; run < 40; run++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const timing = seed % 5
      const adapter = new GatedTeam()
      const release = () => adapter.gates.get('w')!.resolve()
      const team = create(adapter, { leadSessionOptions: { hooks: { onTurnEnd: async () => {
        if (timing === 0) { release(); await Promise.resolve() }
        if (timing === 1) queueMicrotask(release)
        if (timing === 2) setTimeout(release, seed % 3)
      } } } })
      const running = team.run('Research', { onEvent: async event => {
        if (event.type === 'agent-end' && timing === 3) {
          release()
          await team.awaitWorker('w')
        }
      } })
      if (timing === 4) { await team.lead.whenIdle(); release() }
      const response = await running
      expect(response.text, `seed=${seed}, timing=${timing}`).toBe('synthesis')
      expect(response.outcome.yielded).not.toBe(true)
      expect(adapter.leadRequests.length).toBeLessThanOrEqual(3)
      await team.dispose()
    }
  }, 15_000)

  it('aborts whenQuiet promptly while a deferred flush is still waiting for lead idle', async () => {
    const idle = deferred()
    const controller = new AbortController()
    const lead = { whenIdle: () => idle.promise }
    const settlements = new ManagedSettlements({ signal: new AbortController().signal,
      invocationSignal: () => controller.signal, lead: () => lead,
      team: { subscribe: () => () => {} } } as never)
    settlements.deferReports()
    const waiting = settlements.whenFlushed(controller.signal)
    controller.abort(new Error('stop deferred flush'))
    await expect(waiting).rejects.toThrow('stop deferred flush')
    idle.resolve()
    settlements.dispose()
  })

  it('aborts a join during the scheduler lead observer without waiting for that observer', async () => {
    const adapter = new GatedTeam()
    const block = deferred()
    const entered = deferred()
    const team = create(adapter, { team: { onAgentEvent: async (member, event) => {
      if (member === 'lead' && event.type === 'agent-end') { entered.resolve(); await block.promise }
    } } })
    const controller = new AbortController()
    const running = team.run('Research', { signal: controller.signal })
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    adapter.gates.get('w')!.resolve()
    await entered.promise
    controller.abort(new Error('abort during synthesis observer'))
    try { await expect(running).rejects.toThrow('abort during synthesis observer') }
    finally { block.resolve() }
    await team.team.whenIdle('lead')
    expect((await team.run('Continue')).text).toBe('synthesis')
  })

  it('re-arms when another report arrives during a deferred flush', async () => {
    const first = { request: { name: 'a' }, leadDriven: true }
    const second = { request: { name: 'b' }, leadDriven: true }
    const workers = new Map([['a', first], ['b', second]])
    const received: string[][] = []
    let running = true
    let settlements!: ManagedSettlements
    const host = { signal: new AbortController().signal, workers, leadName: 'lead', options: {},
      invocationSignal: () => undefined, joining: () => true,
      lead: () => ({ get isRunning() { return running }, whenIdle: async () => { running = false } }),
      team: { subscribe: () => () => {}, releaseSlot: () => {}, wake: () => {}, messageByteLimit: 65536,
        takeResults: (_: string, names: string[]) => {
          received.push(names)
          return names.map(worker => ({ worker, status: 'completed', text: 'finding' }))
        }, sendMessage: async () => {
          if (received.length === 1) { running = true; await settlements.notify(second as never) }
        } },
    }
    settlements = new ManagedSettlements(host as never)
    await settlements.notify(first as never)
    await settlements.whenFlushed()
    expect(received).toEqual([['a'], ['b']])
    expect(settlements.hasPending).toBe(false)
    settlements.dispose()
  })

  it('keeps host workers and team reuse after an invocation abort', async () => {
    const adapter = new GatedTeam(['owned'])
    adapter.gates.set('host', deferred())
    const team = create(adapter)
    await team.spawn({ name: 'host', task: 'Independent host task' })
    const controller = new AbortController()
    const running = team.run('Research', { signal: controller.signal })
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    controller.abort(new Error('abort invocation'))
    await expect(running).rejects.toThrow('abort invocation')
    expect(team.workers().map(worker => worker.name)).toEqual(['host'])
    expect(team.workers()[0]?.status).toBe('running')
    adapter.gates.get('host')!.resolve()
    await team.awaitWorker('host')
    expect((await team.run('Continue')).text).toBe('synthesis')
    expect(team.steer('More context')).toBe(true)
    await team.whenQuiet()
  })

  it('rejects concurrent run even with automatic coordination disabled', async () => {
    const adapter = new GatedTeam()
    const team = create(adapter, { autoLeadCoordination: false })
    const block = deferred()
    const first = team.run('Research', { onEvent: async event => {
      if (event.type === 'agent-end') await block.promise
    } })
    await vi.waitFor(() => expect(team.lead.lastOutcome()).toBeDefined())
    await expect(team.run('Concurrent')).rejects.toThrow('already running')
    block.resolve()
    await first
  })

  it('marks settlement notices and includes outstanding workers and final synthesis guidance', async () => {
    const adapter = new GatedTeam(['a', 'b'])
    const team = create(adapter)
    const running = team.run('Research')
    await vi.waitFor(() => expect(team.lead.lastOutcome()?.yielded).toBe(true))
    adapter.gates.get('a')!.resolve()
    await team.awaitWorker('a')
    await team.team.whenIdle('lead')
    const notices = () => team.lead.history.messages().filter(message => message.source.kind === 'app'
      && message.source.producer === 'managed-team-settlement')
    expect(JSON.stringify(notices())).toContain('remaining: [\\"b\\"]')
    adapter.gates.get('b')!.resolve()
    await running
    expect(notices().every(message => isManagedTeamNotice(message as never))).toBe(true)
    expect(JSON.stringify(notices())).toContain('All workers settled — synthesize now.')
    expect(notices()).toHaveLength(2)
  })
})
