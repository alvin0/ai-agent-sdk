/** Batch sizing for the delivery scheduler. Internal. */
import type { DeliveryQueueEntry } from './types.ts'

/**
 * Take the longest prefix from `start` that fits one batch. A batch serializes as
 * `{...,"events":[e1,e2],"runRecords":[r1]}`, so its wire size is the empty envelope
 * plus each item's own size (`entry.bytes`, measured once at admission) plus one
 * comma between siblings. Summing is exact and avoids re-serializing the growing
 * batch for every candidate, which was quadratic in `maxBatchEvents`.
 */
export function selectBatch(
  entries: readonly DeliveryQueueEntry[], start: number, emptyBytes: number,
  limits: { readonly maxBatchEvents: number; readonly maxBatchBytes: number },
): DeliveryQueueEntry[] {
  const selected: DeliveryQueueEntry[] = []
  const siblings = { event: 0, 'run-record': 0 }
  let size = emptyBytes
  for (let cursor = start; cursor < entries.length && selected.length < limits.maxBatchEvents; cursor++) {
    const candidate = entries[cursor]!
    const itemBytes = candidate.bytes
    const next = size + itemBytes + (siblings[candidate.kind] > 0 ? 1 : 0)
    if (selected.length > 0 && next > limits.maxBatchBytes) break
    if (emptyBytes + itemBytes > limits.maxBatchBytes) throw new Error('Queue admitted an undeliverable item')
    selected.push(candidate)
    siblings[candidate.kind]++
    size = next
  }
  return selected
}
