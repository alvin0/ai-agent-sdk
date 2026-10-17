import { describe, expect, it, vi } from 'vitest'
import { defineAgent, MANAGED_TEAM_FEATURES, ToolRegistry } from '@alvin0/ai-agent-sdk-core/agent'
import { CollaborationAdapter, answer, call, deferred, execute, managed } from './collaboration-support.ts'

function abortDeadline(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), ms)
  return controller.signal
}

describe('collaboration review regressions', () => {
  it('ends a lead with no spawns in exactly one model call and retains lead instructions', async () => {
    const adapter = new CollaborationAdapter((_name, round) => {
      if (round === 1) return call('task_create', { id: 'a', title: 'Lead-local work' })
      if (round === 2) return call('task_update', { id: 'a', expectedRevision: 1, action: 'annotate', notes: 'Done' })
      return answer('done')
    })
    const team = managed(adapter)
    await team.run('Work locally')
    expect(adapter.rounds.get('lead')).toBe(3) // Two tool rounds and one answer, no synthetic join round.
    expect(adapter.requests[0]?.options.system)
      .toContain('Inspect scope first; once fan-out is justified, plan partitions before reading bulk inputs')
    expect(adapter.requests[0]?.options.system).toContain('Collaboration mode:')
    const plain = new CollaborationAdapter()
    await managed(plain).run('Answer directly')
    expect(plain.rounds.get('lead')).toBe(1)
    expect(MANAGED_TEAM_FEATURES.collaboration).toBe(true)
  })

  it('allows long workers across hold slices without extra lead calls or the old 30 second cancellation', async () => {
    vi.useFakeTimers()
    const deadlines = vi.spyOn(AbortSignal, 'timeout').mockImplementation(abortDeadline)
    const started = deferred(), attempted = deferred(), finish = deferred()
    const adapter = new CollaborationAdapter(async (name, round) => {
      if (name === 'worker') { started.resolve(); await finish.promise; return answer('evidence') }
      if (round === 1) return call('spawn_agent', { name: 'worker', task: 'Long work' })
      if (round === 2) attempted.resolve()
      return answer('synthesis')
    })
    const team = managed(adapter, { workerTimeoutMs: 120_000, holdWaitMs: 10_000 })
    const running = team.run('Solve')
    try {
      await started.promise; await attempted.promise
      await vi.advanceTimersByTimeAsync(61_000)
      expect(adapter.rounds.get('lead')).toBe(2)
      expect(team.workers()[0]?.status).toBe('running')
      finish.resolve()
      expect((await running).text).toBe('synthesis')
      expect(adapter.rounds.get('lead')).toBe(3)
    } finally {
      finish.resolve()
      await running.catch(() => undefined)
      deadlines.mockRestore()
      vi.useRealTimers()
    }
  })

  it('cancels active members at the hard join cap and keeps idle outcomes and tools usable', async () => {
    const adapter = new CollaborationAdapter(async (name, round, options) => {
      if (name === 'idle') return answer('retained result')
      if (name === 'worker') {
        await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
        options.signal!.throwIfAborted()
      }
      return round === 1 ? call('spawn_agent', { name: 'worker', task: 'Stall' }) : answer('partial')
    })
    const team = managed(adapter, { collaboration: { joinTimeoutMs: 25 }, holdWaitMs: 1000 })
    await team.spawn({ name: 'idle', task: 'Finish' }); await team.awaitWorker('idle')
    await team.run('Join')
    expect(team.workers().map(worker => worker.name)).toEqual(['idle'])
    expect(team.team.members().find(member => member.name === 'idle')?.outcome)
      .toMatchObject({ kind: 'completed', text: 'retained result' })
    await execute(team, 'idle', 'task_create', { id: 'retained', title: 'Still attached' })
  })

  it('queues peer wakeups until a dependsOn-held worker starts, preserving their payloads', async () => {
    const producerStarted = deferred(), finishProducer = deferred()
    const adapter = new CollaborationAdapter(async name => {
      if (name === 'producer') { producerStarted.resolve(); await finishProducer.promise }
      return answer(`${name} done`)
    })
    const team = managed(adapter)
    await team.spawn({ name: 'sender', task: 'Send findings' }); await team.awaitWorker('sender')
    await team.spawn({ name: 'producer', task: 'Produce' }); await producerStarted.promise
    await team.spawn({ name: 'held', task: 'Consume', dependsOn: ['producer'] })
    await execute(team, 'sender', 'send_message', { target: 'held', message: 'Keep this queued context' })
    // Give an incorrectly scheduled wake enough real time to reach the adapter.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(adapter.rounds.has('held')).toBe(false)
    expect(team.team.members().find(member => member.name === 'held')?.status).toBe('pending')
    finishProducer.resolve()
    await team.whenQuiet(AbortSignal.timeout(1000))
    expect(adapter.rounds.get('held')).toBe(1)
    const held = adapter.requests.find(request => request.name === 'held')!.options
    expect(JSON.stringify(held.messages)).toContain('Keep this queued context')
    expect(held.system).toContain('terminal result is delivered automatically')
  })

  it('notifies a claimant when a reopened dependency blocks its task', async () => {
    const adapter = new CollaborationAdapter()
    const observing = managed(adapter)
    const observed = observing.collaboration!.board
    await observed.create('lead', { id: 'p', title: 'Producer' })
    await observed.update('lead', { id: 'p', expectedRevision: 1, action: 'claim' })
    await observed.update('lead', { id: 'p', expectedRevision: 2, action: 'complete' })
    await observed.create('lead', { id: 'c', title: 'Consumer', blockedBy: ['p'] })
    await observing.spawn({ name: 'alice', task: 'Consume' }); await observing.awaitWorker('alice')
    await observed.update('alice', { id: 'c', expectedRevision: 1, action: 'claim' })
    await observed.update('lead', { id: 'p', expectedRevision: 3, action: 'reopen' })
    await observing.team.whenIdle('alice')
    expect(adapter.rounds.get('alice')).toBe(2)
    expect(JSON.stringify(adapter.requests.at(-1)?.options.messages)).toContain("'c' is now blocked")
    expect(observed.list()[1]?.ready).toBe(false)
  })

  it('offers newly ready unclaimed work to one idle member once over repeated reopen/complete cycles', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter)
    const board = team.collaboration!.board
    await board.create('lead', { id: 'p', title: 'Producer' })
    await board.create('lead', { id: 'c', title: 'Pull work', blockedBy: ['p'] })
    await team.spawn({ name: 'alice', task: 'Wait' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'Wait' }); await team.awaitWorker('bob')
    await board.update('lead', { id: 'p', expectedRevision: 1, action: 'claim' })
    await board.update('lead', { id: 'p', expectedRevision: 2, action: 'complete' })
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(1000))
    // One offer per ready task: the other idle member does not spend a turn racing the same claim.
    expect([adapter.rounds.get('alice'), adapter.rounds.get('bob')].sort()).toEqual([1, 2])
    expect(JSON.stringify(adapter.requests.at(-1)?.options.messages)).toContain("'c' is ready and unclaimed")
    await board.update('lead', { id: 'p', expectedRevision: 3, action: 'reopen' })
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(1000))
    const before = new Map(adapter.rounds)
    await board.update('lead', { id: 'p', expectedRevision: 4, action: 'claim' })
    await board.update('lead', { id: 'p', expectedRevision: 5, action: 'complete' })
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(1000))
    expect(adapter.rounds).toEqual(before)
  })

  it('terminates an autonomous A/B reopen-complete wake cycle even when the host reopens work', async () => {
    const adapter = new CollaborationAdapter(async (name, round) => {
      if (round === 1) return answer('ready')
      const task = team.collaboration!.board.list()[0]!
      // Simulate a host/lead reopening B's producer whenever A sees its dependency complete.
      // Worker models themselves cannot reopen; the notification budget also bounds this stronger case.
      if (name === 'alice' && task.status === 'completed') {
        await board.update('lead', { id: 'p', expectedRevision: task.revision, action: 'reopen' })
      }
      if (name === 'bob' && task.status === 'pending') {
        await board.update('bob', { id: 'p', expectedRevision: task.revision, action: 'claim' })
        await board.update('bob', { id: 'p', expectedRevision: task.revision + 1, action: 'complete' })
      }
      return answer('handled board notice')
    })
    const team = managed(adapter)
    const board = team.collaboration!.board
    await board.create('lead', { id: 'p', title: 'Producer' })
    await board.create('lead', { id: 'c', title: 'Consumer', blockedBy: ['p'] })
    await team.spawn({ name: 'alice', task: 'A' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'B' }); await team.awaitWorker('bob')
    await board.update('alice', { id: 'c', expectedRevision: 1, action: 'claim' })
    await board.update('bob', { id: 'p', expectedRevision: 1, action: 'claim' })
    await board.update('bob', { id: 'p', expectedRevision: 2, action: 'complete' })
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(1000))
    expect(adapter.rounds.get('alice')).toBeLessThanOrEqual(4)
    expect(adapter.rounds.get('bob')).toBeLessThanOrEqual(3)
    // Repeat the same dependency lineage: no additional owner unblock or pull wakes are admitted.
    const rounds = new Map(adapter.rounds)
    const producer = board.list()[0]!
    if (producer.status === 'completed') {
      await board.update('lead', { id: 'p', expectedRevision: producer.revision, action: 'reopen' })
    }
    const revision = board.list()[0]!.revision
    await board.update('bob', { id: 'p', expectedRevision: revision, action: 'claim' })
    await board.update('bob', { id: 'p', expectedRevision: revision + 1, action: 'complete' })
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(1000))
    expect(adapter.rounds).toEqual(rounds)
  })

  it.each([undefined, new ToolRegistry()])('passes host tools through without generated tools: %s', async tools => {
    const worker = defineAgent({ id: 'worker', provider: 'test', model: 'scripted',
      mode: 'basic', instructions: 'Work' })
    const create = vi.fn((options: Parameters<typeof worker.createSession>[0]) => worker.createSession(options))
    const observedWorker = Object.create(worker) as typeof worker
    Object.defineProperty(observedWorker, 'createSession', { value: create })
    const team = managed(new CollaborationAdapter(), {
      collaboration: false, workerFactory: () => observedWorker,
      workerSessionOptions: tools === undefined ? {} : { tools },
    })
    await team.spawn({ name: 'worker', task: 'Work' }); await team.awaitWorker('worker')
    expect(create).not.toHaveBeenCalled() // Definition is cloned for capability narrowing.
    expect(team.workers()[0]?.result?.succeeded).toBe(true)
  })
})

describe('collaboration offer recovery', () => {
  it('re-offers a ready task when the member it was offered to closes', async () => {
    const adapter = new CollaborationAdapter()
    const team = managed(adapter)
    const board = team.collaboration!.board
    await board.create('lead', { id: 'p', title: 'Producer' })
    await board.create('lead', { id: 'c', title: 'Pull work', blockedBy: ['p'] })
    await team.spawn({ name: 'alice', task: 'Wait' }); await team.awaitWorker('alice')
    await team.spawn({ name: 'bob', task: 'Wait' }); await team.awaitWorker('bob')
    await board.update('lead', { id: 'p', expectedRevision: 1, action: 'claim' })
    await board.update('lead', { id: 'p', expectedRevision: 2, action: 'complete' })
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(1000))
    const offered = adapter.rounds.get('alice') === 2 ? 'alice' : 'bob'
    const other = offered === 'alice' ? 'bob' : 'alice'
    expect(adapter.rounds.get(other)).toBe(1)
    await team.closeWorker(offered)
    await team.collaboration!.whenMembersIdle(AbortSignal.timeout(1000))
    expect(adapter.rounds.get(other)).toBe(2)
  })
})
