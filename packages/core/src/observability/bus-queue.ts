/** Insertion-ordered observation queue with O(1) admission, lookup, removal and eviction choice. */
import type { QueueEntry } from './bus-types.ts'

export class BusQueue implements Iterable<QueueEntry> {
  private readonly entries = new Set<QueueEntry>()
  private readonly latestById = new Map<string, QueueEntry>()
  // Oldest-first by construction: Set iteration follows insertion order.
  private readonly verbose = new Set<QueueEntry>()
  private readonly normal = new Set<QueueEntry>()
  private totalBytes = 0

  get size(): number { return this.entries.size }
  get bytes(): number { return this.totalBytes }

  [Symbol.iterator](): Iterator<QueueEntry> { return this.entries.values() }

  add(entry: QueueEntry): void {
    this.entries.add(entry)
    this.latestById.set(entry.event.eventId, entry)
    this.evictable(entry)?.add(entry)
    this.totalBytes += entry.bytes
  }

  delete(entry: QueueEntry): boolean {
    if (!this.entries.delete(entry)) return false
    this.evictable(entry)?.delete(entry)
    if (this.latestById.get(entry.event.eventId) === entry) this.latestById.delete(entry.event.eventId)
    this.totalBytes -= entry.bytes
    return true
  }

  /** The most recently admitted entry for an event id. */
  get(eventId: string): QueueEntry | undefined { return this.latestById.get(eventId) }

  /** Oldest verbose entry, else oldest normal entry; critical evidence is never a candidate. */
  evictionCandidate(): QueueEntry | undefined {
    return first(this.verbose) ?? first(this.normal)
  }

  /** Event ids in FIFO order, at most `limit`. */
  ids(limit = Number.POSITIVE_INFINITY): Set<string> {
    const ids = new Set<string>()
    for (const entry of this.entries) {
      if (ids.size >= limit) break
      ids.add(entry.event.eventId)
    }
    return ids
  }

  private evictable(entry: QueueEntry): Set<QueueEntry> | undefined {
    if (entry.event.priority === 'verbose') return this.verbose
    return entry.event.priority === 'normal' ? this.normal : undefined
  }
}

function first<Value>(values: ReadonlySet<Value>): Value | undefined {
  for (const value of values) return value
  return undefined
}
