import { describe, expect, it, vi } from 'vitest'
import { defineAgent } from '@alvin0/ai-agent-sdk-core/agent'
import { CollaborationAdapter, answer, call, deferred, execute, managed } from './collaboration-support.ts'

async function untilAborted(signal: AbortSignal): Promise<never> {
  if (!signal.aborted) {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  throw signal.reason
}

describe('collaboration shutdown regressions', () => {
  it('closes an entire dependency chain at the join deadline and leaves the lead answer final', async () => {
    const started = deferred()
    let heldIdle: Promise<void> | undefined
    const adapter = new CollaborationAdapter(async (name, round, options) => {
      if (name === 'a') { started.resolve(); return untilAborted(options.signal!) }
      if (name === 'b') return answer('orphan output')
      if (round === 1) return call('spawn_agent', { name: 'a', task: 'Run until cancelled' })
      if (round === 2) {
        await started.promise
        return call('spawn_agent', { name: 'b', task: 'Wait for A', dependsOn: ['a'] })
      }
      if (round === 3) heldIdle = team.team.whenIdle('b')
      return answer(round === 3 ? 'tentative answer' : 'final: dependency work unfinished')
    })
    const team = managed(adapter, { collaboration: { joinTimeoutMs: 25 }, holdWaitMs: 1000 })
    const response = await team.run('Solve')
    await team.whenQuiet(AbortSignal.timeout(1000))
    expect(response.text).toBe('final: dependency work unfinished')
    expect(adapter.rounds.has('b')).toBe(false)
    expect(team.workers()).toEqual([])
    expect(adapter.requests.at(-1)?.name).toBe('lead')
    expect(JSON.stringify(adapter.requests.at(-1)?.options.messages)).toContain('including pending workers')
    expect(heldIdle).toBeDefined()
    let settled = false
    void heldIdle!.then(() => { settled = true })
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 })
  })

  it.each(['definition', 'session options'])('cancels preparing %s and ignores its late completion', async stage => {
    const entered = deferred(), release = deferred()
    const worker = defineAgent({ id: 'worker', provider: 'test', model: 'scripted',
      mode: 'basic', instructions: 'Work' })
    const adapter = new CollaborationAdapter(() => answer('lead final'))
    const team = managed(adapter, { collaboration: { joinTimeoutMs: 25 }, holdWaitMs: 1000,
      workerFactory: async request => {
        if (request.name === 'preparing' && stage === 'definition') { entered.resolve(); await release.promise }
        return worker
      },
      workerSessionOptionsFactory: async request => {
        if (request.name === 'preparing' && stage === 'session options') { entered.resolve(); await release.promise }
        return {}
      },
    })
    const spawning = team.spawn({ name: 'preparing', task: 'Never reach the model' })
    const rejected = expect(spawning).rejects.toThrow()
    await entered.promise
    try {
      expect((await team.run('Join')).text).toBe('lead final')
      await rejected
      expect(team.workers()).toEqual([])
      // The host callback can ignore cancellation; its late value must not publish a session.
      release.resolve()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(adapter.rounds.has('preparing')).toBe(false)
      expect(team.team.members().map(member => member.name)).toEqual(['lead'])
      expect(adapter.requests.at(-1)?.name).toBe('lead')
    } finally { release.resolve() }
  })

  it('settles a failed spawn hold and drains a parked wake without starting the model', async () => {
    const started = deferred()
    const adapter = new CollaborationAdapter(async (name, _round, options) => {
      if (name === 'a') { started.resolve(); return untilAborted(options.signal!) }
      return answer('unexpected run')
    })
    const team = managed(adapter)
    await team.spawn({ name: 'a', task: 'Stall' }); await started.promise
    const markPending = team.team.markPending.bind(team.team)
    let held: Promise<void> | undefined
    let idle: Promise<void> | undefined
    const mark = vi.spyOn(team.team, 'markPending').mockImplementation((name, until) => {
      markPending(name, until)
      if (name === 'held' && until !== undefined) {
        held = until
        team.team.wake(name) // runWakeLoop is now parked on the held promise.
        idle = team.team.whenIdle(name)
        throw new Error('setup failed after holding')
      }
    })
    try {
      await expect(team.spawn({ name: 'held', task: 'Wait', dependsOn: ['a'] }))
        .rejects.toThrow('setup failed after holding')
      expect(held).toBeDefined()
      expect(idle).toBeDefined()
      // No cancellation signal is passed to these waits; failSpawn must settle the hold itself.
      let settled = false
      void Promise.all([held, idle]).then(() => { settled = true })
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 })
      expect(adapter.rounds.has('held')).toBe(false)
      expect(team.team.members().some(member => member.name === 'held')).toBe(false)
    } finally { mark.mockRestore() }
  })

  it('offers reopen only to the configured lead and still rejects forged worker reopen requests', async () => {
    const team = managed(new CollaborationAdapter(), { leadName: 'captain' })
    await team.spawn({ name: 'worker', task: 'Finish' }); await team.awaitWorker('worker')
    for (const [sender, actions] of [
      ['captain', ['claim', 'release', 'complete', 'reopen', 'annotate']],
      ['worker', ['claim', 'release', 'complete', 'annotate']],
    ] as const) {
      const tool = team.collaboration!.toolsFor(sender).find(tool => tool.name === 'task_update')!
      expect(tool.parameters).toMatchObject({ properties: { action: { enum: actions } } })
    }
    const board = team.collaboration!.board
    await board.create('captain', { id: 'a', title: 'Done' })
    await board.update('captain', { id: 'a', expectedRevision: 1, action: 'claim' })
    await board.update('captain', { id: 'a', expectedRevision: 2, action: 'complete' })
    await expect(execute(team, 'worker', 'task_update', { id: 'a', expectedRevision: 3, action: 'reopen' }))
      .rejects.toThrow(/lead/)
    expect(board.list()[0]?.status).toBe('completed')
    await execute(team, 'captain', 'task_update', { id: 'a', expectedRevision: 3, action: 'reopen' })
    expect(board.list()[0]?.status).toBe('pending')
  })
})
