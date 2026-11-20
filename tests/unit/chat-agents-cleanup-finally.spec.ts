import { beforeEach, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('../../samples/chat-agents/backend/src/conversations', () => ({ saveHistory: storage.save }))
import { cleanupPrompt } from '../../samples/chat-agents/backend/src/session/cleanup'
import { displacedRuns } from '../../samples/chat-agents/backend/src/session/ownership'

beforeEach(() => { storage.save.mockReset() })

it('closes all run handles and releases run ownership when persistence fails', async () => {
  const failure = new Error('fixture persistence failure')
  storage.save.mockRejectedValue(failure)
  let closed = 0, released = 0, original = 0
  for (let iteration = 0; iteration < 100; iteration++) {
    const controller = new AbortController()
    const live = { history: {}, outbox: [], abort: controller, steerRun: () => true, notify: () => {} }
    const input = { live, controller, id: 'fixture',
      handles: { close: async () => { closed++; throw new Error('fixture close failure') } },
      project: { flush: () => [], settled: () => [] }, persist: async () => {},
    } as unknown as Parameters<typeof cleanupPrompt>[0]
    try { await cleanupPrompt(input) } catch (error) { if (error === failure) original++ }
    if (live.abort === undefined && live.notify === undefined && live.steerRun === undefined) released++
  }
  console.log(JSON.stringify({ scenario: 'sample-persistence-failure-cleanup', attempts: 100,
    closed, released, original }))
  expect({ closed, released, original }).toEqual({ closed: 100, released: 100, original: 100 })
})

it('keeps persistence and close ordered when cleanup succeeds', async () => {
  const events: string[] = []
  storage.save.mockImplementation(async () => { events.push('history') })
  const controller = new AbortController()
  const input = {
    live: { history: {}, outbox: [{ node: 'outbox' }], abort: controller }, controller, id: 'fixture',
    handles: { close: async () => { events.push('close') } },
    project: { flush: () => ['flush'], settled: () => ['settled'] },
    persist: async (node: string) => { events.push(node) },
  } as unknown as Parameters<typeof cleanupPrompt>[0]
  await cleanupPrompt(input)
  expect(events).toEqual(['outbox', 'flush', 'settled', 'history', 'close'])
})

it('stops appending the displaced response when ownership changes during a write', async () => {
  const controller = new AbortController()
  const replacement = new AbortController()
  const live = { history: {}, outbox: [{ node: 'first' }, { node: 'second' }], abort: controller }
  const writes: string[] = []
  const close = vi.fn()
  const input = {
    live, controller, id: 'fixture', handles: { close },
    project: { flush: () => ['flush'], settled: () => ['settled'] },
    persist: async (node: string) => {
      writes.push(node)
      displacedRuns.add(controller)
      live.abort = replacement
    },
  } as unknown as Parameters<typeof cleanupPrompt>[0]
  await cleanupPrompt(input)
  expect(writes).toEqual(['first'])
  expect(live.abort).toBe(replacement)
  expect(close).toHaveBeenCalledOnce()
})
