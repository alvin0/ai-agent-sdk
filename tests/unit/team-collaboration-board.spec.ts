import { describe, expect, it } from 'vitest'
import { CollaborationTaskBoard } from '../../packages/core/src/agent/team/collaboration-board.ts'
import type { ManagedTeamCollaborationOptions } from '@alvin0/ai-agent-sdk-core/agent'

function board(options: ManagedTeamCollaborationOptions = {}, signal = new AbortController().signal) {
  return new CollaborationTaskBoard(options, { lead: 'lead', signal,
    assertMember(name) { if (!['lead', 'alice', 'bob'].includes(name)) throw new Error('unknown member') },
    changed() {},
  })
}

describe('collaboration task board', () => {
  it('admits exactly one racing claim and retains revision CAS', async () => {
    const tasks = board()
    await tasks.create('lead', { id: 'a', title: 'Investigate' })
    const claims = await Promise.allSettled(['alice', 'bob'].map(actor =>
      tasks.update(actor, { id: 'a', expectedRevision: 1, action: 'claim' })))
    expect(claims.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(claims[1]).toMatchObject({ reason: { code: 'TEAM_TASK_STALE_REVISION' } })
    expect(tasks.list()[0]).toMatchObject({ revision: 2, owner: 'alice', status: 'claimed' })
  })

  it('enforces owners, releases, reopens and shares bounded notes/results', async () => {
    const tasks = board()
    await tasks.create('lead', { id: 'a', title: 'Analyze' })
    await tasks.update('alice', { id: 'a', expectedRevision: 1, action: 'claim' })
    await expect(tasks.update('bob', { id: 'a', expectedRevision: 2, action: 'release' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_UNAUTHORIZED' })
    await tasks.update('bob', { id: 'a', expectedRevision: 2, action: 'annotate', notes: 'Shared finding' })
    await tasks.update('alice', { id: 'a', expectedRevision: 3, action: 'complete', result: 'Evidence' })
    expect(tasks.list()[0]).toMatchObject({ status: 'completed', notes: 'Shared finding', result: 'Evidence' })
    await tasks.update('lead', { id: 'a', expectedRevision: 4, action: 'reopen' })
    await tasks.update('bob', { id: 'a', expectedRevision: 5, action: 'claim' })
    await tasks.update('bob', { id: 'a', expectedRevision: 6, action: 'release' })
    expect(tasks.list()[0]).toMatchObject({ status: 'pending', result: '' })
    expect(tasks.list()[0]).not.toHaveProperty('owner')
    expect(Object.isFrozen(tasks.snapshot().tasks)).toBe(true)
  })

  it('rejects missing blockers, cycles and stale results after dependency changes', async () => {
    const tasks = board()
    await expect(tasks.create('lead', { id: 'bad', title: 'Missing', blockedBy: ['absent'] }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await tasks.create('lead', { id: 'a', title: 'Producer' })
    await tasks.create('lead', { id: 'b', title: 'Consumer', blockedBy: ['a'] })
    await expect(tasks.create('lead', { id: 'cycle', title: 'Self dependency', blockedBy: ['cycle'] }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await tasks.update('bob', { id: 'b', expectedRevision: 1, action: 'claim' })
    await expect(tasks.update('bob', { id: 'b', expectedRevision: 2, action: 'complete' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })
    await tasks.update('alice', { id: 'a', expectedRevision: 1, action: 'claim' })
    await tasks.update('alice', { id: 'a', expectedRevision: 2, action: 'complete' })
    expect(tasks.list()[1]?.ready).toBe(true)
    await tasks.update('bob', { id: 'b', expectedRevision: 2, action: 'complete' })
    await expect(tasks.update('lead', { id: 'a', expectedRevision: 3, action: 'reopen' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_HAS_DEPENDENTS' })
  })

  it('cancels queued mutations before commit and continues the queue', async () => {
    const controller = new AbortController()
    const tasks = board()
    const first = tasks.create('lead', { id: 'a', title: 'A' }, controller.signal)
    const second = tasks.create('lead', { id: 'b', title: 'B' }, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(first).rejects.toThrow('cancelled')
    await expect(second).rejects.toThrow('cancelled')
    expect(tasks.snapshot()).toEqual({ tasks: [] })
    await tasks.create('lead', { id: 'c', title: 'C' })
    expect(tasks.list().map(task => task.id)).toEqual(['c'])
  })

  it('allows only the lead to reopen completed work', async () => {
    const tasks = board()
    await tasks.create('lead', { id: 'a', title: 'A' })
    await tasks.update('alice', { id: 'a', expectedRevision: 1, action: 'claim' })
    await tasks.update('alice', { id: 'a', expectedRevision: 2, action: 'complete' })
    await expect(tasks.update('alice', { id: 'a', expectedRevision: 3, action: 'reopen' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_UNAUTHORIZED' })
    expect(tasks.list()[0]).toMatchObject({ revision: 3, status: 'completed' })
  })

  it('caps UTF-8 notes, task count and board bytes without partial updates', async () => {
    const tasks = board({ maxTasks: 1, maxTaskBytes: 220 })
    await tasks.create('lead', { id: 'a', title: 'A' })
    await expect(tasks.create('lead', { id: 'b', title: 'B' })).rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
    await expect(tasks.update('bob', { id: 'a', expectedRevision: 1, action: 'annotate', notes: '界'.repeat(80) }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
    expect(tasks.list()[0]?.revision).toBe(1)
    await expect(board({ maxBoardBytes: 50 }).create('lead', { id: 'a', title: 'A' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
  })

})
