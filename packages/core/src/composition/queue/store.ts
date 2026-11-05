import type { ObservationEvent } from '../../observation/index.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import { prepareDeliveryEvent, preparedEventBytes } from '../delivery/event.ts'
import { bytes, count, DeliveryDataError } from '../delivery/data.ts'
import { isPreparedTerminal } from '../delivery/terminal.ts'
import { deliveryBatchEnvelopeBytes } from '../delivery/batch.ts'
import type { RunTerminalRecord } from '../exporter/delivery-types.ts'
import { DeliveryStaging } from '../delivery/staging.ts'
import { DELIVERY_QUEUE_DEFAULTS } from './config.ts'
import type { DeliveryQueueEntry, DeliveryQueueSnapshot, QueueAdmission } from './types.ts'
import { saturatingCounterAdd } from '../common/counter.ts'

export interface DeliveryQueueOptions {
  readonly content?: 'none' | 'metadata'
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly maxBatchEvents?: number
  readonly maxBatchBytes?: number
}

/** Internal store wiring; never part of the public runtime option grammar. */
export interface DeliveryQueueStoreHooks {
  readonly onEvict?: (entry: DeliveryQueueEntry) => void
  /**
   * Retain admitted items for a later export (default true). A runtime without
   * exporters has nowhere to deliver them, so it admits (validates, sizes, counts)
   * without holding every event of every run in memory until close. It still
   * remembers the most recent `maxEvents` identities, so a repeated event or
   * terminal record is reported as `existing`, as a retaining store reports it
   * while the original is queued. Capacity limits do not apply: nothing is held.
   */
  readonly retain?: boolean
}

/** Bounded admission owner. Export/checkpoint scheduling is deliberately separate from storage policy. */
export class DeliveryQueueStore {
  readonly maxBatchEvents: number
  readonly maxBatchBytes: number
  readonly content: 'none' | 'metadata'
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly retain: boolean
  // Insertion order is admission (ordinal) order, so iterating `active` yields FIFO.
  private readonly active = new Set<DeliveryQueueEntry>()
  // Active evictable entries per priority. The first unprotected member is exactly
  // the oldest candidate, found without scanning the (mostly critical) queue.
  private readonly activeVerbose = new Set<DeliveryQueueEntry>()
  private readonly activeNormal = new Set<DeliveryQueueEntry>()
  private readonly protectedEntries = new WeakSet<DeliveryQueueEntry>()
  private readonly eventIds = new Map<string, DeliveryQueueEntry>()
  private readonly runIds = new Map<string, DeliveryQueueEntry>()
  private envelopeBytes: number | undefined
  private ordinal = 0
  private queuedBytes = 0
  private protectedCount = 0
  private protectedBytes = 0
  private evictedVerbose = 0
  private evictedNormal = 0
  private evictedBytes = 0
  private criticalRejected = 0
  private accepted = 0
  private closed = false

  private readonly onEvict: ((entry: DeliveryQueueEntry) => void) | undefined

  constructor(
    private readonly resource: RuntimeObservationResource,
    private readonly staging: DeliveryStaging,
    options: DeliveryQueueOptions = {},
    hooks: DeliveryQueueStoreHooks = {},
  ) {
    const limits = queueLimits(options)
    this.content = limits.content
    this.maxEvents = limits.maxEvents
    this.maxBytes = limits.maxBytes
    this.maxBatchEvents = limits.maxBatchEvents
    this.maxBatchBytes = limits.maxBatchBytes
    this.onEvict = hooks.onEvict
    this.retain = hooks.retain !== false
  }

  get isClosed(): boolean { return this.closed }

  /** Exact wire size of an empty batch for this store's resource. */
  get batchEnvelopeBytes(): number {
    this.envelopeBytes ??= deliveryBatchEnvelopeBytes(this.resource)
    return this.envelopeBytes
  }

  /**
   * True when enough unassigned work is queued to fill one batch. Entries already
   * assigned to an export task are protected and do not count as new backlog.
   */
  hasBatchBacklog(): boolean {
    return this.active.size - this.protectedCount >= this.maxBatchEvents
      || this.queuedBytes - this.protectedBytes >= this.maxBatchBytes
  }

  /** True when no unassigned entry is waiting for an export task. */
  hasNoBacklog(): boolean { return this.active.size === this.protectedCount }

  admitEvent(input: ObservationEvent): QueueAdmission {
    if (this.closed) return outcome('closed', 'closed')
    const event = prepareDeliveryEvent(input, this.resource, this.content)
    const previous = this.eventIds.get(event.eventId)
    if (previous !== undefined) return outcome('existing', undefined, previous)
    const size = preparedEventBytes(event)
    return this.admit({ kind: 'event', id: event.eventId, runId: event.correlation.runId,
      sequence: event.sequence, priority: event.priority, bytes: size, item: event }, this.eventIds)
  }

  admitRunRecord(record: RunTerminalRecord): QueueAdmission {
    if (this.closed) return outcome('closed', 'closed')
    if (!isPreparedTerminal(record)) throw new DeliveryDataError()
    const previous = this.runIds.get(record.runId)
    if (previous !== undefined) return outcome('existing', undefined, previous)
    return this.admit({ kind: 'run-record', id: record.runId, runId: record.runId,
      priority: 'critical', bytes: bytes(record), item: record }, this.runIds)
  }

  remove(entries: readonly DeliveryQueueEntry[]): void {
    for (const entry of entries) {
      if (!this.active.delete(entry)) continue
      this.evictableSet(entry)?.delete(entry)
      this.release(entry)
      this.queuedBytes -= entry.bytes
      if (entry.kind === 'event') this.eventIds.delete(entry.id)
      else this.runIds.delete(entry.id)
    }
  }

  activeEntries(limit?: number): readonly DeliveryQueueEntry[] {
    if (limit === undefined) return Object.freeze([...this.active])
    const selected: DeliveryQueueEntry[] = []
    for (const entry of this.active) {
      if (selected.length >= limit) break
      selected.push(entry)
    }
    return Object.freeze(selected)
  }

  contains(entry: DeliveryQueueEntry): boolean { return this.active.has(entry) }

  protect(entries: readonly DeliveryQueueEntry[]): void {
    for (const entry of entries) {
      if (!this.active.has(entry) || this.protectedEntries.has(entry)) continue
      this.protectedEntries.add(entry)
      this.protectedCount++
      this.protectedBytes += entry.bytes
    }
  }

  unprotect(entries: readonly DeliveryQueueEntry[]): void {
    for (const entry of entries) this.release(entry)
  }

  runEntries(runId: string, throughSequence?: number): readonly DeliveryQueueEntry[] {
    const selected: DeliveryQueueEntry[] = []
    for (const entry of this.active) {
      if (entry.runId === runId && entry.priority === 'critical' && (entry.sequence === undefined
        || throughSequence === undefined || entry.sequence <= throughSequence)) selected.push(entry)
    }
    return Object.freeze(selected)
  }

  /** Counters only; avoids copying every retained entry for a health read. */
  stats(): Omit<DeliveryQueueSnapshot, 'entries'> {
    return Object.freeze({ queuedItems: this.active.size, queuedBytes: this.queuedBytes,
      evictedVerbose: this.evictedVerbose, evictedNormal: this.evictedNormal,
      evictedBytes: this.evictedBytes, criticalRejected: this.criticalRejected, accepted: this.accepted })
  }

  snapshot(): DeliveryQueueSnapshot {
    return Object.freeze({ ...this.stats(), entries: this.activeEntries() })
  }

  seal(): void { this.closed = true; this.staging.seal() }

  private admit(
    input: Omit<DeliveryQueueEntry, 'ordinal'>, identities: Map<string, DeliveryQueueEntry>,
  ): QueueAdmission {
    // A single-item batch is the envelope plus the item; both sizes are exact.
    if (this.batchEnvelopeBytes + input.bytes > this.maxBatchBytes) {
      if (input.priority === 'critical') this.criticalRejected = saturatingCounterAdd(this.criticalRejected, 1)
      return outcome('rejected', 'batch-capacity')
    }
    const entry: DeliveryQueueEntry = Object.freeze({ ordinal: ++this.ordinal, ...input })
    if (!this.retain) {
      this.remember(identities, entry)
      this.accepted = saturatingCounterAdd(this.accepted, 1)
      this.staging.stage(entry.item)
      return outcome('accepted', undefined, entry)
    }
    while (this.active.size >= this.maxEvents || this.queuedBytes + input.bytes > this.maxBytes) {
      const candidate = this.evictionCandidate()
      if (candidate === undefined) {
        if (input.priority === 'critical') this.criticalRejected = saturatingCounterAdd(this.criticalRejected, 1)
        return outcome('rejected', 'capacity')
      }
      this.evict(candidate)
    }
    this.active.add(entry)
    this.evictableSet(entry)?.add(entry)
    identities.set(entry.id, entry)
    this.queuedBytes += entry.bytes
    this.accepted = saturatingCounterAdd(this.accepted, 1)
    this.staging.stage(entry.item)
    return outcome('accepted', undefined, entry)
  }

  /** Bounded identity window for a store that holds no entries. */
  private remember(identities: Map<string, DeliveryQueueEntry>, entry: DeliveryQueueEntry): void {
    identities.set(entry.id, entry)
    if (identities.size > this.maxEvents) {
      const oldest = identities.keys().next()
      if (oldest.done !== true) identities.delete(oldest.value)
    }
  }

  private release(entry: DeliveryQueueEntry): void {
    if (!this.protectedEntries.delete(entry)) return
    this.protectedCount--
    this.protectedBytes -= entry.bytes
  }

  private evictionCandidate(): DeliveryQueueEntry | undefined {
    return this.firstUnprotected(this.activeVerbose) ?? this.firstUnprotected(this.activeNormal)
  }

  private firstUnprotected(entries: ReadonlySet<DeliveryQueueEntry>): DeliveryQueueEntry | undefined {
    for (const entry of entries) if (!this.protectedEntries.has(entry)) return entry
    return undefined
  }

  private evictableSet(entry: DeliveryQueueEntry): Set<DeliveryQueueEntry> | undefined {
    if (entry.priority === 'verbose') return this.activeVerbose
    return entry.priority === 'normal' ? this.activeNormal : undefined
  }

  private evict(entry: DeliveryQueueEntry): void {
    this.remove([entry])
    if (entry.priority === 'verbose') this.evictedVerbose = saturatingCounterAdd(this.evictedVerbose, 1)
    else this.evictedNormal = saturatingCounterAdd(this.evictedNormal, 1)
    this.evictedBytes = saturatingCounterAdd(this.evictedBytes, entry.bytes)
    try { this.onEvict?.(entry) } catch { /* Queue capacity must not depend on a health observer. */ }
  }
}

function queueLimits(options: DeliveryQueueOptions) {
  try {
    const content = options.content ?? 'none'
    if (content !== 'none' && content !== 'metadata') throw new DeliveryDataError()
    return {
      content,
      maxEvents: positive(options.maxEvents ?? DELIVERY_QUEUE_DEFAULTS.maxEvents),
      maxBytes: positive(options.maxBytes ?? DELIVERY_QUEUE_DEFAULTS.maxBytes),
      maxBatchEvents: positive(options.maxBatchEvents ?? DELIVERY_QUEUE_DEFAULTS.maxBatchEvents),
      maxBatchBytes: positive(options.maxBatchBytes ?? DELIVERY_QUEUE_DEFAULTS.maxBatchBytes),
    }
  } catch { throw new DeliveryDataError() }
}

function positive(value: number): number {
  const result = count(value)
  if (result === 0) throw new DeliveryDataError()
  return result
}

function outcome(status: QueueAdmission['status'], reason?: QueueAdmission['reason'],
  entry?: DeliveryQueueEntry): QueueAdmission {
  return Object.freeze({ status, ...(reason === undefined ? {} : { reason }),
    ...(entry === undefined ? {} : { entry }) })
}
