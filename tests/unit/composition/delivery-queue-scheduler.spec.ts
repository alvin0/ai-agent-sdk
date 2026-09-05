import { describe, expect, it, vi } from 'vitest'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { DeliveryStaging } from '../../../packages/core/src/composition/delivery/staging.ts'
import { defineObservationExporter } from '../../../packages/core/src/composition/exporter/definition.ts'
import { DeliveryQueueStore } from '../../../packages/core/src/composition/queue/store.ts'
import { DeliveryQueueScheduler } from '../../../packages/core/src/composition/queue/scheduler.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../../../packages/core/src/composition/exporter/types.ts'
import { createRunTerminalRecord } from '../../../packages/core/src/composition/delivery/terminal.ts'
import { deferred } from './exporter-fixtures.ts'
import { event, ledgerReport } from './delivery-fixtures.ts'

function fullAck(batch: ObservationDeliveryBatch): ObservationDeliveryAck {
  return { batchId: batch.id, acceptedEventIds: batch.events.map(value => value.eventId), acceptedRunIds: batch.runRecords.map(value => value.runId) }
}

function target(id: string, requirement: 'required' | 'best-effort', send: (batch: ObservationDeliveryBatch, signal: AbortSignal) => unknown,
  boundary: 'local-durable' | 'remote-acknowledged' = 'local-durable'): RuntimeObservationExporterRegistration {
  return { exporter: defineObservationExporter({ id, supportedBoundaries: [boundary], export: async (batch, signal) => await send(batch, signal) as ObservationDeliveryAck }),
    requirement, ownership: 'borrowed', boundary }
}

function fixture(registrations: readonly RuntimeObservationExporterRegistration[], options: ConstructorParameters<typeof DeliveryQueueStore>[2] = {}) {
  const platform = createRuntimePlatform(), resources = new RuntimeResources(platform), resource = createRuntimeResource(undefined, platform)
  const staging = new DeliveryStaging(registrations, vi.fn()), store = new DeliveryQueueStore(resource, staging, options)
  const scheduler = new DeliveryQueueScheduler(store, resource, registrations, platform, resources)
  return { platform, resources, resource, store, scheduler }
}

describe('queue to stable batch scheduling', () => {
  it('splits the call-time snapshot by batch count and removes acknowledged rows', async () => {
    const batches: ObservationDeliveryBatch[] = [], registration = target('required', 'required', batch => { batches.push(batch); return fullAck(batch) })
    const { platform, resources, store, scheduler } = fixture([registration], { maxBatchEvents: 2 })
    const entries = Array.from({ length: 5 }, (_, index) => store.admitEvent(event('batch-run', index + 1)).entry!)
    const result = await scheduler.flush(platform.monotonicNow() + 10_000)
    expect(batches.map(batch => batch.events.length)).toEqual([2, 2, 1])
    expect(batches.flatMap(batch => batch.events).map(value => value.eventId)).toEqual(entries.map(entry => entry.id))
    expect(result).toMatchObject({ status: 'complete', requiredComplete: true, complete: true,
      reachedBoundary: 'local-durable', targetItems: 5, pendingRequired: 0, pendingItems: 0 })
    expect(store.snapshot().queuedItems).toBe(0)
    resources.close()
  })

  it('retries a required failure with the same batch and protects it from eviction', async () => {
    const seen: ObservationDeliveryBatch[] = [], accepted = vi.fn(), registration = target('required', 'required', batch => {
      seen.push(batch)
      if (seen.length === 1) throw new Error('PRIVATE_EXPORT/BODY~SENTINEL%')
      accepted(); return fullAck(batch)
    })
    const { platform, resources, store, scheduler } = fixture([registration], { maxEvents: 1 })
    store.admitEvent({ ...event('retry-run'), priority: 'normal' })
    expect(await scheduler.flush(platform.monotonicNow() + 10_000)).toMatchObject({ status: 'incomplete', pendingRequired: 1 })
    expect(store.admitEvent({ ...event('new-run'), priority: 'critical' })).toEqual({ status: 'rejected', reason: 'capacity' })
    expect(await scheduler.flush(platform.monotonicNow() + 10_000)).toMatchObject({ status: 'complete', pendingRequired: 0 })
    expect(accepted).toHaveBeenCalledOnce()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
    resources.close()
  })

  it('releases best-effort failure without claiming that full delivery completed', async () => {
    const required = target('required', 'required', fullAck, 'remote-acknowledged')
    const optional = target('optional', 'best-effort', () => { throw new Error('PRIVATE_EXPORT/BODY~SENTINEL%') })
    const { platform, resources, store, scheduler } = fixture([required, optional])
    store.admitEvent(event('optional-run'))
    const first = scheduler.flush(platform.monotonicNow() + 10_000)
    const queued = scheduler.flush(platform.monotonicNow() + 10_000)
    const result = await first
    expect(result).toMatchObject({ status: 'required-complete', requiredComplete: true, complete: false,
      reachedBoundary: 'remote-acknowledged', pendingRequired: 0, pendingItems: 0 })
    expect(store.snapshot().queuedItems).toBe(0)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_EXPORT/BODY~SENTINEL%')
    expect(await queued).toMatchObject({ status: 'required-complete', requiredComplete: true, complete: false, pendingItems: 0 })
    resources.close()
  })

  it('retains partial acknowledgment and exact batch identity across flushes', async () => {
    const seen: ObservationDeliveryBatch[] = []; let calls = 0
    const registration = target('partial', 'required', batch => {
      seen.push(batch); calls++
      return calls === 1
        ? { batchId: batch.id, acceptedEventIds: [batch.events[0]!.eventId], acceptedRunIds: [] }
        : { batchId: batch.id, acceptedEventIds: batch.events.slice(1).map(value => value.eventId), acceptedRunIds: [] }
    })
    const { platform, resources, store, scheduler } = fixture([registration])
    store.admitEvent(event('partial-run', 1)); store.admitEvent(event('partial-run', 2))
    expect(await scheduler.flush(platform.monotonicNow() + 10_000)).toMatchObject({ pendingRequired: 1 })
    expect(await scheduler.flush(platform.monotonicNow() + 10_000)).toMatchObject({ complete: true, pendingRequired: 0 })
    expect(seen[1]).toBe(seen[0])
    resources.close()
  })

  it('checkpoints only critical rows in one run through the requested sequence', async () => {
    const exported: ObservationDeliveryBatch[] = [], registration = target('required', 'required', batch => { exported.push(batch); return fullAck(batch) })
    const { platform, resources, store, scheduler } = fixture([registration])
    store.admitEvent({ ...event('target', 1), priority: 'critical' })
    store.admitEvent({ ...event('target', 2), priority: 'normal' })
    store.admitEvent({ ...event('target', 3), priority: 'critical' })
    store.admitEvent({ ...event('other', 1), priority: 'critical' })
    store.admitRunRecord(createRunTerminalRecord(await ledgerReport('target')))
    const result = await scheduler.checkpointRun('target', 2, platform.monotonicNow() + 10_000)
    expect(result).toMatchObject({ complete: true, targetItems: 2 })
    expect(exported.flatMap(batch => batch.events).map(value => [value.correlation.runId, value.sequence])).toEqual([['target', 1]])
    expect(exported.flatMap(batch => batch.runRecords).map(value => value.runId)).toEqual(['target'])
    expect(store.snapshot().entries.map(entry => [entry.runId, entry.sequence])).toEqual([
      ['target', 2], ['target', 3], ['other', 1],
    ])
    resources.close()
  })

  it('does not allocate or call exporters after an already-expired deadline', async () => {
    const send = vi.fn(fullAck), registration = target('required', 'required', send)
    const { platform, resources, store, scheduler } = fixture([registration])
    store.admitEvent(event('expired'))
    expect(await scheduler.flush(platform.monotonicNow())).toMatchObject({ status: 'timed-out', complete: false, pendingItems: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(store.snapshot().queuedItems).toBe(1)
    resources.close()
  })

  it('serializes flushes while preserving each call-time target snapshot', async () => {
    const pending = deferred<void>(), entered = deferred<void>(), batches: ObservationDeliveryBatch[] = []
    const registration = target('required', 'required', async batch => {
      batches.push(batch)
      if (batches.length === 1) { entered.resolve(); await pending.promise }
      return fullAck(batch)
    })
    const { platform, resources, store, scheduler } = fixture([registration], { maxBatchEvents: 1 })
    store.admitEvent(event('serial', 1))
    const first = scheduler.flush(platform.monotonicNow() + 10_000)
    await entered.promise
    store.admitEvent(event('serial', 2))
    const second = scheduler.flush(platform.monotonicNow() + 10_000)
    expect(batches).toHaveLength(1)
    pending.resolve()
    expect(await first).toMatchObject({ targetItems: 1, complete: true })
    expect(await second).toMatchObject({ targetItems: 2, complete: true })
    expect(batches).toHaveLength(2)
    resources.close()
  })

  it('seals an in-flight batch, aborts its signal and commits no late ack', async () => {
    const pending = deferred<ObservationDeliveryAck>(), entered = deferred<void>(); let signal!: AbortSignal
    const registration = target('required', 'required', (batch, current) => { signal = current; entered.resolve(); return pending.promise.then(() => fullAck(batch)) })
    const { platform, resources, store, scheduler } = fixture([registration])
    store.admitEvent(event('closing'))
    const result = scheduler.flush(platform.monotonicNow() + 10_000)
    await entered.promise
    scheduler.seal()
    expect(await result).toMatchObject({ status: 'closed', complete: false, pendingRequired: 1 })
    expect(signal.aborted).toBe(true)
    pending.resolve({ batchId: 'unused', acceptedEventIds: [], acceptedRunIds: [] })
    await Promise.resolve()
    expect(await scheduler.flush(platform.monotonicNow() + 10_000)).toMatchObject({ status: 'closed' })
    expect(store.snapshot().queuedItems).toBe(1)
    resources.close()
  })

  it('drains immediately without exporters but never invents a durable boundary', async () => {
    const { platform, resources, store, scheduler } = fixture([])
    store.admitEvent(event('operational'))
    expect(await scheduler.flush(platform.monotonicNow() + 10_000)).toMatchObject({
      status: 'complete', complete: true, requiredComplete: true, reachedBoundary: 'none', pendingItems: 0,
    })
    expect(store.snapshot().queuedItems).toBe(0)
    resources.close()
  })
})
