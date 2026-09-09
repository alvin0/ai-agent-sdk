import { arrayData, objectValue, ownData } from '../common/data.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch } from '../exporter/delivery-types.ts'
import { DELIVERY_ERROR_CODES } from './config.ts'

export class DeliveryAckError extends Error {
  readonly code = DELIVERY_ERROR_CODES.ACK_INVALID
  constructor() { super('Observation acknowledgment is invalid'); this.name = 'DeliveryAckError' }
}

/** Validate both namespaces atomically; never apply the valid half of a malformed acknowledgment. */
export function validateDeliveryAck(value: unknown, batch: ObservationDeliveryBatch): ObservationDeliveryAck {
  try {
    const source = objectValue(value)
    if (ownData(source, 'batchId') !== batch.id) throw new DeliveryAckError()
    const list = (key: string, allowed: readonly string[]): readonly string[] => {
      const input = arrayData(ownData(source, key), allowed.length)
      const ids = new Set<string>()
      const accepted = input.map(value => {
        if (typeof value !== 'string' || !allowed.includes(value) || ids.has(value)) throw new DeliveryAckError()
        ids.add(value)
        return value
      })
      return Object.freeze(accepted)
    }
    return Object.freeze({ batchId: batch.id,
      acceptedEventIds: list('acceptedEventIds', batch.events.map(event => event.eventId)),
      acceptedRunIds: list('acceptedRunIds', batch.runRecords.map(record => record.runId)) })
  } catch { throw new DeliveryAckError() }
}
