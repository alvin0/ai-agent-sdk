import { afterEach, describe, expect, it, vi } from 'vitest'
import { atDeadline } from '../../../packages/core/src/composition/lifecycle/bounded.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'

afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers()
  let now = 0
  const resources = new RuntimeResources({ ...createRuntimePlatform(), monotonicNow: () => now })
  return { resources, setNow: (value: number) => { now = value } }
}

describe('bounded capability calls', () => {
  it('does not call work when a queued microtask starts after its absolute deadline', async () => {
    const { resources, setNow } = fixture(), work = vi.fn()
    const result = atDeadline(resources, 10, work)
    setNow(20)
    await expect(result).rejects.toMatchObject({ reason: 'timed-out' })
    expect(work).not.toHaveBeenCalled()
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    resources.close()
  })

  it('aborts the supplied signal when a synchronous operation returns after its deadline', async () => {
    const { resources, setNow } = fixture()
    let captured!: AbortSignal
    const result = atDeadline(resources, 10, signal => { captured = signal; setNow(20); return 'late' })
    await expect(result).rejects.toMatchObject({ reason: 'timed-out' })
    expect(captured.aborted).toBe(true)
    expect(resources.pendingTimers).toBe(0)
    resources.close()
  })

  it('rejects already-aborted calls without scheduling work or retaining resources', async () => {
    const { resources } = fixture(), caller = new AbortController(), work = vi.fn()
    caller.abort('PRIVATE_BOUNDARY/REASON~SENTINEL%')
    const error = await atDeadline(resources, 10, work, caller.signal).catch(error => error as unknown)
    expect(error).toMatchObject({ reason: 'aborted' })
    expect(String(error)).not.toContain('PRIVATE_BOUNDARY/REASON~SENTINEL%')
    expect(work).not.toHaveBeenCalled()
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    resources.close()
  })

  it('does not expose a thrown capability error or retain a successful operation signal', async () => {
    const { resources } = fixture()
    const raw = Object.assign(new Error('PRIVATE_BOUNDARY/REASON~SENTINEL%'), { reason: 'aborted' })
    const error = await atDeadline(resources, 10, () => { throw raw }).catch(error => error as unknown)
    expect(error).toMatchObject({ reason: 'failed' })
    expect(String(error)).not.toContain('PRIVATE_BOUNDARY/REASON~SENTINEL%')
    let signal!: AbortSignal
    expect(await atDeadline(resources, 10, input => { signal = input; return 42 })).toBe(42)
    expect(signal.aborted).toBe(false)
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    resources.close()
    expect(signal.aborted).toBe(false)
  })
})
