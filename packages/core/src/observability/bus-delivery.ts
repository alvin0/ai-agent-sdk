/** Serial, bounded export of an observation queue snapshot. */
import { deepFreeze } from '../primitives/index.ts'
import { createOperationId } from '../observation/index.ts'
import type { ObservationBatch, ObservationExporterRegistration } from './types.ts'
import type { BusOptions, FlushOutcome, MutableHealth, QueueEntry } from './bus-types.ts'
import { deadlineSignal, isTimeoutAbort, raceAbort, safeFailure } from './bus-helpers.ts'

interface DeliveryResources {
  readonly queue: QueueEntry[]
  readonly registrations: readonly ObservationExporterRegistration[]
  readonly counters: MutableHealth
  readonly options: BusOptions
  readonly removeEntry: (entry: QueueEntry, exported: boolean) => void
  readonly recordExporterFailure: (registration: ObservationExporterRegistration, error: unknown) => void
  readonly notifyHealth: () => void
}

interface DeliveryState {
  readonly resources: DeliveryResources
  readonly targetIds: ReadonlySet<string>
  readonly signal: AbortSignal
  failed: boolean
  timedOut: boolean
}

export async function flushBus(
  resources: DeliveryResources, targetIds: ReadonlySet<string>, timeoutMs: number, external?: AbortSignal,
): Promise<FlushOutcome> {
  const beforeExported = resources.counters.exported
  const deadline = deadlineSignal(timeoutMs, external)
  const state: DeliveryState = { resources, targetIds, signal: deadline.signal, failed: false, timedOut: false }
  try {
    if (resources.registrations.length === 0) {
      for (const entry of [...resources.queue]) {
        if (targetIds.has(entry.event.eventId)) resources.removeEntry(entry, false)
      }
    }
    for (const registration of resources.registrations) await flushExporter(state, registration)
  } finally {
    if (isTimeoutAbort(deadline.signal)) {
      state.timedOut = true
      resources.counters.flushTimeouts++
      resources.counters.lastFailure = safeFailure(deadline.signal.reason, 'observation flush timed out')
      resources.notifyHealth()
    }
    deadline.clear()
  }
  return deliveryOutcome(state, beforeExported)
}

async function flushExporter(state: DeliveryState, registration: ObservationExporterRegistration): Promise<void> {
  while (true) {
    const entries = nextEntries(state, registration.exporter.id)
    if (entries.length === 0) break
    if (!await exportEntries(state, registration, entries)) break
    state.resources.counters.lastExportAt = new Date().toISOString()
    settleEntries(state.resources, registration.exporter.id, entries, true)
    state.resources.notifyHealth()
  }
}

function nextEntries(state: DeliveryState, exporterId: string): QueueEntry[] {
  const { resources, targetIds } = state
  const candidates = resources.queue.filter(entry => (
    targetIds.has(entry.event.eventId) && entry.pending.has(exporterId)
  ))
  const entries: QueueEntry[] = []
  let bytes = 0
  for (const entry of candidates) {
    if (entries.length >= resources.options.maxBatchEvents || bytes + entry.bytes > resources.options.maxBatchBytes) {
      break
    }
    entries.push(entry)
    bytes += entry.bytes
  }
  return entries
}

async function exportEntries(
  state: DeliveryState, registration: ObservationExporterRegistration, entries: readonly QueueEntry[],
): Promise<boolean> {
  const batch: ObservationBatch = deepFreeze({
    schemaVersion: 1, batchId: createOperationId(), createdAt: new Date().toISOString(),
    events: entries.map(entry => entry.event),
  })
  try {
    const ack = await raceAbort(Promise.resolve(registration.exporter.export(batch, state.signal)), state.signal)
    if (ack.batchId !== batch.batchId || ack.accepted !== true) {
      throw new TypeError(`observation exporter ${registration.exporter.id} returned an invalid acknowledgment`)
    }
    return true
  } catch (error) {
    state.failed = true
    state.timedOut ||= isTimeoutAbort(state.signal)
    state.resources.recordExporterFailure(registration, error)
    if (registration.requirement === 'best-effort') {
      settleEntries(state.resources, registration.exporter.id, entries, false)
    }
    return false
  }
}

function settleEntries(
  resources: DeliveryResources, exporterId: string, entries: readonly QueueEntry[], exported: boolean,
): void {
  for (const entry of entries) {
    entry.pending.delete(exporterId)
    if (entry.pending.size === 0) resources.removeEntry(entry, exported)
  }
}

function deliveryOutcome(state: DeliveryState, beforeExported: number): FlushOutcome {
  const { resources, targetIds, failed, timedOut } = state
  const pendingEntries = resources.queue.filter(entry => targetIds.has(entry.event.eventId))
  const requiredIds = resources.registrations
    .filter(registration => registration.requirement === 'required')
    .map(registration => registration.exporter.id)
  const requiredComplete = pendingEntries.every(entry => requiredIds.every(id => !entry.pending.has(id)))
  return Object.freeze({
    complete: !failed && !timedOut && pendingEntries.length === 0,
    requiredComplete,
    exportedEvents: resources.counters.exported - beforeExported,
    pendingEvents: pendingEntries.length,
    rejectedCritical: resources.counters.criticalRejected,
    timedOut,
  })
}
