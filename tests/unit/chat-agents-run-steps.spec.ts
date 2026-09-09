import { describe, expect, it } from 'vitest'

const { createDoorbell, runSteps } = await import('../../samples/chat-agents/backend/src/session.ts')

/** A lead stream the test controls: it emits only when told to. */
function controllableLead() {
  const pending: ((value: IteratorResult<string>) => void)[] = []
  const ready: IteratorResult<string>[] = []
  const settle = (value: IteratorResult<string>) => {
    const waiter = pending.shift()
    if (waiter === undefined) ready.push(value)
    else waiter(value)
  }
  return {
    emit: (value: string) => { settle({ value, done: false }) },
    end: () => { settle({ value: undefined as never, done: true }) },
    iterator: {
      next: async (): Promise<IteratorResult<string>> => {
        const immediate = ready.shift()
        if (immediate !== undefined) return immediate
        return await new Promise<IteratorResult<string>>((resolve) => { pending.push(resolve) })
      },
    } as AsyncIterator<string>,
  }
}

describe('runSteps', () => {
  it('wakes while the lead is silent — the team deadlock', async () => {
    const lead = controllableLead()
    const wake = createDoorbell()
    const steps = runSteps(lead.iterator, wake)

    // The lead is blocked, exactly as it is inside `wait_agents`. Iterating the
    // lead alone would park here forever, which is what stranded a member's
    // permission prompt and hung the whole run.
    const first = steps.next()
    let settled = false
    void first.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    wake.ring()
    expect(await first).toEqual({ value: { wake: true }, done: false })

    // And the lead still works afterwards.
    lead.emit('from-lead')
    expect(await steps.next()).toEqual({ value: { lead: 'from-lead' }, done: false })
    lead.end()
    expect((await steps.next()).done).toBe(true)
  })

  it('does not lose a ring that lands while nothing is waiting', async () => {
    const lead = controllableLead()
    const wake = createDoorbell()
    const steps = runSteps(lead.iterator, wake)
    // Rung before the generator ever asks for a step.
    wake.ring()
    expect(await steps.next()).toEqual({ value: { wake: true }, done: false })
  })

  it('closes the lead when the consumer abandons the run', async () => {
    const lead = controllableLead()
    let closed = false
    const iterator: AsyncIterator<string> = {
      next: lead.iterator.next.bind(lead.iterator),
      return: async () => { closed = true; return { value: undefined as never, done: true } },
    }
    const steps = runSteps(iterator, createDoorbell())
    lead.emit('one')
    await steps.next()
    // The browser disconnecting abandons the generator mid-loop.
    await steps.return(undefined as never)
    expect(closed).toBe(true)
  })
})
