/** Insertion-ordered observation queue with O(1) admission, lookup, removal and eviction choice. */
import type { QueueEntry } from './bus-types.ts'

const NO_BACKLOG = Object.freeze({ events: 0, bytes: 0 })

export class BusQueue implements Iterable<QueueEntry> {
  private readonly entries = new Set<QueueEntry>()
  private readonly latestById = new Map<string, QueueEntry>()
  // Oldest-first by construction: Set iteration follows insertion order.
  private readonly verbose = new Set<QueueEntry>()
  private readonly normal = new Set<QueueEntry>()
  private totalBytes = 0
  /** Entries and bytes still pending per exporter id, so backlog checks never scan the queue. */
  private readonly pendingTally = new Map<string, { events: number; bytes: number }>()

  get size(): number { return this.entries.size }
  get bytes(): number { return this.totalBytes }

  [Symbol.iterator](): Iterator<QueueEntry> { return this.entries.values() }

  add(entry: QueueEntry): void {
    this.entries.add(entry)
    this.latestById.set(entry.event.eventId, entry)
    this.evictable(entry)?.add(entry)
    this.totalBytes += entry.bytes
    for (const exporterId of entry.pending) this.tally(exporterId, 1, entry.bytes)
  }

  delete(entry: QueueEntry): boolean {
    if (!this.entries.delete(entry)) return false
    this.evictable(entry)?.delete(entry)
    if (this.latestById.get(entry.event.eventId) === entry) this.latestById.delete(entry.event.eventId)
    this.totalBytes -= entry.bytes
    for (const exporterId of entry.pending) this.tally(exporterId, -1, -entry.bytes)
    return true
  }

  /**
   * The exporter is done with the entry (delivered, or settled as failed). The only
   * way an entry's pending set may shrink. True when no exporter is left.
   */
  settle(entry: QueueEntry, exporterId: string): boolean {
    if (entry.pending.delete(exporterId) && this.entries.has(entry)) this.tally(exporterId, -1, -entry.bytes)
    return entry.pending.size === 0
  }

  /** Entries and bytes still pending for an exporter. */
  backlog(exporterId: string): { readonly events: number; readonly bytes: number } {
    return this.pendingTally.get(exporterId) ?? NO_BACKLOG
  }

  /** At least `fraction` of the event or byte capacity is in use. */
  holds(fraction: number, limits: { readonly maxQueueEvents: number; readonly maxQueueBytes: number }): boolean {
    return this.size >= limits.maxQueueEvents * fraction || this.totalBytes >= limits.maxQueueBytes * fraction
  }

  /** The most recently admitted entry for an event id. */
  get(eventId: string): QueueEntry | undefined { return this.latestById.get(eventId) }

  /** Oldest verbose entry, else oldest normal entry; critical evidence is never a candidate. */
  evictionCandidate(): QueueEntry | undefined {
    return first(this.verbose) ?? first(this.normal)
  }

  /**
   * Event ids of each listed exporter's oldest `perExporter` entries still pending
   * for it. Selected per exporter, so entries one exporter keeps retrying never
   * hide newer entries from the others. Stops once every listed exporter has its share.
   */
  stepIds(perExporter: number, exporterIds: ReadonlySet<string>): Set<string> {
    const ids = new Set<string>()
    const taken = new Map<string, number>()
    let saturated = 0
    for (const entry of this.entries) {
      for (const exporterId of entry.pending) {
        if (!exporterIds.has(exporterId)) continue
        const count = taken.get(exporterId) ?? 0
        if (count >= perExporter) continue
        taken.set(exporterId, count + 1)
        ids.add(entry.event.eventId)
        if (count + 1 === perExporter) saturated++
      }
      if (saturated >= exporterIds.size) break
    }
    return ids
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

  private tally(exporterId: string, events: number, bytes: number): void {
    const current = this.pendingTally.get(exporterId) ?? { events: 0, bytes: 0 }
    current.events += events
    current.bytes += bytes
    if (current.events <= 0) this.pendingTally.delete(exporterId)
    else this.pendingTally.set(exporterId, current)
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
