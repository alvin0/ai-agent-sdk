import type { ObservationEvent } from '../../observation/index.ts'
import type { RuntimePlatform } from '../../platform/adapter.ts'
import { arrayData } from '../common/data.ts'
import type { ObservationDeliveryBatch, RunTerminalRecord } from '../exporter/delivery-types.ts'
import { DELIVERY_LIMITS } from './config.ts'
import { bytes, count, DeliveryDataError } from './data.ts'
import { isRuntimeResource, type RuntimeObservationResource } from './resource.ts'
import { preparedTerminalBytes } from './terminal.ts'
import { prepareDeliveryEvent, preparedEventBytes } from './event.ts'

const prepared = new WeakSet<ObservationDeliveryBatch>()
export function isPreparedBatch(batch: ObservationDeliveryBatch): boolean { return prepared.has(batch) }

export interface DeliveryBatchOptions {
  readonly content?: 'none' | 'metadata'
  readonly maxItems?: number
  readonly maxBytes?: number
}

/**
 * Wire size of a batch with no items; generated batch IDs have a fixed width. A
 * batch serializes as `{...,"events":[e1,e2],"runRecords":[r1]}`, so any batch's
 * exact size is this envelope plus each item's own serialized size plus one comma
 * between siblings.
 */
export function deliveryBatchEnvelopeBytes(resource: RuntimeObservationResource): number {
  if (!isRuntimeResource(resource)) throw new DeliveryDataError()
  let size = envelopeSizes.get(resource)
  if (size === undefined) {
    size = bytes({ id: '0'.repeat(BATCH_ID_HEX_CHARS), resource, events: [], runRecords: [] })
    envelopeSizes.set(resource, size)
  }
  return size
}

/** Batch IDs are `randomHex(16)`: always 32 hex characters, so the envelope size is fixed per resource. */
const BATCH_ID_HEX_CHARS = 32
/** Runtime resources are frozen, so their envelope size never changes. */
const envelopeSizes = new WeakMap<RuntimeObservationResource, number>()
const BATCH_ID = /^[0-9a-f]{32}$/

function batchLimits(options: DeliveryBatchOptions) {
  const maxItems = count(options.maxItems ?? DELIVERY_LIMITS.batchItems)
  const maxBytes = count(options.maxBytes ?? DELIVERY_LIMITS.batchBytes)
  const content = options.content ?? 'none'
  if (maxItems === 0 || maxItems > DELIVERY_LIMITS.maxBatchItems || maxBytes === 0
    || maxBytes > DELIVERY_LIMITS.maxBatchBytes
    || (content !== 'none' && content !== 'metadata')) throw new DeliveryDataError()
  return { maxItems, maxBytes, content }
}

function assertUniqueEntries(safeEvents: readonly ObservationEvent[], runRecords: readonly RunTerminalRecord[]): void {
  if (new Set(safeEvents.map(event => event.eventId)).size !== safeEvents.length
    || new Set(runRecords.map(record => record.runId)).size !== runRecords.length) throw new DeliveryDataError()
}

/** Privacy and canonical resource stamping happen before the first exporter sees the batch. */
export function createDeliveryBatch(
  resource: RuntimeObservationResource,
  input: { events: readonly ObservationEvent[]; records: readonly RunTerminalRecord[] },
  platform: RuntimePlatform, options: DeliveryBatchOptions = {},
): ObservationDeliveryBatch {
  try {
    if (!isRuntimeResource(resource)) throw new DeliveryDataError()
    const { events, records } = input
    const { maxItems, maxBytes, content } = batchLimits(options)
    const rawEvents = arrayData(events, maxItems), rawRecords = arrayData(records, maxItems)
    if (rawEvents.length + rawRecords.length === 0 || rawEvents.length
      + rawRecords.length > maxItems) throw new DeliveryDataError()
    // Exact wire size without serializing the batch: the empty envelope, each item's
    // size measured once when it was prepared, and one comma between siblings.
    let usedBytes = deliveryBatchEnvelopeBytes(resource)
    const consume = (itemBytes: number, index: number): void => {
      usedBytes += itemBytes + (index > 0 ? 1 : 0)
      if (usedBytes > maxBytes) throw new DeliveryDataError()
    }
    const safeEvents = rawEvents.map((value, index) => {
      const event = prepareDeliveryEvent(value as ObservationEvent, resource, content)
      consume(preparedEventBytes(event), index)
      return event
    })
    const runRecords = rawRecords.map((value, index) => {
      consume(preparedTerminalBytes(value as RunTerminalRecord), index)
      return value as RunTerminalRecord
    })
    assertUniqueEntries(safeEvents, runRecords)
    const id = platform.randomHex(16)
    const batch: ObservationDeliveryBatch = Object.freeze({ id, resource,
      events: Object.freeze(safeEvents), runRecords: Object.freeze(runRecords) })
    // A platform whose IDs differ from the envelope's fixed shape gets an exact recount.
    if (!BATCH_ID.test(id) && bytes(batch) > maxBytes) throw new DeliveryDataError()
    prepared.add(batch)
    return batch
  } catch { throw new DeliveryDataError() }
}
