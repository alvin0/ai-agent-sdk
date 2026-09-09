import { describe, expect, it, vi } from 'vitest'
import type { ObservationEvent, ObservationPriority } from '../../../packages/core/src/observation/index.ts'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { DeliveryStaging } from '../../../packages/core/src/composition/delivery/staging.ts'
import { defineObservationExporter } from '../../../packages/core/src/composition/exporter/definition.ts'
import { DeliveryQueueStore } from '../../../packages/core/src/composition/queue/store.ts'
import { deliveryBatchItemBytes } from '../../../packages/core/src/composition/delivery/batch.ts'
import { createRunTerminalRecord } from '../../../packages/core/src/composition/delivery/terminal.ts'
import type { ObservationExportItem } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import { event, ledgerReport } from './delivery-fixtures.ts'

function context(options: ConstructorParameters<typeof DeliveryQueueStore>[2] = {}, stage?: (item: ObservationExportItem) => void) {
  const platform = createRuntimePlatform(), resource = createRuntimeResource(undefined, platform), failed = vi.fn()
  const registrations = stage === undefined ? [] : [{ exporter: defineObservationExporter({ id: 'staged', supportedBoundaries: ['local-durable'], stage,
    export: async batch => ({ batchId: batch.id, acceptedEventIds: [], acceptedRunIds: [] }) }),
  requirement: 'required' as const, ownership: 'borrowed' as const, boundary: 'local-durable' as const }]
  const staging = new DeliveryStaging(registrations, failed)
  return { platform, resource, failed, staging, store: new DeliveryQueueStore(resource, staging, options) }
}

function withPriority(sequence: number, priority: ObservationPriority, runId = 'queue-run'): ObservationEvent {
  return { ...event(runId, sequence), priority }
}

describe('delivery queue admission and priority eviction', () => {
  it('privacy-processes and resource-stamps before synchronous staging', () => {
    const seen: ObservationExportItem[] = [], { resource, store } = context({}, item => { seen.push(item) })
    const input = { ...event('safe-run'), data: {
      prompt: 'PRIVATE_PROMPT/BODY~SENTINEL%', authorization: 'PRIVATE_TOKEN/VALUE~SENTINEL%', count: 2,
    } }
    const admission = store.admitEvent(input)
    expect(admission.status).toBe('accepted')
    expect(seen).toEqual([admission.entry!.item])
    expect((seen[0] as ObservationEvent).resource).toBe(resource)
    expect(JSON.stringify(seen)).not.toContain('PRIVATE_PROMPT/BODY~SENTINEL%')
    expect(JSON.stringify(seen)).not.toContain('PRIVATE_TOKEN/VALUE~SENTINEL%')
    input.data.count = 99
    expect((seen[0] as ObservationEvent).data.count).toBe(2)
  })

  it('evicts the oldest verbose row before normal regardless of insertion order', () => {
    const staged = vi.fn(), { store } = context({ maxEvents: 3 }, staged)
    const normal = store.admitEvent(withPriority(1, 'normal')).entry!
    store.admitEvent(withPriority(2, 'verbose'))
    const critical = store.admitEvent(withPriority(3, 'critical')).entry!
    const latest = store.admitEvent(withPriority(4, 'normal')).entry!
    expect(store.snapshot().entries).toEqual([normal, critical, latest])
    expect(store.snapshot()).toMatchObject({ evictedVerbose: 1, evictedNormal: 0, criticalRejected: 0 })
    expect(staged).toHaveBeenCalledTimes(4)
    expect(store.admitEvent(withPriority(5, 'critical')).status).toBe('accepted')
    expect(store.snapshot().entries.map(entry => entry.priority)).toEqual(['critical', 'normal', 'critical'])
    expect(store.snapshot().evictedNormal).toBe(1)
  })

  it('never evicts critical evidence and never stages a rejected incoming item', () => {
    const staged = vi.fn(), { store } = context({ maxEvents: 2 }, staged)
    store.admitEvent(withPriority(1, 'critical'))
    store.admitEvent(withPriority(2, 'critical'))
    expect(store.admitEvent(withPriority(3, 'critical'))).toEqual({ status: 'rejected', reason: 'capacity' })
    expect(store.admitEvent(withPriority(4, 'normal'))).toEqual({ status: 'rejected', reason: 'capacity' })
    expect(store.snapshot()).toMatchObject({ queuedItems: 2, criticalRejected: 1, evictedVerbose: 0, evictedNormal: 0 })
    expect(staged).toHaveBeenCalledTimes(2)
  })

  it('enforces serialized byte capacity independently and counts exact evicted bytes', () => {
    const probe = context(), prepared = probe.store.admitEvent(withPriority(1, 'normal')).entry!
    const wire = deliveryBatchItemBytes(probe.resource, prepared.item as ObservationEvent)
    const { store } = context({ maxEvents: 10, maxBytes: wire, maxBatchBytes: wire })
    const first = store.admitEvent(withPriority(1, 'normal')).entry!
    const second = store.admitEvent(withPriority(2, 'normal')).entry!
    expect(store.snapshot().entries).toEqual([second])
    expect(store.snapshot()).toMatchObject({ queuedItems: 1, queuedBytes: second.bytes,
      evictedNormal: 1, evictedBytes: first.bytes, criticalRejected: 0 })
  })

  it('rejects an item that cannot fit a single exact batch before queue eviction or staging', () => {
    const staged = vi.fn(), probe = context(), prepared = probe.store.admitEvent(withPriority(1, 'normal')).entry!
    const wire = deliveryBatchItemBytes(probe.resource, prepared.item as ObservationEvent)
    const { store } = context({ maxEvents: 10, maxBytes: wire, maxBatchBytes: wire - 1 }, staged)
    expect(store.admitEvent(withPriority(1, 'critical'))).toEqual({ status: 'rejected', reason: 'batch-capacity' })
    expect(store.snapshot()).toMatchObject({ queuedItems: 0, criticalRejected: 1 })
    expect(staged).not.toHaveBeenCalled()
  })

  it('returns the existing entry for a duplicate event or run record without staging twice', async () => {
    const staged = vi.fn(), { store } = context({}, staged), input = event('same-id')
    const first = store.admitEvent(input), duplicate = store.admitEvent(input)
    expect(duplicate).toMatchObject({ status: 'existing', entry: first.entry })
    const record = createRunTerminalRecord(await ledgerReport('same-id'))
    const runFirst = store.admitRunRecord(record), runDuplicate = store.admitRunRecord(record)
    expect(runDuplicate).toMatchObject({ status: 'existing', entry: runFirst.entry })
    expect(staged).toHaveBeenCalledTimes(2)
    expect(store.snapshot().queuedItems).toBe(2)
  })

  it('keeps event and run-record identity namespaces independent', async () => {
    const { store } = context()
    // Event IDs must be canonical 32-hex values, so use that same valid value as a run ID.
    const valid = 'a'.repeat(32), canonical = { ...event(valid), eventId: valid }
    expect(store.admitEvent(canonical).status).toBe('accepted')
    expect(store.admitRunRecord(createRunTerminalRecord(await ledgerReport(valid))).status).toBe('accepted')
    expect(store.snapshot().entries.map(entry => entry.kind)).toEqual(['event', 'run-record'])
  })

  it('selects only critical evidence in the requested run through a sequence plus its terminal record', async () => {
    const { store } = context()
    store.admitEvent(withPriority(1, 'critical', 'target'))
    store.admitEvent(withPriority(2, 'normal', 'target'))
    store.admitEvent(withPriority(3, 'critical', 'target'))
    store.admitEvent(withPriority(1, 'critical', 'other'))
    store.admitRunRecord(createRunTerminalRecord(await ledgerReport('target')))
    expect(store.runEntries('target', 2).map(entry => [entry.kind, entry.sequence])).toEqual([
      ['event', 1], ['run-record', undefined],
    ])
    expect(store.runEntries('target').map(entry => entry.kind)).toEqual(['event', 'event', 'run-record'])
  })

  it('removes acknowledged entries without changing remaining FIFO identity', () => {
    const { store } = context({ maxEvents: 300 }), entries = Array.from({ length: 600 }, (_, index) => store.admitEvent(withPriority(index + 1, 'normal')).entry!)
    store.remove(entries.slice(0, 400))
    expect(store.snapshot().entries).toEqual(entries.slice(400))
    expect(store.snapshot()).toMatchObject({ queuedItems: 200, evictedNormal: 300 })
  })

  it('seals admission and staging idempotently', () => {
    const staged = vi.fn(), { store } = context({}, staged)
    store.seal(); store.seal()
    expect(store.admitEvent(withPriority(1, 'critical'))).toEqual({ status: 'closed', reason: 'closed' })
    expect(staged).not.toHaveBeenCalled()
  })

  it('validates all four positive capacities and their relationships', () => {
    for (const options of [{ maxEvents: 0 }, { maxBytes: 0 }, { maxBatchEvents: 0 }, { maxBatchBytes: 0 },
      { maxEvents: 1.5 }]) {
      expect(() => context(options)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    }
  })
})
