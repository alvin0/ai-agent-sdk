import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { DeliveryCheckpoint } from '../../../packages/core/src/composition/delivery/checkpoint.ts'
import { defineObservationExporter } from '../../../packages/core/src/composition/exporter/definition.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../../../packages/core/src/composition/exporter/types.ts'
import { deferred } from './exporter-fixtures.ts'
import { deliveryBatch } from './delivery-fixtures.ts'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => vi.useRealTimers())

function ack(batch: ObservationDeliveryBatch): ObservationDeliveryAck {
  return { batchId: batch.id, acceptedEventIds: batch.events.map(value => value.eventId), acceptedRunIds: batch.runRecords.map(value => value.runId) }
}

function registration(id: string, requirement: 'required' | 'best-effort', boundary: 'local-durable' | 'remote-acknowledged',
  send: (batch: ObservationDeliveryBatch, signal: AbortSignal) => Promise<ObservationDeliveryAck> | ObservationDeliveryAck): RuntimeObservationExporterRegistration {
  return { exporter: defineObservationExporter({ id, supportedBoundaries: [boundary], export: async (batch, signal) => await send(batch, signal) }),
    requirement, boundary, ownership: 'borrowed' }
}

describe('multi-exporter checkpoint barrier', () => {
  it('requires every required exporter and reports the weakest common boundary', async () => {
    const batch = await deliveryBatch(), calls: string[] = [], resources = new RuntimeResources(createRuntimePlatform())
    const checkpoint = new DeliveryCheckpoint(batch, [
      registration('remote', 'required', 'remote-acknowledged', input => { calls.push('remote'); return ack(input) }),
      registration('local', 'required', 'local-durable', input => { calls.push('local'); return ack(input) }),
    ], resources)
    const result = await checkpoint.run(100)
    expect(calls).toEqual(['remote', 'local'])
    expect(result).toMatchObject({ status: 'complete', requiredComplete: true, complete: true, reachedBoundary: 'local-durable' })
    expect(result.exporters.map(row => row.delivery.boundary)).toEqual(['remote-acknowledged', 'local-durable'])
    resources.close()
  })

  it('does not let best-effort failure block the required checkpoint', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform())
    const checkpoint = new DeliveryCheckpoint(batch, [
      registration('required', 'required', 'remote-acknowledged', ack),
      registration('optional', 'best-effort', 'local-durable', () => { throw new Error('PRIVATE_EXPORT/BODY~SENTINEL%') }),
    ], resources)
    const result = await checkpoint.run(100)
    expect(result).toMatchObject({ status: 'required-complete', requiredComplete: true, complete: false, reachedBoundary: 'remote-acknowledged' })
    expect(result.exporters[1]).toMatchObject({ requirement: 'best-effort', delivery: { status: 'failed', error: { code: 'OBSERVABILITY_EXPORT_FAILED' } } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_EXPORT/BODY~SENTINEL%')
    resources.close()
  })

  it('retries only incomplete attempts while preserving the same batch identity', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform()), seen: ObservationDeliveryBatch[] = []
    let flaky = 0, stable = 0
    const checkpoint = new DeliveryCheckpoint(batch, [
      registration('stable', 'required', 'local-durable', input => { stable++; seen.push(input); return ack(input) }),
      registration('flaky', 'required', 'local-durable', input => { flaky++; seen.push(input); if (flaky === 1) throw new Error('failed'); return ack(input) }),
    ], resources)
    expect(await checkpoint.run(100)).toMatchObject({ status: 'incomplete', requiredComplete: false })
    expect(await checkpoint.run(100)).toMatchObject({ status: 'complete', requiredComplete: true })
    expect(stable).toBe(1)
    expect(flaky).toBe(2)
    expect(seen.every(value => value === batch)).toBe(true)
    expect(seen.every(value => value.runRecords[0] === batch.runRecords[0])).toBe(true)
    resources.close()
  })

  it('retains partial acceptance across a malformed retry response', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform()), firstEvent = batch.events[0]!.eventId
    let call = 0
    const checkpoint = new DeliveryCheckpoint(batch, [registration('partial', 'required', 'local-durable', input => ++call === 1
      ? { batchId: input.id, acceptedEventIds: [firstEvent], acceptedRunIds: [] }
      : call === 2 ? { batchId: input.id, acceptedEventIds: ['foreign'], acceptedRunIds: [] }
      : { batchId: input.id, acceptedEventIds: [], acceptedRunIds: input.runRecords.map(value => value.runId) })], resources)
    expect((await checkpoint.run(100)).exporters[0]!.delivery.acceptedEventIds).toEqual([firstEvent])
    expect((await checkpoint.run(100)).exporters[0]!.delivery).toMatchObject({ status: 'failed', acceptedEventIds: [firstEvent] })
    expect(await checkpoint.run(100)).toMatchObject({ complete: true })
    resources.close()
  })

  it('joins concurrent checkpoint calls and keeps the first caller budget', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform()), pending = deferred<ObservationDeliveryAck>(), entered = deferred<void>()
    const checkpoint = new DeliveryCheckpoint(batch, [registration('one', 'required', 'local-durable', input => { entered.resolve(); return pending.promise.then(() => ack(input)) })], resources)
    const first = checkpoint.run(100)
    await entered.promise
    const aborted = new AbortController(); aborted.abort()
    expect(checkpoint.run(0, aborted.signal)).toBe(first)
    pending.resolve(ack(batch))
    expect(await first).toMatchObject({ complete: true })
    resources.close()
  })

  it('shares one absolute deadline across sequential exporters', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform()), second = vi.fn(ack)
    const checkpoint = new DeliveryCheckpoint(batch, [
      registration('first', 'required', 'local-durable', input => { vi.advanceTimersByTime(10); return ack(input) }),
      registration('second', 'required', 'local-durable', second),
    ], resources)
    const result = await checkpoint.run(10)
    expect(result).toMatchObject({ status: 'incomplete', requiredComplete: false, reachedBoundary: 'none' })
    expect(result.exporters.map(row => row.delivery.status)).toEqual(['timed-out', 'timed-out'])
    expect(second).not.toHaveBeenCalled()
    resources.close()
  })

  it('has no durability claim when no required exporter is configured', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform())
    const checkpoint = new DeliveryCheckpoint(batch, [registration('optional', 'best-effort', 'remote-acknowledged', ack)], resources)
    expect(await checkpoint.run(100)).toMatchObject({ status: 'complete', requiredComplete: true, complete: true, reachedBoundary: 'none' })
    resources.close()
  })

  it('seals all pending attempts and returns immutable support-safe rows', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform()), pending = deferred<ObservationDeliveryAck>(), entered = deferred<void>()
    let signal!: AbortSignal
    const checkpoint = new DeliveryCheckpoint(batch, [registration('one', 'required', 'local-durable', (_input, current) => { signal = current; entered.resolve(); return pending.promise })], resources)
    const result = checkpoint.run(100)
    await entered.promise
    checkpoint.seal()
    const report = await result
    expect(signal.aborted).toBe(true)
    expect(report).toMatchObject({ status: 'closed', requiredComplete: false, complete: false, reachedBoundary: 'none' })
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.exporters)).toBe(true)
    expect(await checkpoint.run(100)).toMatchObject({ status: 'closed' })
    pending.resolve(ack(batch))
    resources.close()
  })

  it('rejects an unprepared batch and duplicate exporter identities', async () => {
    const batch = await deliveryBatch(), resources = new RuntimeResources(createRuntimePlatform()), one = registration('same', 'required', 'local-durable', ack)
    expect(() => new DeliveryCheckpoint({ ...batch }, [one], resources)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    expect(() => new DeliveryCheckpoint(batch, [one, one], resources)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    resources.close()
  })
})
