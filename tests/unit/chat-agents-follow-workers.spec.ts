import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'follow-'))
process.env.CHAT_AGENTS_DB = join(home, '.data', 'test.db')
process.env.CHAT_AGENTS_WORKSPACE = join(home, 'sandbox')
process.env.CHAT_AGENTS_MIGRATIONS = join(process.cwd(), 'samples/chat-agents/backend/drizzle')

const { createDoorbell, followWorkers } =
  await import('../../samples/chat-agents/backend/src/session.ts')
const { EventProjector } = await import('../../samples/chat-agents/backend/src/event-projection.ts')

/**
 * A stand-in harness whose roster the test drives.
 *
 * `members()` answers for the lead as well, because a worker finishing wakes
 * the lead for the turn that synthesises — the thing the stream must stay open
 * for.
 */
function harness(initial: readonly { name: string; status: string; role?: string }[]) {
  let rows = [...initial]
  const closed: string[] = []
  return {
    closed,
    set(name: string, status: string) {
      rows = rows.map(row => (row.name === name ? { ...row, status } : row))
    },
    handle: {
      team: {
        members: () => rows.map(row => ({ ...row, role: row.role ?? 'peer' })),
      },
      workers: () => rows.filter(row => row.role !== 'lead'),
      closeWorker: async (name: string) => {
        closed.push(name)
        rows = rows.filter(row => row.name !== name)
        return 'completed'
      },
    },
  }
}

function scaffold(managed: unknown, abortOwner: AbortController) {
  const persisted: unknown[] = []
  const queued: unknown[] = []
  const live = {
    managed,
    abort: abortOwner,
    outbox: [] as unknown[],
  }
  return {
    persisted,
    queued,
    live,
    args: () => [
      live as never,
      abortOwner,
      createDoorbell(),
      queued as never,
      new EventProjector(),
      async (node: unknown) => { persisted.push(node) },
      // eslint-disable-next-line require-yield
      async function* () {} as never,
    ] as const,
  }
}

describe('following workers past the end of the lead run', () => {
  it('stays open while the lead writes its synthesis', async () => {
    const controller = new AbortController()
    const team = harness([
      { name: 'lead', status: 'idle', role: 'lead' },
      { name: 'ui-agent', status: 'running' },
    ])
    const parts = scaffold(team.handle, controller)
    const [live, owner, bell, queued, project, persist, drain] = parts.args()
    const stream = followWorkers(live, owner, bell, queued, project, persist, drain)

    expect((await stream.next()).value)
      .toMatchObject({ t: 'progress', message: 'Waiting for ui-agent' })

    // The worker finishes and its report wakes the lead. Closing here would
    // end the run at the exact moment the lead began the summary, which is
    // the whole reason a lead exists.
    team.set('ui-agent', 'idle')
    team.set('lead', 'running')
    bell.ring()
    expect((await stream.next()).value)
      .toMatchObject({ t: 'progress', message: 'Waiting for lead' })

    team.set('lead', 'idle')
    bell.ring()
    expect((await stream.next()).value).toMatchObject({ t: 'progress', message: null })
    expect((await stream.next()).done).toBe(true)
  }, 20_000)

  it('keeps reporting until they settle, then clears the line', async () => {
    const controller = new AbortController()
    const team = harness([{ name: 'ui-agent', status: 'running' }])
    const parts = scaffold(team.handle, controller)
    const [live, owner, bell, queued, project, persist, drain] = parts.args()

    const stream = followWorkers(live, owner, bell, queued, project, persist, drain)

    // The lead has answered; the worker has not. Closing the stream here would
    // leave the user with an answer and no sign of the agent still working.
    const first = await stream.next()
    // The label says WHAT is happening and nothing about how long: the client
    // counts elapsed time, because a number that only moves when the server
    // speaks sits frozen between reports.
    expect(first.value).toMatchObject({ t: 'progress', message: 'Waiting for ui-agent' })

    team.set('ui-agent', 'idle')
    bell.ring()
    const cleared = await stream.next()
    expect(cleared.value).toMatchObject({ t: 'progress', message: null })
    expect((await stream.next()).done).toBe(true)
  }, 20_000)

  it('repeats a progress line only when it changes', async () => {
    const controller = new AbortController()
    const team = harness([
      { name: 'ui-agent', status: 'running' },
      { name: 'logic-agent', status: 'running' },
    ])
    const parts = scaffold(team.handle, controller)
    const [live, owner, bell, queued, project, persist, drain] = parts.args()
    const stream = followWorkers(live, owner, bell, queued, project, persist, drain)

    expect((await stream.next()).value)
      .toMatchObject({ t: 'progress', message: 'Waiting for ui-agent, logic-agent' })

    // The doorbell rings on every worker event, and busy workers ring it many
    // times a second. A measured run against the sample sent 189 identical
    // "Waiting for…" events; the client counts elapsed time itself, so an
    // unchanged line is pure traffic that buries everything else.
    //
    // The proof has to be that a pull finding NOTHING CHANGED yields nothing at
    // all — a generator only produces when pulled, so asserting on what comes
    // out after a change would pass either way.
    bell.ring()
    bell.ring()
    bell.ring()
    const pulled = stream.next()
    const idle = Symbol('nothing yielded')
    const raced = await Promise.race([
      pulled,
      new Promise(resolve => setTimeout(() => resolve(idle), 250)),
    ])
    expect(raced).toBe(idle)

    team.set('ui-agent', 'idle')
    bell.ring()
    expect((await pulled).value)
      .toMatchObject({ t: 'progress', message: 'Waiting for logic-agent' })

    team.set('logic-agent', 'idle')
    bell.ring()
    expect((await stream.next()).value).toMatchObject({ t: 'progress', message: null })
    expect((await stream.next()).done).toBe(true)
  }, 20_000)

  it('stops when a new prompt takes the conversation over', async () => {
    const controller = new AbortController()
    const team = harness([{ name: 'ui-agent', status: 'running' }])
    const parts = scaffold(team.handle, controller)
    const [live, owner, bell, queued, project, persist, drain] = parts.args()
    const stream = followWorkers(live, owner, bell, queued, project, persist, drain)
    await stream.next()

    // A second run claims the session. Two streams draining the same outbox
    // and numbering the same transcript would interleave.
    ;(live as { abort: AbortController | undefined }).abort = new AbortController()
    bell.ring()
    const next = await stream.next()
    expect(next.value).toMatchObject({ t: 'progress', message: null })
    expect((await stream.next()).done).toBe(true)
    // The worker is still running, so its slot is left alone.
    expect(team.closed).toEqual([])
  }, 20_000)

  it('keeps following a worker that is only waiting its turn', async () => {
    const controller = new AbortController()
    const team = harness([
      { name: 'builder', status: 'running' },
      { name: 'auditor', status: 'pending' },
    ])
    const parts = scaffold(team.handle, controller)
    const [live, owner, bell, queued, project, persist, drain] = parts.args()
    const stream = followWorkers(live, owner, bell, queued, project, persist, drain)
    await stream.next()

    // The builder finishes and the auditor it was blocking has not started. A
    // run that ended here would abandon the queued half of the plan and close
    // the worker holding it.
    team.set('builder', 'idle')
    bell.ring()
    expect((await stream.next()).value)
      .toMatchObject({ t: 'progress', message: 'Waiting for auditor' })
    expect(team.closed).toEqual([])
  }, 20_000)

  it('reclaims the slots of workers that have settled', async () => {
    const controller = new AbortController()
    const team = harness([
      { name: 'done-agent', status: 'completed' },
      { name: 'broken-agent', status: 'failed' },
    ])
    const parts = scaffold(team.handle, controller)
    const [live, owner, bell, queued, project, persist, drain] = parts.args()

    for await (const _event of followWorkers(live, owner, bell, queued, project, persist, drain)) {
      // Nothing is running, so there is nothing to report.
    }
    // The SDK keeps a finished worker occupying one of `maxWorkers` until it is
    // closed. This app holds the harness for the whole conversation, so a lead
    // that forgets would exhaust the cap after a few prompts.
    expect(team.closed).toEqual(['done-agent', 'broken-agent'])
  }, 20_000)

  it('does nothing when the conversation has no harness', async () => {
    const controller = new AbortController()
    const parts = scaffold(undefined, controller)
    const [live, owner, bell, queued, project, persist, drain] = parts.args()
    const seen: unknown[] = []
    for await (const event of followWorkers(live, owner, bell, queued, project, persist, drain)) {
      seen.push(event)
    }
    // Every other mode has no workers to follow.
    expect(seen).toEqual([])
  }, 20_000)
})
