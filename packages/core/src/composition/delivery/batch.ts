import type { ObservationEvent } from '../../observation/index.ts'
import type { RuntimePlatform } from '../../platform/adapter.ts'
import { arrayData } from '../common/data.ts'
import type { ObservationDeliveryBatch, RunTerminalRecord } from '../exporter/delivery-types.ts'
import { DELIVERY_LIMITS } from './config.ts'
import { bytes, count, DeliveryDataError } from './data.ts'
import { isRuntimeResource, type RuntimeObservationResource } from './resource.ts'
import { isPreparedTerminal } from './terminal.ts'
import { isPreparedEvent, prepareDeliveryEvent } from './event.ts'

const prepared = new WeakSet<ObservationDeliveryBatch>()
export function isPreparedBatch(batch: ObservationDeliveryBatch): boolean { return prepared.has(batch) }

export interface DeliveryBatchOptions {
  readonly content?: 'none' | 'metadata'
  readonly maxItems?: number
  readonly maxBytes?: number
}

/** Exact one-item wire size without allocating an ID; generated batch IDs have this fixed width. */
export function deliveryBatchItemBytes(resource: RuntimeObservationResource, item: ObservationEvent | RunTerminalRecord): number {
  if (!isRuntimeResource(resource)) throw new DeliveryDataError()
  const event = isPreparedTerminal(item as RunTerminalRecord) ? undefined : item as ObservationEvent
  if (event !== undefined && (!isPreparedEvent(event) || event.resource !== resource)) throw new DeliveryDataError()
  return bytes({ id: '0'.repeat(32), resource,
    events: event === undefined ? [] : [event], runRecords: event === undefined ? [item] : [] })
}

export function deliveryBatchItemsBytes(
  resource: RuntimeObservationResource, events: readonly ObservationEvent[], records: readonly RunTerminalRecord[],
): number {
  if (!isRuntimeResource(resource) || events.some(event => !isPreparedEvent(event) || event.resource !== resource)
    || records.some(record => !isPreparedTerminal(record))) throw new DeliveryDataError()
  return bytes({ id: '0'.repeat(32), resource, events, runRecords: records })
}

/** Privacy and canonical resource stamping happen before the first exporter sees the batch. */
export function createDeliveryBatch(
  resource: RuntimeObservationResource, events: readonly ObservationEvent[], records: readonly RunTerminalRecord[],
  platform: RuntimePlatform, options: DeliveryBatchOptions = {},
): ObservationDeliveryBatch {
  try {
    if (!isRuntimeResource(resource)) throw new DeliveryDataError()
    const maxItems = count(options.maxItems ?? DELIVERY_LIMITS.batchItems)
    const maxBytes = count(options.maxBytes ?? DELIVERY_LIMITS.batchBytes)
    const content = options.content ?? 'none'
    if (maxItems === 0 || maxItems > DELIVERY_LIMITS.maxBatchItems || maxBytes === 0 || maxBytes > DELIVERY_LIMITS.maxBatchBytes
      || (content !== 'none' && content !== 'metadata')) throw new DeliveryDataError()
    const rawEvents = arrayData(events, maxItems), rawRecords = arrayData(records, maxItems)
    if (rawEvents.length + rawRecords.length === 0 || rawEvents.length + rawRecords.length > maxItems) throw new DeliveryDataError()
    let usedBytes = bytes(resource)
    const consume = (value: unknown): void => { usedBytes += bytes(value); if (usedBytes > maxBytes) throw new DeliveryDataError() }
    const safeEvents = rawEvents.map(value => {
      const event = prepareDeliveryEvent(value as ObservationEvent, resource, content)
      consume(event)
      return event
    })
    const runRecords = rawRecords.map(value => {
      if (!isPreparedTerminal(value as RunTerminalRecord)) throw new DeliveryDataError()
      consume(value)
      return value as RunTerminalRecord
    })
    if (new Set(safeEvents.map(event => event.eventId)).size !== safeEvents.length
      || new Set(runRecords.map(record => record.runId)).size !== runRecords.length) throw new DeliveryDataError()
    const batch: ObservationDeliveryBatch = Object.freeze({ id: platform.randomHex(16), resource,
      events: Object.freeze(safeEvents), runRecords: Object.freeze(runRecords) })
    if (bytes(batch) > maxBytes) throw new DeliveryDataError()
    prepared.add(batch)
    return batch
  } catch { throw new DeliveryDataError() }
}
