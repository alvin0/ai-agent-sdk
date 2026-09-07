import { describe, expect, it } from 'vitest'

const { EventProjector } = await import('../../samples/chat-agents/backend/src/event-projection.ts')
const { createMemberFeed } = await import('../../samples/chat-agents/backend/src/session.ts')

function feedWithLog() {
  const events: { t: string; member?: string }[] = []
  const feed = createMemberFeed(
    new EventProjector(),
    event => events.push(event as { t: string; member?: string }),
  )
  return {
    feed,
    events,
    lifecycle: () => events.filter(event => event.t.startsWith('member-')).map(event => event.t),
  }
}

const agentEnd = {
  type: 'agent-end',
  outcome: { reason: { kind: 'completed' }, text: 'done', mode: 'deep', completed: true },
}

describe('member lifecycle', () => {
  it('closes a member when it finishes, not when the run does', () => {
    const { feed, lifecycle } = feedWithLog()
    feed.handle('reviewer', { type: 'turn-start', turn: 1 } as never)
    feed.handle('reviewer', agentEnd as never)

    expect(lifecycle()).toEqual(['member-start', 'member-end'])
    // Nothing is left open, so the run's teardown has no member to close —
    // which is what used to keep every member shown as busy to the very end.
    expect([...feed.open]).toEqual([])
  })

  it('reopens a member that is woken again', () => {
    const { feed, lifecycle } = feedWithLog()
    feed.handle('reviewer', { type: 'turn-start', turn: 1 } as never)
    feed.handle('reviewer', agentEnd as never)
    feed.handle('reviewer', { type: 'turn-start', turn: 2 } as never)

    expect(lifecycle()).toEqual(['member-start', 'member-end', 'member-start'])
    expect([...feed.open]).toEqual(['reviewer'])
  })

  it('tracks members independently', () => {
    const { feed, events } = feedWithLog()
    feed.handle('reviewer', { type: 'turn-start', turn: 1 } as never)
    feed.handle('builder', { type: 'turn-start', turn: 1 } as never)
    feed.handle('reviewer', agentEnd as never)

    // One finishing must not close the other.
    expect([...feed.open]).toEqual(['builder'])
    expect(events.filter(event => event.t === 'member-end').map(event => event.member))
      .toEqual(['reviewer'])
  })

  it('tags a member run-end as the member, never as the run ending', () => {
    const { feed, events } = feedWithLog()
    feed.handle('reviewer', agentEnd as never)
    // A member's own outcome is not the run's: emitting `run-end` here would
    // stop the client rendering while the lead was still working.
    expect(events.some(event => event.t === 'run-end')).toBe(false)
  })
})
