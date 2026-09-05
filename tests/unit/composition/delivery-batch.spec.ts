import { describe, expect, it, vi } from 'vitest'
import { createRuntimePlatform } from '../../../packages/core/src/platform/adapter.ts'
import { createRuntimeResource } from '../../../packages/core/src/composition/delivery/resource.ts'
import { createDeliveryBatch } from '../../../packages/core/src/composition/delivery/batch.ts'
import { createRunTerminalRecord } from '../../../packages/core/src/composition/delivery/terminal.ts'
import { bytes } from '../../../packages/core/src/composition/delivery/data.ts'
import { event, ledgerReport } from './delivery-fixtures.ts'

describe('canonical runtime resource metadata', () => {
  it('generates runtime/SDK identity after validating and detaching JSON-safe service metadata', () => {
    const platform = createRuntimePlatform(), input = { serviceName: 'chat', environment: 'test',
      attributes: { region: 'local', dimensions: [[1, 2], { blue: true }], optional: null } }
    const value = createRuntimeResource(input, platform)
    input.attributes.region = 'changed'
    expect(value.attributes?.region).toBe('local')
    expect(value.attributes?.dimensions).toEqual([[1, 2], { blue: true }])
    expect(value.runtimeId).toMatch(/^[0-9a-f]{32}$/)
    expect(value.runtimeId).not.toBe(createRuntimeResource(input, platform).runtimeId)
    expect(Object.isFrozen(value.attributes)).toBe(true)
  })

  it.each([
    { runtimeId: 'spoofed' }, { sdkName: 'spoofed' }, { runtime: 'node' },
    { attributes: { apiKey: 'PRIVATE_CREDENTIAL' } }, { attributes: { nested: { password: 'secret' } } },
    { attributes: { token: 'PRIVATE_CREDENTIAL' } }, { attributes: { credentials: 'PRIVATE_CREDENTIAL' } },
    { attributes: { path: '/private/file' } }, { attributes: { label: 'Bearer PRIVATE_TOKEN' } },
    { attributes: { invalid: new Date() } }, { attributes: { invalid: () => undefined } },
    { attributes: { invalid: Symbol('host') } }, { attributes: { invalid: Number.NaN } },
    { attributes: { invalid: new Error('PRIVATE_ERROR') } }, { serviceName: '' },
    new class { serviceName = 'class-instance' }(),
  ])('rejects invalid/private metadata before generating an ID %#', input => {
    const platform = { ...createRuntimePlatform(), randomHex: vi.fn(() => 'not-called') }
    expect(() => createRuntimeResource(input, platform)).toThrow(expect.objectContaining({ code: 'OBSERVATION_DELIVERY_DATA_INVALID' }))
    expect(platform.randomHex).not.toHaveBeenCalled()
  })

  it('rejects circular values, sparse arrays, deep/oversized data and getters without invoking them', () => {
    const platform = createRuntimePlatform(), circular: Record<string, unknown> = {}
    circular.self = circular
    const circularArray: unknown[] = []
    circularArray.push(circularArray)
    const deep = Array.from({ length: 10 }).reduce<Record<string, unknown>>(value => ({ nested: value }), {})
    const get = vi.fn()
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get })
    for (const attributes of [circular, { circularArray }, deep, accessor, { sparse: new Array(1) }, { large: 'a'.repeat(2_049) },
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, true])),
      Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, 'é'.repeat(1_000)])),
    ]) expect(() => createRuntimeResource({ attributes }, platform)).toThrow()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('immutable mixed event/run delivery batches', () => {
  it('keeps multiple atomic run records without a batch-level token total and binds canonical resource identity', async () => {
    const platform = createRuntimePlatform(), resource = createRuntimeResource({ serviceName: 'sdk-test' }, platform)
    const records = [createRunTerminalRecord(await ledgerReport('a')), createRunTerminalRecord(await ledgerReport('b', 'missing'))]
    const input = { ...event('a'), data: { prompt: 'PRIVATE_PROMPT/BODY~SENTINEL%', authorization: 'Bearer PRIVATE_TOKEN' } }
    const batch = createDeliveryBatch(resource, [input, event('b')], records, platform)
    expect(batch).not.toHaveProperty('usage')
    expect(batch.runRecords[0]).toBe(records[0])
    expect(batch.runRecords[1]).toBe(records[1])
    expect(batch.events.every(event => event.resource === resource)).toBe(true)
    expect(batch.events[0]!.data).not.toHaveProperty('prompt')
    expect(batch.events[0]!.data.authorization).toBe('[REDACTED]')
    expect(JSON.stringify(batch)).not.toContain('PRIVATE_PROMPT/BODY~SENTINEL%')
    expect(Object.isFrozen(batch.events[0]!.data)).toBe(true)
    expect(Object.isFrozen(batch.runRecords)).toBe(true)
    const later = createDeliveryBatch(resource, [event('a', 2)], [records[0]!], platform)
    expect(later.runRecords[0]).toBe(batch.runRecords[0])
    expect(later.id).not.toBe(batch.id)
  })

  it('enforces item/byte bounds, duplicate identities and prepared terminal/resource boundaries', async () => {
    const platform = createRuntimePlatform(), resource = createRuntimeResource(undefined, platform)
    const item = event(), record = createRunTerminalRecord(await ledgerReport())
    const batch = createDeliveryBatch(resource, [item], [record], platform)
    expect(() => createDeliveryBatch(resource, [item], [record], platform, { maxBytes: bytes(batch) })).not.toThrow()
    expect(() => createDeliveryBatch(resource, [item], [record], platform, { maxBytes: bytes(batch) - 1 })).toThrow()
    expect(() => createDeliveryBatch(resource, [item], [record], platform, { maxItems: 1 })).toThrow()
    expect(() => createDeliveryBatch(resource, [item, item], [], platform)).toThrow()
    expect(() => createDeliveryBatch(resource, [], [record, record], platform)).toThrow()
    expect(() => createDeliveryBatch(resource, [], [], platform)).toThrow()
    expect(() => createDeliveryBatch(resource, [], [{ ...record }], platform)).toThrow()
    expect(() => createDeliveryBatch({ ...resource }, [item], [], platform)).toThrow()
  })
})
