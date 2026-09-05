import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { defineObservationExporter } from '../../../packages/core/src/composition/exporter/definition.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import { DeliveryAttempt } from '../../../packages/core/src/composition/delivery/attempt.ts'
import { validateDeliveryAck } from '../../../packages/core/src/composition/delivery/ack.ts'
import { deferred } from './exporter-fixtures.ts'
import { deliveryBatch } from './delivery-fixtures.ts'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => vi.useRealTimers())

function fullAck(batch: ObservationDeliveryBatch): ObservationDeliveryAck {
  return { batchId: batch.id, acceptedEventIds: batch.events.map(event => event.eventId), acceptedRunIds: batch.runRecords.map(record => record.runId) }
}

function fixture(batch: ObservationDeliveryBatch, send: (batch: ObservationDeliveryBatch, signal: AbortSignal) => unknown) {
  const resources = new RuntimeResources(createRuntimePlatform())
  const invoke = vi.fn(send)
  const exporter = defineObservationExporter({ id: 'fixture', supportedBoundaries: ['local-durable'],
    // Negative conformance cases deliberately return malformed wire acknowledgments.
    export: async (batch, signal) => await invoke(batch, signal) as ObservationDeliveryAck })
  return { resources, invoke, attempt: new DeliveryAttempt(batch, { exporter, ownership: 'borrowed', requirement: 'required', boundary: 'local-durable' }, resources) }
}

describe('exact acknowledgment validation', () => {
  it.each(['batch', 'foreign-event', 'foreign-run', 'duplicate-event', 'sparse', 'missing-events', 'missing-runs', 'legacy-ack', 'getter'])('rejects %s acknowledgments atomically', async variant => {
    const batch = await deliveryBatch()
    const ack: Record<string, unknown> = { ...fullAck(batch) }
    const get = vi.fn()
    if (variant === 'batch') ack.batchId = 'foreign'
    if (variant === 'foreign-event') ack.acceptedEventIds = ['foreign']
    if (variant === 'foreign-run') ack.acceptedRunIds = ['foreign']
    if (variant === 'duplicate-event') ack.acceptedEventIds = [batch.events[0]!.eventId, batch.events[0]!.eventId]
    if (variant === 'sparse') ack.acceptedEventIds = new Array(1)
    if (variant === 'missing-events' || variant === 'legacy-ack') delete ack.acceptedEventIds
    if (variant === 'missing-runs' || variant === 'legacy-ack') delete ack.acceptedRunIds
    if (variant === 'legacy-ack') { ack.accepted = true; ack.retryable = false }
    if (variant === 'getter') Object.defineProperty(ack, 'acceptedRunIds', { get })
    expect(() => validateDeliveryAck(ack, batch)).toThrow(expect.objectContaining({ code: 'OBSERVATION_ACK_INVALID' }))
    expect(get).not.toHaveBeenCalled()
    const { attempt, resources } = fixture(batch, () => ack)
    expect(await attempt.send(100)).toMatchObject({ status: 'failed', acceptedEventIds: [], acceptedRunIds: [], boundary: 'none' })
    resources.close()
  })

  it('detaches acknowledgment arrays and contains reflection failures', async () => {
    const batch = await deliveryBatch(), ack = fullAck(batch)
    const accepted = validateDeliveryAck(ack, batch)
    ;(ack.acceptedEventIds as string[]).length = 0
    expect(accepted.acceptedEventIds).toHaveLength(1)
    expect(Object.isFrozen(accepted.acceptedRunIds)).toBe(true)
    const input = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('PRIVATE_ACK/BODY~SENTINEL%') } })
    try { validateDeliveryAck(input, batch); throw new Error('Expected failure') } catch (error) {
      expect(error).toMatchObject({ code: 'OBSERVATION_ACK_INVALID' })
      expect(String(error)).not.toContain('PRIVATE_ACK/BODY~SENTINEL%')
      expect((error as Error).cause).toBeUndefined()
    }
  })
})

describe('bounded exporter delivery and stable retry identity', () => {
  it.each(['before-send', 'during-send'] as const)('contains runtime resource shutdown %s', async when => {
    const batch = await deliveryBatch(), pending = deferred<ObservationDeliveryAck>(), entered = deferred<void>()
    const { attempt, resources, invoke } = fixture(batch, () => { entered.resolve(); return pending.promise })
    if (when === 'before-send') resources.close()
    const result = attempt.send(100)
    if (when === 'during-send') { await entered.promise; resources.close() }
    expect(await result).toMatchObject({ status: 'closed', complete: false, error: { code: 'OBSERVATION_DELIVERY_CLOSED' } })
    expect(invoke).toHaveBeenCalledTimes(when === 'before-send' ? 0 : 1)
    pending.resolve(fullAck(batch))
    await Promise.resolve()
    expect(await attempt.send(100)).toMatchObject({ status: 'closed', acceptedEventIds: [], acceptedRunIds: [] })
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
  })

  it('accumulates separate event/run acknowledgments across retries of the exact same batch', async () => {
    const batch = await deliveryBatch(), saved = JSON.stringify(batch)
    let calls = 0
    const { attempt, resources, invoke } = fixture(batch, input => {
      expect(input).toBe(batch)
      expect(input.runRecords[0]).toBe(batch.runRecords[0])
      return ++calls === 1 ? { batchId: input.id, acceptedEventIds: [input.events[0]!.eventId], acceptedRunIds: [] }
        : { batchId: input.id, acceptedEventIds: [], acceptedRunIds: [input.runRecords[0]!.runId] }
    })
    expect(await attempt.send(100)).toMatchObject({ status: 'partial', complete: false, boundary: 'none', acceptedRunIds: [] })
    expect(await attempt.send(100)).toMatchObject({ status: 'complete', complete: true, boundary: 'local-durable' })
    expect(await attempt.send(100)).toMatchObject({ complete: true })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(batch)).toBe(saved)
    expect(resources.pendingTimers).toBe(0)
    expect(resources.pendingListeners).toBe(0)
    resources.close()
  })

  it('retains previous acceptance when a later acknowledgment is invalid', async () => {
    const batch = await deliveryBatch()
    let calls = 0
    const { attempt, resources } = fixture(batch, input => ++calls === 1
      ? { batchId: input.id, acceptedEventIds: [], acceptedRunIds: [input.runRecords[0]!.runId] }
      : { ...fullAck(input), acceptedEventIds: ['foreign'] })
    const first = await attempt.send(100)
    const second = await attempt.send(100)
    expect(second).toMatchObject({ status: 'failed', complete: false, acceptedEventIds: [], acceptedRunIds: first.acceptedRunIds })
    resources.close()
  })

  it('joins concurrent sends and ignores later cancellation/budget replacements', async () => {
    const batch = await deliveryBatch(), pending = deferred<ObservationDeliveryAck>(), entered = deferred<void>()
    const { attempt, resources, invoke } = fixture(batch, () => { entered.resolve(); return pending.promise })
    const first = attempt.send(100)
    await entered.promise
    const controller = new AbortController()
    controller.abort()
    expect(attempt.send(0, controller.signal)).toBe(first)
    pending.resolve(fullAck(batch))
    expect(await first).toMatchObject({ complete: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    resources.close()
  })

  it('retries a contained exporter failure without changing accounting or record identity', async () => {
    const batch = await deliveryBatch()
    let calls = 0
    const { attempt, resources } = fixture(batch, input => {
      if (++calls === 1) throw new Error('PRIVATE_EXPORT/BODY~SENTINEL%')
      return fullAck(input)
    })
    const failed = await attempt.send(100)
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'OBSERVABILITY_EXPORT_FAILED' } })
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_EXPORT/BODY~SENTINEL%')
    expect(await attempt.send(100)).toMatchObject({ status: 'complete' })
    expect(batch.runRecords[0]!.usage.reported.totalTokens).toBe(17)
    resources.close()
  })

  it.each(['timeout', 'caller', 'seal'] as const)('contains a late acknowledgment after %s without committing acceptance', async mode => {
    const batch = await deliveryBatch(), pending = deferred<ObservationDeliveryAck>(), entered = deferred<void>(), caller = new AbortController()
    let signal!: AbortSignal
    const { attempt, resources } = fixture(batch, (_batch, input) => { signal = input; entered.resolve(); return pending.promise })
    const result = attempt.send(10, caller.signal)
    await entered.promise
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10)
    else if (mode === 'caller') caller.abort('PRIVATE_ABORT/BODY~SENTINEL%')
    else attempt.seal()
    expect(await result).toMatchObject({ status: mode === 'timeout' ? 'timed-out' : mode === 'caller' ? 'aborted' : 'closed',
      acceptedEventIds: [], acceptedRunIds: [], complete: false })
    expect(signal.aborted).toBe(true)
    pending.resolve(fullAck(batch))
    await Promise.resolve()
    attempt.seal()
    expect(await attempt.send(100)).toMatchObject({ status: 'closed', acceptedEventIds: [], acceptedRunIds: [] })
    expect(resources.pendingListeners).toBe(0)
    expect(resources.pendingTimers).toBe(0)
    resources.close()
  })

  it('checks cancellation again if ack reflection aborts or seals the attempt', async () => {
    const batch = await deliveryBatch(), caller = new AbortController()
    const ack = new Proxy(fullAck(batch), { getOwnPropertyDescriptor(target, key) {
      if (key === 'acceptedRunIds') caller.abort()
      return Reflect.getOwnPropertyDescriptor(target, key)
    } })
    const { attempt, resources } = fixture(batch, () => ack)
    expect(await attempt.send(100, caller.signal)).toMatchObject({ status: 'aborted', acceptedEventIds: [], acceptedRunIds: [] })
    resources.close()
  })

  it('does not accept a late synchronous acknowledgment validation after the shared deadline', async () => {
    const batch = await deliveryBatch()
    const ack = new Proxy(fullAck(batch), { getOwnPropertyDescriptor(target, key) {
      if (key === 'acceptedRunIds') vi.advanceTimersByTime(20)
      return Reflect.getOwnPropertyDescriptor(target, key)
    } })
    const { attempt, resources } = fixture(batch, () => ack)
    expect(await attempt.send(10)).toMatchObject({ status: 'timed-out', acceptedEventIds: [], acceptedRunIds: [] })
    resources.close()
  })
})
