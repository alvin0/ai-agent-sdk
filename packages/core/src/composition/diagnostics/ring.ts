import type { ObservationEvent } from '../../observation/index.ts'
import { serializedEventBytes } from '../../observation/privacy.ts'
import { isPreparedEvent } from '../delivery/event.ts'
import { count, DeliveryDataError } from '../delivery/data.ts'
import { DIAGNOSTIC_LIMITS } from './config.ts'
import { saturatingCounterAdd } from '../common/counter.ts'

interface RingEntry { readonly event: ObservationEvent; readonly bytes: number }

export interface DiagnosticRingOptions {
  readonly maxEvents?: number
  readonly maxBytes?: number
}

export interface DiagnosticRingSnapshot {
  readonly events: readonly ObservationEvent[]
  readonly retainedEvents: number
  readonly retainedBytes: number
  readonly evictedEvents: number
  readonly evictedBytes: number
}

/** Metadata-only support view. Eviction here never removes canonical accounting or exporter work. */
export class DiagnosticRing {
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly entries: RingEntry[] = []
  private cursor = 0
  private retainedBytes = 0
  private evictedEvents = 0
  private evictedBytes = 0

  constructor(options: DiagnosticRingOptions = {}) {
    try {
      this.maxEvents = count(options.maxEvents ?? DIAGNOSTIC_LIMITS.events)
      this.maxBytes = count(options.maxBytes ?? DIAGNOSTIC_LIMITS.bytes)
      if (this.maxEvents === 0 || this.maxEvents > DIAGNOSTIC_LIMITS.maxEvents
        || this.maxBytes === 0 || this.maxBytes > DIAGNOSTIC_LIMITS.maxBytes) throw new DeliveryDataError()
    } catch { throw new DeliveryDataError() }
  }

  /** False means the already-safe event cannot fit even in an empty ring. */
  record(event: ObservationEvent): boolean {
    if (!isPreparedEvent(event)) throw new DeliveryDataError()
    const size = serializedEventBytes(event)
    if (size > this.maxBytes) return false
    while (this.length >= this.maxEvents || this.retainedBytes + size > this.maxBytes) this.evict()
    this.entries.push({ event, bytes: size })
    this.retainedBytes += size
    return true
  }

  snapshot(): DiagnosticRingSnapshot {
    const events = Object.freeze(this.entries.slice(this.cursor).map(entry => entry.event))
    return Object.freeze({ events, retainedEvents: events.length, retainedBytes: this.retainedBytes,
      evictedEvents: this.evictedEvents, evictedBytes: this.evictedBytes })
  }

  private get length(): number { return this.entries.length - this.cursor }

  private evict(): void {
    const entry = this.entries[this.cursor]
    if (entry === undefined) throw new DeliveryDataError()
    this.cursor++
    this.retainedBytes -= entry.bytes
    this.evictedEvents = saturatingCounterAdd(this.evictedEvents, 1)
    this.evictedBytes = saturatingCounterAdd(this.evictedBytes, entry.bytes)
    if (this.cursor >= 256 && this.cursor * 2 >= this.entries.length) {
      this.entries.splice(0, this.cursor)
      this.cursor = 0
    }
  }
}
