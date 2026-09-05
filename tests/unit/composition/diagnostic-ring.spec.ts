import { describe, expect, it } from 'vitest'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { prepareDeliveryEvent } from '../../../packages/core/src/composition/delivery/event.ts'
import { DiagnosticRing } from '../../../packages/core/src/composition/diagnostics/ring.ts'
import { event } from './delivery-fixtures.ts'
import type { JsonObject } from '../../../packages/core/src/primitives/index.ts'

function prepared(sequence = 1, data: JsonObject = {}) {
  const platform = createRuntimePlatform(), resource = createRuntimeResource(undefined, platform)
  return prepareDeliveryEvent({ ...event('ring-run', sequence), data }, resource)
}

describe('bounded runtime diagnostic ring', () => {
  it('retains the approved default of exactly 256 small events', () => {
    const ring = new DiagnosticRing(), values = Array.from({ length: 300 }, (_, index) => prepared(index + 1, { index }))
    for (const value of values) expect(ring.record(value)).toBe(true)
    const snapshot = ring.snapshot()
    expect(snapshot.retainedEvents).toBe(256)
    expect(snapshot.evictedEvents).toBe(44)
    expect(snapshot.events[0]).toBe(values[44])
    expect(snapshot.events.at(-1)).toBe(values.at(-1))
    expect(snapshot.retainedBytes).toBeGreaterThan(0)
    expect(snapshot.evictedBytes).toBeGreaterThan(0)
  })

  it('enforces byte capacity independently and reports exact serialized-byte eviction', () => {
    const first = prepared(1, { marker: 'first' }), second = prepared(2, { marker: 'second' })
    const firstBytes = new TextEncoder().encode(JSON.stringify(first)).byteLength
    const secondBytes = new TextEncoder().encode(JSON.stringify(second)).byteLength
    const ring = new DiagnosticRing({ maxEvents: 10, maxBytes: Math.max(firstBytes, secondBytes) })
    expect(ring.record(first)).toBe(true)
    expect(ring.record(second)).toBe(true)
    expect(ring.snapshot()).toMatchObject({ retainedEvents: 1, retainedBytes: secondBytes, evictedEvents: 1, evictedBytes: firstBytes })
    expect(ring.snapshot().events).toEqual([second])
  })

  it('rejects a single oversized event without describing it as previously admitted or evicted', () => {
    const value = prepared(1, { field: 'long-value' })
    const ring = new DiagnosticRing({ maxEvents: 10, maxBytes: 1 })
    expect(ring.record(value)).toBe(false)
    expect(ring.snapshot()).toEqual({ events: [], retainedEvents: 0, retainedBytes: 0, evictedEvents: 0, evictedBytes: 0 })
  })

  it('rejects unprepared events and invalid capacities without inspecting event data', () => {
    for (const options of [{ maxEvents: 0 }, { maxEvents: 4_097 }, { maxBytes: 0 }, { maxBytes: 16 * 1024 * 1024 + 1 }, { maxEvents: 1.5 }]) {
      expect(() => new DiagnosticRing(options)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    }
    const ring = new DiagnosticRing(), get = () => { throw new Error('PRIVATE_DIAGNOSTIC/BODY~SENTINEL%') }
    const hostile = Object.defineProperty(event(), 'data', { get })
    expect(() => ring.record(hostile)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
  })

  it('returns detached immutable snapshots while later recording remains possible', () => {
    const ring = new DiagnosticRing({ maxEvents: 2 }), first = prepared(1), second = prepared(2), third = prepared(3)
    ring.record(first)
    const snapshot = ring.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.events)).toBe(true)
    expect(() => (snapshot.events as unknown as unknown[]).push(second)).toThrow()
    ring.record(second)
    ring.record(third)
    expect(snapshot.events).toEqual([first])
    expect(ring.snapshot().events).toEqual([second, third])
  })

  it('compacts its internal cursor without changing FIFO ordering or identity', () => {
    const ring = new DiagnosticRing({ maxEvents: 3 }), values = Array.from({ length: 1_000 }, (_, index) => prepared(index + 1))
    for (const value of values) ring.record(value)
    expect(ring.snapshot().events).toEqual(values.slice(-3))
    expect(ring.snapshot()).toMatchObject({ retainedEvents: 3, evictedEvents: 997 })
  })
})
