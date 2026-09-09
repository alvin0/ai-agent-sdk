import type { ObservationEvent } from '../../observation/index.ts'
import { MAX_EVENT_BYTES, sanitizeObservationEvent } from '../../observation/privacy.ts'
import { bytes, DeliveryDataError } from './data.ts'
import { isRuntimeResource, type RuntimeObservationResource } from './resource.ts'

const prepared = new WeakMap<ObservationEvent, { resource: RuntimeObservationResource; content: 'none' | 'metadata' }>()

export function isPreparedEvent(event: ObservationEvent): boolean { return prepared.has(event) }

/** Capture, staging and batching share one immutable, privacy-processed event identity. */
export function prepareDeliveryEvent(
  input: ObservationEvent, resource: RuntimeObservationResource, content: 'none' | 'metadata' = 'none',
): ObservationEvent {
  try {
    if (!isRuntimeResource(resource) || (content !== 'none' && content !== 'metadata')) throw new DeliveryDataError()
    const previous = prepared.get(input)
    if (previous?.resource === resource && previous.content === content) return input
    const event = Object.freeze({ ...sanitizeObservationEvent(input, { content, redactors: [], includeErrorStacks: false }), resource })
    if (bytes(event) > MAX_EVENT_BYTES) throw new DeliveryDataError()
    prepared.set(event, { resource, content })
    return event
  } catch { throw new DeliveryDataError() }
}
