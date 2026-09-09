import type { ObservationEvent } from '../../observation/index.ts'
import { serializedEventBytes } from '../../observation/privacy.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import { prepareDeliveryEvent } from '../delivery/event.ts'
import { bytes, count, DeliveryDataError } from '../delivery/data.ts'
import { isPreparedTerminal } from '../delivery/terminal.ts'
import { deliveryBatchItemBytes } from '../delivery/batch.ts'
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

/** Bounded admission owner. Export/checkpoint scheduling is deliberately separate from storage policy. */
export class DeliveryQueueStore {
  readonly maxBatchEvents: number
  readonly maxBatchBytes: number
  readonly content: 'none' | 'metadata'
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly entries: DeliveryQueueEntry[] = []
  private readonly active = new Set<DeliveryQueueEntry>()
  private readonly protectedEntries = new WeakSet<DeliveryQueueEntry>()
  private readonly eventIds = new Map<string, DeliveryQueueEntry>()
  private readonly runIds = new Map<string, DeliveryQueueEntry>()
  private ordinal = 0
  private queuedBytes = 0
  private evictedVerbose = 0
  private evictedNormal = 0
  private evictedBytes = 0
  private criticalRejected = 0
  private accepted = 0
  private closed = false

  constructor(
    private readonly resource: RuntimeObservationResource,
    private readonly staging: DeliveryStaging,
    options: DeliveryQueueOptions = {},
    private readonly onEvict?: (entry: DeliveryQueueEntry) => void,
  ) {
    try {
      this.content = options.content ?? 'none'
      if (this.content !== 'none' && this.content !== 'metadata') throw new DeliveryDataError()
      this.maxEvents = positive(options.maxEvents ?? DELIVERY_QUEUE_DEFAULTS.maxEvents)
      this.maxBytes = positive(options.maxBytes ?? DELIVERY_QUEUE_DEFAULTS.maxBytes)
      this.maxBatchEvents = positive(options.maxBatchEvents ?? DELIVERY_QUEUE_DEFAULTS.maxBatchEvents)
      this.maxBatchBytes = positive(options.maxBatchBytes ?? DELIVERY_QUEUE_DEFAULTS.maxBatchBytes)
    } catch { throw new DeliveryDataError() }
  }

  admitEvent(input: ObservationEvent): QueueAdmission {
    if (this.closed) return outcome('closed', 'closed')
    const event = prepareDeliveryEvent(input, this.resource, this.content)
    const previous = this.eventIds.get(event.eventId)
    if (previous !== undefined) return outcome('existing', undefined, previous)
    return this.admit({ kind: 'event', id: event.eventId, runId: event.correlation.runId,
      sequence: event.sequence, priority: event.priority, bytes: serializedEventBytes(event), item: event },
    deliveryBatchItemBytes(this.resource, event), this.eventIds)
  }

  admitRunRecord(record: RunTerminalRecord): QueueAdmission {
    if (this.closed) return outcome('closed', 'closed')
    if (!isPreparedTerminal(record)) throw new DeliveryDataError()
    const previous = this.runIds.get(record.runId)
    if (previous !== undefined) return outcome('existing', undefined, previous)
    return this.admit({ kind: 'run-record', id: record.runId, runId: record.runId,
      priority: 'critical', bytes: bytes(record), item: record }, deliveryBatchItemBytes(this.resource, record), this.runIds)
  }

  remove(entries: readonly DeliveryQueueEntry[]): void {
    for (const entry of entries) {
      if (!this.active.delete(entry)) continue
      this.queuedBytes -= entry.bytes
      if (entry.kind === 'event') this.eventIds.delete(entry.id)
      else this.runIds.delete(entry.id)
    }
    this.compact()
  }

  activeEntries(): readonly DeliveryQueueEntry[] {
    return Object.freeze(this.entries.filter(entry => this.active.has(entry)))
  }

  contains(entry: DeliveryQueueEntry): boolean { return this.active.has(entry) }

  protect(entries: readonly DeliveryQueueEntry[]): void {
    for (const entry of entries) if (this.active.has(entry)) this.protectedEntries.add(entry)
  }

  unprotect(entries: readonly DeliveryQueueEntry[]): void {
    for (const entry of entries) this.protectedEntries.delete(entry)
  }

  runEntries(runId: string, throughSequence?: number): readonly DeliveryQueueEntry[] {
    return Object.freeze(this.entries.filter(entry => this.active.has(entry) && entry.runId === runId
      && entry.priority === 'critical' && (entry.sequence === undefined || throughSequence === undefined || entry.sequence <= throughSequence)))
  }

  snapshot(): DeliveryQueueSnapshot {
    const entries = this.activeEntries()
    return Object.freeze({ queuedItems: entries.length, queuedBytes: this.queuedBytes,
      evictedVerbose: this.evictedVerbose, evictedNormal: this.evictedNormal,
      evictedBytes: this.evictedBytes, criticalRejected: this.criticalRejected, accepted: this.accepted, entries })
  }

  seal(): void { this.closed = true; this.staging.seal() }

  private admit(
    input: Omit<DeliveryQueueEntry, 'ordinal'>, wireBytes: number, identities: Map<string, DeliveryQueueEntry>,
  ): QueueAdmission {
    if (wireBytes > this.maxBatchBytes) {
      if (input.priority === 'critical') this.criticalRejected = saturatingCounterAdd(this.criticalRejected, 1)
      return outcome('rejected', 'batch-capacity')
    }
    while (this.active.size >= this.maxEvents || this.queuedBytes + input.bytes > this.maxBytes) {
      const candidate = this.evictionCandidate()
      if (candidate === undefined) {
        if (input.priority === 'critical') this.criticalRejected = saturatingCounterAdd(this.criticalRejected, 1)
        return outcome('rejected', 'capacity')
      }
      this.evict(candidate)
    }
    const entry: DeliveryQueueEntry = Object.freeze({ ordinal: ++this.ordinal, ...input })
    this.entries.push(entry)
    this.active.add(entry)
    identities.set(entry.id, entry)
    this.queuedBytes += entry.bytes
    this.accepted = saturatingCounterAdd(this.accepted, 1)
    this.staging.stage(entry.item)
    return outcome('accepted', undefined, entry)
  }

  private evictionCandidate(): DeliveryQueueEntry | undefined {
    return this.entries.find(entry => this.active.has(entry) && !this.protectedEntries.has(entry) && entry.priority === 'verbose')
      ?? this.entries.find(entry => this.active.has(entry) && !this.protectedEntries.has(entry) && entry.priority === 'normal')
  }

  private evict(entry: DeliveryQueueEntry): void {
    this.remove([entry])
    if (entry.priority === 'verbose') this.evictedVerbose = saturatingCounterAdd(this.evictedVerbose, 1)
    else this.evictedNormal = saturatingCounterAdd(this.evictedNormal, 1)
    this.evictedBytes = saturatingCounterAdd(this.evictedBytes, entry.bytes)
    try { this.onEvict?.(entry) } catch { /* Queue capacity must not depend on a health observer. */ }
  }

  private compact(): void {
    const dead = this.entries.length - this.active.size
    if (dead < 256 || dead * 2 < this.entries.length) return
    let target = 0
    for (const entry of this.entries) if (this.active.has(entry)) this.entries[target++] = entry
    this.entries.length = target
  }
}

function positive(value: number): number {
  const result = count(value)
  if (result === 0) throw new DeliveryDataError()
  return result
}

function outcome(status: QueueAdmission['status'], reason?: QueueAdmission['reason'], entry?: DeliveryQueueEntry): QueueAdmission {
  return Object.freeze({ status, ...(reason === undefined ? {} : { reason }), ...(entry === undefined ? {} : { entry }) })
}
