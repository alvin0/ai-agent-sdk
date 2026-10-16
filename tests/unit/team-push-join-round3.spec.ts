import { describe, expect, it, vi } from 'vitest'
import { ManagedSettlements } from '../../packages/core/src/agent/team/managed-settlements.ts'
import { deferred } from './team-push-join.fixture.ts'

function settlementHarness(count: number) {
  const idle = deferred()
  const first = new AbortController()
  let invocation = first.signal
  const messages: string[] = []
  const workers = new Map(Array.from({ length: count }, (_, index) => {
    const name = `w${index}`
    return [name, { request: { name }, leadDriven: true, status: 'completed' }] as const
  }))
  const lead = { isRunning: false, whenIdle: vi.fn().mockResolvedValue(undefined) }
  const wake = vi.fn()
  const settlements = new ManagedSettlements({ signal: new AbortController().signal,
    invocationSignal: () => invocation, workers, lead: () => lead, leadName: 'lead',
    options: {}, joining: () => true,
    team: { recordTimeline: vi.fn(), subscribe: () => () => {}, wake, messageByteLimit: 65536,
      takeResults: (_recipient: string, names: string[]) => names.map(worker => ({ worker, text: 'finding' })),
      sendMessage: async (request: { message: string }) => { messages.push(request.message) },
    },
  } as never)
  for (const worker of workers.values()) settlements.pending(worker as never)
  return { settlements, messages, lead, wake, first, idle,
    nextInvocation: () => { invocation = new AbortController().signal } }
}

describe('managed settlement recovery and batch guidance', () => {
  it.each([false, true])('resumes a cancelled flush (old flush already drained: %s)', async drained => {
    const harness = settlementHarness(1)
    const { settlements, first, lead, idle } = harness
    lead.whenIdle.mockImplementationOnce(() => idle.promise)
    settlements.deferReports()
    first.abort(new Error('invocation A cancelled'))
    if (drained) await settlements.whenFlushed()
    expect(settlements.hasPending).toBe(true)
    harness.nextInvocation()
    settlements.resumeReports()
    await settlements.whenFlushed()
    expect(harness.messages).toHaveLength(1)
    expect(harness.wake).toHaveBeenCalledTimes(1)
    expect(settlements.hasPending).toBe(false)
    idle.resolve()
    settlements.dispose()
  })

  it('announces synthesis only on the final batch of 17 already settled workers', async () => {
    const { settlements, messages } = settlementHarness(17)
    settlements.deferReports()
    await settlements.whenFlushed()
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain('9 more worker reports follow.')
    expect(messages[1]).toContain('1 more worker report follows.')
    for (const message of messages.slice(0, -1)) {
      expect(message).not.toContain('All workers settled — synthesize now.')
    }
    expect(messages[2]).toContain('All workers settled — synthesize now.')
    const names = messages.flatMap(batchNames)
    expect(new Set(names).size).toBe(17)
    settlements.dispose()
  })
})

function batchNames(message: string): string[] {
  return JSON.parse(message.split('\n')[1]!).map((result: { worker: string }) => result.worker)
}
