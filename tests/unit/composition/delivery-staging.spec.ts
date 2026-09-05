import { describe, expect, it, vi } from 'vitest'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { RuntimeResources } from '../../../packages/core/src/platform/resources.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { prepareDeliveryEvent } from '../../../packages/core/src/composition/delivery/event.ts'
import { createDeliveryBatch } from '../../../packages/core/src/composition/delivery/batch.ts'
import { DeliveryAttempt } from '../../../packages/core/src/composition/delivery/attempt.ts'
import { DeliveryStaging, type StagingFailure } from '../../../packages/core/src/composition/delivery/staging.ts'
import { defineObservationExporter } from '../../../packages/core/src/composition/exporter/definition.ts'
import type { ObservationExporterPlugin, RuntimeObservationExporterRegistration } from '../../../packages/core/src/composition/exporter/types.ts'
import type { ObservationExportItem } from '../../../packages/core/src/composition/exporter/delivery-types.ts'
import { createRunTerminalRecord } from '../../../packages/core/src/composition/delivery/terminal.ts'
import { deferred } from './exporter-fixtures.ts'
import { event, ledgerReport } from './delivery-fixtures.ts'

function registration(stage?: ObservationExporterPlugin['stage'], id = 'fixture'): RuntimeObservationExporterRegistration {
  return { exporter: defineObservationExporter({ id, supportedBoundaries: ['local-durable'],
    ...(stage === undefined ? {} : { stage }),
    export: async batch => ({ batchId: batch.id, acceptedEventIds: batch.events.map(event => event.eventId), acceptedRunIds: batch.runRecords.map(run => run.runId) }),
  }), requirement: 'required', ownership: 'borrowed', boundary: 'local-durable' }
}

function prepared() {
  const platform = createRuntimePlatform(), resource = createRuntimeResource(undefined, platform)
  return { platform, resource, item: prepareDeliveryEvent(event(), resource) }
}

describe('capture-time local staging', () => {
  it('initiates hooks synchronously, without awaiting or claiming durability', async () => {
    const { item } = prepared(), pending = deferred<void>(), called: ObservationExportItem[] = []
    const failed = vi.fn(), staging = new DeliveryStaging([registration(value => { called.push(value); return pending.promise })], failed)
    expect(staging.stage(item)).toBeUndefined()
    expect(called).toEqual([item])
    expect(called[0]).toBe(item)
    expect(failed).not.toHaveBeenCalled()
    pending.resolve()
    await pending.promise
    expect(failed).not.toHaveBeenCalled()
  })

  it('gives staging and export the exact same safe event and canonical run record', async () => {
    const { platform, resource, item } = prepared(), staged: ObservationExportItem[] = []
    const terminal = createRunTerminalRecord(await ledgerReport())
    const target = registration(value => { staged.push(value) })
    const staging = new DeliveryStaging([target], vi.fn())
    staging.stage(item)
    staging.stage(terminal)
    const batch = createDeliveryBatch(resource, [item], [terminal], platform)
    expect(batch.events[0]).toBe(staged[0])
    expect(batch.runRecords[0]).toBe(staged[1])
    expect(terminal).not.toHaveProperty('delivery')
    const resources = new RuntimeResources(platform)
    expect(await new DeliveryAttempt(batch, target, resources).send(platform.monotonicNow() + 1_000)).toMatchObject({ complete: true, boundary: 'local-durable' })
    resources.close()
  })

  it('rejects unprepared events, forged frozen records and shallow copies before any hook', () => {
    const { item } = prepared(), hook = vi.fn(), staging = new DeliveryStaging([registration(hook)], vi.fn())
    for (const invalid of [event(), { ...item }, Object.freeze({ kind: 'run-terminal-record' })]) {
      expect(() => staging.stage(invalid as ObservationExportItem)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    }
    expect(hook).not.toHaveBeenCalled()
  })

  it('contains synchronous failure and continues fan-out, including a throwing health callback', () => {
    const { item } = prepared(), later = vi.fn(), failures: StagingFailure[] = []
    const staging = new DeliveryStaging([
      registration(() => { throw new Error('PRIVATE_STAGE/BODY~SENTINEL%') }, 'first'), registration(later, 'second'), registration(undefined, 'absent'),
    ], failure => { failures.push(failure); throw new Error('health failed') })
    expect(() => staging.stage(item)).not.toThrow()
    expect(later).toHaveBeenCalledWith(item)
    expect(failures).toEqual([{ exporterIndex: 0, required: true, code: 'OBSERVABILITY_STAGE_FAILED', stage: 'stage', message: 'Observation staging failed' }])
    expect(Object.isFrozen(failures[0])).toBe(true)
  })

  it.each(['reject', 'then-getter', 'invalid-result'] as const)('contains %s returned by a staging hook', async variant => {
    const { item } = prepared(), failed = vi.fn()
    const hook = (): unknown => {
      if (variant === 'reject') return Promise.reject(new Error('PRIVATE_STAGE/BODY~SENTINEL%'))
      if (variant === 'then-getter') return Object.defineProperty({}, 'then', { get() { throw new Error('PRIVATE_STAGE/BODY~SENTINEL%') } })
      return Promise.resolve('invalid')
    }
    const staging = new DeliveryStaging([registration(hook as ObservationExporterPlugin['stage'])], failed)
    staging.stage(item)
    await Promise.resolve()
    await Promise.resolve()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(failed.mock.calls)).not.toContain('PRIVATE_STAGE/BODY~SENTINEL%')
  })

  it('captures behavior once with its receiver and does not freeze caller state', () => {
    const { item } = prepared(), calls: ObservationExportItem[] = [], getter = vi.fn()
    const source = { id: 'mutable', supportedBoundaries: ['local-durable' as const], calls,
      export: registration().exporter.export,
      get stage() { getter(); return function(this: typeof source, value: ObservationExportItem) { this.calls.push(value) } },
    }
    const target = { ...registration(), exporter: defineObservationExporter(source) }
    const staging = new DeliveryStaging([target], vi.fn())
    Object.defineProperty(source, 'stage', { value: () => { throw new Error('changed') } })
    staging.stage(item)
    expect(getter).toHaveBeenCalledTimes(1)
    expect(source.calls).toEqual([item])
    expect(Object.isFrozen(source)).toBe(false)
  })

  it('sealing suppresses later hooks and late failures without leaving an unhandled rejection', async () => {
    const { item } = prepared(), pending = deferred<void>(), failed = vi.fn(), later = vi.fn()
    const staging = new DeliveryStaging([registration(() => { staging.seal(); return pending.promise }), registration(later, 'later')], failed)
    staging.stage(item)
    staging.seal()
    staging.stage(item)
    pending.reject(new Error('late failure'))
    await Promise.resolve()
    expect(later).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  })
})

describe('shared capture/batch privacy preparation', () => {
  it('stamps canonical identity before staging and does not retain caller content or credentials', () => {
    const { platform, resource } = prepared(), input = event()
    const raw = { ...input, data: {
      prompt: 'PRIVATE_CONTENT/BODY~SENTINEL%', authorization: 'PRIVATE_CREDENTIAL/VALUE~SENTINEL%', count: 2,
    } }
    const safe = prepareDeliveryEvent(raw, resource)
    const hook = vi.fn(), staging = new DeliveryStaging([registration(hook)], vi.fn())
    staging.stage(safe)
    const batch = createDeliveryBatch(resource, [safe], [], platform)
    expect(safe.resource).toBe(resource)
    expect(batch.events[0]).toBe(safe)
    expect(JSON.stringify(hook.mock.calls)).not.toContain('PRIVATE_CONTENT/BODY~SENTINEL%')
    expect(JSON.stringify(hook.mock.calls)).not.toContain('PRIVATE_CREDENTIAL/VALUE~SENTINEL%')
    raw.data.count = 99
    expect(safe.data.count).toBe(2)
    expect(Object.isFrozen(safe.data)).toBe(true)
  })

  it('does not reuse preparation across different resource identities or content policies', () => {
    const { platform, resource } = prepared(), raw = { ...event(), data: { prompt: 'PRIVATE_CONTENT' } }
    const metadata = prepareDeliveryEvent(raw, resource, 'metadata')
    expect(prepareDeliveryEvent(metadata, resource, 'metadata')).toBe(metadata)
    const none = prepareDeliveryEvent(metadata, resource, 'none')
    expect(none).not.toBe(metadata)
    expect(none.data).not.toHaveProperty('prompt')
    const other = createRuntimeResource(undefined, platform)
    expect(prepareDeliveryEvent(none, other).resource).toBe(other)
    expect(prepareDeliveryEvent(none, other)).not.toBe(none)
  })
})
