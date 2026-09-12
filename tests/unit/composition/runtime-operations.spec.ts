import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeOperations } from '../../../packages/core/src/composition/lifecycle/operations.ts'
import { RUNTIME_OPERATION_KINDS, type OperationLease } from '../../../packages/core/src/composition/lifecycle/types.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const resources = new RuntimeResources(createRuntimePlatform())
  return { resources, operations: new RuntimeOperations(resources) }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('operation admission and settlement', () => {
  it('settles ordinary work, publishes synchronously once active, and releases deadline/listeners', async () => {
    const { resources, operations } = fixture()
    const caller = new AbortController()
    let value = 0
    let captured!: OperationLease
    const result = operations.execute('model-catalog', { signal: caller.signal, timeoutMs: 1_000 }, async lease => {
      captured = lease
      expect(lease.publish(() => { value = 1 })).toBe(true)
      return value
    })
    expect(operations.activeCount).toBe(1)
    expect(resources.pendingListeners).toBe(2)
    expect(await result).toBe(1)
    expect(captured.publish(() => { value = 2 })).toBe(false)
    expect(value).toBe(1)
    expect(operations.activeCount).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    expect(resources.pendingTimers).toBe(0)
    await operations.beginClose({ timeoutMs: 10 })
    operations.finishClose()
  })

  it('does not admit an already-aborted or invalid operation', () => {
    const { resources, operations } = fixture()
    const caller = new AbortController()
    caller.abort('PRIVATE_CALLER_REASON')
    expect(() => operations.acquire('agent-run', { signal: caller.signal })).toThrow(
      expect.objectContaining({ code: 'RUNTIME_OPERATION_ABORTED' }),
    )
    for (const timeoutMs of [0, -1, Number.NaN, 1.5]) {
      expect(() => operations.acquire('agent-run', { timeoutMs })).toThrow(RangeError)
    }
    expect(operations.activeCount).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    expect(resources.pendingTimers).toBe(0)
    resources.close()
  })

  it('aborts on the operation deadline and contains a late successful return', async () => {
    const { resources, operations } = fixture()
    const pending = deferred<string>()
    let signal!: AbortSignal
    const result = operations.execute('manual-compaction', { timeoutMs: 10 }, async lease => {
      signal = lease.signal
      return pending.promise
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(signal.aborted).toBe(true)
    pending.resolve('late success')
    await expect(result).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    expect(operations.activeCount).toBe(0)
    expect(resources.pendingTimers).toBe(0)
    await operations.beginClose({ timeoutMs: 10 })
    operations.finishClose()
  })

  it.each(RUNTIME_OPERATION_KINDS)('locks %s admission before option access and queued work dispatch', async kind => {
    const { operations } = fixture()
    const work = vi.fn(async () => 'should not start')
    const queued = operations.execute(kind, {}, work)
    const close = operations.beginClose({ timeoutMs: 10 })
    const readOptions = vi.fn(() => new AbortController().signal)
    const options = { get signal() { return readOptions() } }
    expect(operations.status).toBe('closing')
    expect(() => operations.execute(kind, options, work)).toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSING' }))
    expect(readOptions).not.toHaveBeenCalled()
    await expect(queued).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    await close
    operations.finishClose()
    expect(() => operations.execute(kind, options, work)).toThrow(expect.objectContaining({ code: 'RUNTIME_CLOSED' }))
    expect(work).not.toHaveBeenCalled()
    expect(readOptions).not.toHaveBeenCalled()
  })
})

describe('quiescence, shared close deadline and sealed generations', () => {
  it('always reports every kind, including zero counts, and requires quiescence before final cleanup', async () => {
    const { resources, operations } = fixture()
    // `beginClose()` derives `activeRunsAtClose`/`abortedRuns`/`unsettledRuns` from
    // `operations[0]`, so the first kind is load-bearing: new kinds are appended.
    expect(RUNTIME_OPERATION_KINDS[0]).toBe('agent-run')
    expect(() => operations.finishClose()).toThrow('not quiesced')
    expect(() => operations.remainingCloseMs()).toThrow('not started')
    const report = await operations.beginClose({ timeoutMs: 50 })
    expect(report).toEqual({
      quiescenceEnd: 'settled', deadlineReached: false,
      activeRunsAtClose: 0, abortedRuns: 0, unsettledRuns: 0,
      operations: RUNTIME_OPERATION_KINDS.map(kind => ({ kind, activeAtClose: 0, aborted: 0, settled: 0, unsettled: 0 })),
    })
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.operations)).toBe(true)
    expect(report.operations.every(Object.isFrozen)).toBe(true)
    operations.finishClose()
    operations.finishClose()
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
  })

  it('counts cooperative settlement and seals every remaining kind on timeout', async () => {
    const { resources, operations } = fixture()
    const leases = RUNTIME_OPERATION_KINDS.map(kind => operations.acquire(kind, { timeoutMs: 1_000 }))
    const cooperative = operations.acquire('agent-run')
    cooperative.signal.addEventListener('abort', () => cooperative.settle(), { once: true })
    const close = operations.beginClose({ timeoutMs: 30 })
    expect(() => operations.finishClose()).toThrow('not quiesced')
    expect(leases.every(lease => lease.signal.aborted)).toBe(true)
    await vi.advanceTimersByTimeAsync(30)
    const report = await close
    expect(report).toMatchObject({ quiescenceEnd: 'timeout', deadlineReached: true,
      activeRunsAtClose: 2, abortedRuns: 2, unsettledRuns: 1 })
    expect(report.operations).toEqual(RUNTIME_OPERATION_KINDS.map(kind => ({
      kind, activeAtClose: kind === 'agent-run' ? 2 : 1, aborted: kind === 'agent-run' ? 2 : 1,
      settled: kind === 'agent-run' ? 1 : 0, unsettled: 1,
    })))
    for (const lease of leases) {
      await lease.whenSealed
      expect(lease.publish(() => { throw new Error('late commit') })).toBe(false)
      lease.settle()
      lease.settle()
    }
    expect(report.operations.every(row => row.activeAtClose === row.settled + row.unsettled)).toBe(true)
    expect(report.unsettledRuns).toBe(1)
    expect(operations.activeCount).toBe(0)
    operations.finishClose()
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resolve', 'reject'] as const)('settles the caller wait and blocks late %s from publishing after sealing', async outcome => {
    const { operations } = fixture()
    const pending = deferred<string>(), started = deferred<void>(), finished = deferred<void>()
    const commits: string[] = []
    const result = operations.execute('model-catalog', {}, async lease => {
      started.resolve()
      try {
        const value = await pending.promise
        lease.publish(() => { commits.push(value) })
        return value
      } finally { finished.resolve() }
    })
    await started.promise
    const close = operations.beginClose({ timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(result).rejects.toMatchObject({ code: 'RUNTIME_OPERATION_ABORTED' })
    expect((await close).operations[1]).toMatchObject({ unsettled: 1 })
    operations.finishClose()
    if (outcome === 'resolve') pending.resolve('late catalog')
    else pending.reject(new Error('late provider failure'))
    await finished.promise
    await Promise.resolve()
    expect(commits).toEqual([])
    expect(operations.activeCount).toBe(0)
  })

  it.each([false, true])('caller abort accelerates quiescence without cancelling cleanup (already aborted: %s)', async already => {
    const { operations, resources } = fixture()
    const caller = new AbortController()
    const lease = operations.acquire('team-operation')
    if (already) caller.abort('PRIVATE_ABORT/REASON~SENTINEL%')
    const close = operations.beginClose({ timeoutMs: 100, signal: caller.signal })
    expect(operations.status).toBe('closing')
    if (!already) caller.abort('PRIVATE_ABORT/REASON~SENTINEL%')
    const report = await close
    expect(report).toMatchObject({ quiescenceEnd: 'caller-abort', deadlineReached: false })
    expect(report.operations[3]).toMatchObject({ aborted: 1, unsettled: 1 })
    expect(JSON.stringify(report)).not.toContain('PRIVATE_ABORT/REASON~SENTINEL%')
    await lease.whenSealed
    // The owner remains available for the component-cleanup/flush stages.
    const cleaned = vi.fn()
    resources.after(0, cleaned)
    await vi.advanceTimersByTimeAsync(0)
    expect(cleaned).toHaveBeenCalledTimes(1)
    operations.finishClose()
  })

  it('aborts every lease before an already-aborted close caller can seal the remaining leases', async () => {
    const { operations } = fixture()
    const cooperative = operations.acquire('agent-run')
    cooperative.signal.addEventListener('abort', () => cooperative.settle(), { once: true })
    const remaining = operations.acquire('model-catalog')
    const caller = new AbortController()
    caller.abort()
    const report = await operations.beginClose({ timeoutMs: 50, signal: caller.signal })
    expect(remaining.signal.aborted).toBe(true)
    expect(report.operations[1]).toMatchObject({ activeAtClose: 1, aborted: 1, unsettled: 1 })
    operations.finishClose()
  })

  it('joins the first close task, including reentrant close, without reading later options', async () => {
    const { operations } = fixture()
    const lease = operations.acquire('agent-run')
    const readLater = vi.fn(() => { throw new Error('must not read') })
    const later = { get timeoutMs(): number { return readLater() } }
    let reentrant: ReturnType<RuntimeOperations['beginClose']> | undefined
    lease.signal.addEventListener('abort', () => { reentrant = operations.beginClose(later) }, { once: true })
    const first = operations.beginClose({ timeoutMs: 20 })
    expect(reentrant).toBe(first)
    expect(operations.beginClose(later)).toBe(first)
    await vi.advanceTimersByTimeAsync(20)
    const report = await first
    operations.finishClose()
    expect(await operations.beginClose(later)).toBe(report)
    expect(readLater).not.toHaveBeenCalled()
  })

  it('does not grant a fresh deadline after synchronous abort callbacks consume time', async () => {
    const { operations, resources } = fixture()
    let now = 0
    // Capture a controlled clock through a new immutable internal platform.
    const controlled = new RuntimeResources({ ...resources.platform, monotonicNow: () => now })
    const owner = new RuntimeOperations(controlled)
    const lease = owner.acquire('agent-run')
    lease.signal.addEventListener('abort', () => { now = 35 }, { once: true })
    const close = owner.beginClose({ timeoutMs: 50 })
    expect(owner.remainingCloseMs()).toBe(15)
    await vi.advanceTimersByTimeAsync(14)
    expect(owner.activeCount).toBe(1)
    now = 50
    await vi.advanceTimersByTimeAsync(1)
    expect((await close).quiescenceEnd).toBe('timeout')
    expect(owner.remainingCloseMs()).toBe(0)
    owner.finishClose()
    await operations.beginClose({ timeoutMs: 1 })
    operations.finishClose()
  })
})
