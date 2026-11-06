/** Serial, bounded export of an observation queue snapshot. */
import { deepFreeze } from '../primitives/index.ts'
import type { ExporterPacing } from '../primitives/background-drain.ts'
import { createOperationId } from '../observation/index.ts'
import type { ObservationBatch, ObservationExporterRegistration } from './types.ts'
import type { BusOptions, FlushOutcome, MutableHealth, QueueEntry } from './bus-types.ts'
import type { BusQueue } from './bus-queue.ts'
import { deadlineSignal, isTimeoutAbort, raceAbort, safeFailure } from './bus-helpers.ts'

interface DeliveryResources {
  /** Insertion-ordered (FIFO) queue owned by the bus. */
  readonly queue: BusQueue
  readonly registrations: readonly ObservationExporterRegistration[]
  readonly counters: MutableHealth
  readonly options: BusOptions
  readonly removeEntry: (entry: QueueEntry, exported: boolean) => void
  readonly recordExporterFailure: (registration: ObservationExporterRegistration, error: unknown) => void
  readonly notifyHealth: () => void
  /** Pause and failure count per exporter id. */
  readonly pacing: ExporterPacing<string>
  /** The queue holds at least `DRAIN_POLICY.shedPressure` of its capacity. */
  readonly underPressure: () => boolean
}

interface DeliveryState {
  readonly resources: DeliveryResources
  readonly targetIds: ReadonlySet<string>
  readonly signal: AbortSignal
  readonly background: boolean
  failed: boolean
  timedOut: boolean
  /** Checked before each batch; true stops the flush there. */
  readonly yieldBeforeBatch: (() => boolean) | undefined
  /** Exporters that failed in this flush. */
  readonly failures: Set<string>
  /** Paused exporters a background step did not call. */
  readonly skipped: Set<string>
  yielded: boolean
  /** Some exporter accepted a batch in this flush. */
  progressed: boolean
}

/** How a flush may be cut short: the caller's signal, and a background step's yield check. */
export interface FlushControl {
  readonly external?: AbortSignal | undefined
  /** Checked before each batch; true stops the flush there. */
  readonly yieldBeforeBatch?: (() => boolean) | undefined
  /**
   * A background step nobody asked for. Its deadline is pacing, not a flush
   * timeout. It does not call a paused exporter, and an exporter's failure is
   * tentative until the exporter counts as down (`DRAIN_POLICY.backgroundAttempts`):
   * its entries stay queued and nothing is reported. Once it is down its failures
   * are recorded, and under queue pressure (`DRAIN_POLICY.shedPressure`) its
   * best-effort entries are settled as failed, without calling it while it is paused.
   */
  readonly background?: boolean | undefined
}

export async function flushBus(
  resources: DeliveryResources, targetIds: ReadonlySet<string>, timeoutMs: number, control: FlushControl = {},
): Promise<FlushOutcome> {
  const { external, yieldBeforeBatch } = control
  const beforeExported = resources.counters.exported
  const deadline = deadlineSignal(timeoutMs, external)
  const state: DeliveryState = {
    resources, targetIds, signal: deadline.signal, background: control.background === true, failed: false,
    timedOut: false, yieldBeforeBatch, failures: new Set(), skipped: new Set(), yielded: false,
    progressed: false,
  }
  try {
    if (resources.registrations.length === 0) {
      for (const entry of [...resources.queue]) {
        if (targetIds.has(entry.event.eventId)) resources.removeEntry(entry, false)
      }
    }
    for (const registration of resources.registrations) {
      if (state.background && resources.pacing.paused(registration.exporter.id)) shed(state, registration)
      else await flushExporter(state, registration)
      if (state.yielded) break
    }
  } finally {
    endFlush(state, deadline.signal)
    deadline.clear()
  }
  return deliveryOutcome(state, beforeExported)
}

/**
 * Exporters a background step works for: those not paused, and under queue
 * pressure a paused best-effort one that counts as down, whose entries the step
 * settles as failed (see {@link shed}) so they cannot fill the queue.
 */
export function stepExporterIds(
  registrations: readonly ObservationExporterRegistration[], pacing: ExporterPacing<string>, pressured: boolean,
): string[] {
  return registrations.filter(registration => !pacing.paused(registration.exporter.id)
    || (pressured && sheds(registration, pacing))).map(({ exporter }) => exporter.id)
}

/** When the earliest pause of an exporter that still has queued events ends; the drain wakes then. */
export function pausedResumeAt(
  registrations: readonly ObservationExporterRegistration[], pacing: ExporterPacing<string>, queue: BusQueue,
): number | undefined {
  return pacing.earliestResume(registrations.map(({ exporter }) => exporter.id), id => queue.backlog(id).events > 0)
}

/** A down best-effort exporter, whose entries background steps may settle as failed under pressure. */
function sheds(registration: ObservationExporterRegistration, pacing: ExporterPacing<string>): boolean {
  return registration.requirement === 'best-effort' && pacing.down(registration.exporter.id)
}

/**
 * A background step skips a paused exporter. Once it counts as down and the
 * queue is under pressure, its best-effort entries are settled as failed instead
 * of waiting for it; its failures were already recorded when it was last called.
 * Below the pressure they wait for its next probe.
 */
function shed(state: DeliveryState, registration: ObservationExporterRegistration): void {
  const exporterId = registration.exporter.id
  state.skipped.add(exporterId)
  if (!sheds(registration, state.resources.pacing) || !state.resources.underPressure()) return
  // Every queued entry, not a lookup by id: several entries can share one event id.
  const entries = [...state.resources.queue]
    .filter(entry => state.targetIds.has(entry.event.eventId) && entry.pending.has(exporterId))
  settleEntries(state.resources, exporterId, entries, false)
}

function endFlush(state: DeliveryState, deadline: AbortSignal): void {
  const { resources } = state
  resources.pacing.failed(state.failures)
  if (!isTimeoutAbort(deadline)) return
  state.timedOut = true
  // Only a caller's flush can time out; a background step's deadline is pacing.
  if (state.background) return
  resources.counters.flushTimeouts++
  resources.counters.lastFailure = safeFailure(deadline.reason, 'observation flush timed out')
  resources.notifyHealth()
}

async function flushExporter(state: DeliveryState, registration: ObservationExporterRegistration): Promise<void> {
  while (true) {
    const entries = nextEntries(state, registration.exporter.id)
    if (entries.length === 0) break
    if (state.yieldBeforeBatch?.() === true) {
      state.yielded = true
      break
    }
    // The deadline went to an earlier exporter: this one is not called, and not charged with a failure.
    if (state.signal.aborted) {
      state.timedOut ||= isTimeoutAbort(state.signal)
      break
    }
    if (!await exportEntries(state, registration, entries)) break
    state.progressed = true
    state.resources.pacing.delivered(registration.exporter.id)
    state.resources.counters.lastExportAt = new Date().toISOString()
    settleEntries(state.resources, registration.exporter.id, entries, true)
    state.resources.notifyHealth()
  }
}

function nextEntries(state: DeliveryState, exporterId: string): QueueEntry[] {
  const { resources, targetIds } = state
  const entries: QueueEntry[] = []
  let bytes = 0
  for (const entry of resources.queue) {
    if (!targetIds.has(entry.event.eventId) || !entry.pending.has(exporterId)) continue
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
    state.failures.add(registration.exporter.id)
    if (state.background && state.resources.pacing.tentative(registration.exporter.id)) return false
    state.resources.recordExporterFailure(registration, error)
    // A background step keeps a down exporter's entries for its next probe unless the queue is under pressure.
    if (registration.requirement === 'best-effort' && (!state.background || state.resources.underPressure())) {
      settleEntries(state.resources, registration.exporter.id, entries, false)
    }
    return false
  }
}

function settleEntries(
  resources: DeliveryResources, exporterId: string, entries: readonly QueueEntry[], exported: boolean,
): void {
  for (const entry of entries) {
    if (resources.queue.settle(entry, exporterId)) resources.removeEntry(entry, exported)
  }
}

function deliveryOutcome(state: DeliveryState, beforeExported: number): FlushOutcome {
  const { resources, targetIds, failed, timedOut, skipped } = state
  const pendingEntries = [...resources.queue].filter(entry => targetIds.has(entry.event.eventId))
  const requiredIds = resources.registrations
    .filter(registration => registration.requirement === 'required')
    .map(registration => registration.exporter.id)
  const requiredComplete = pendingEntries.every(entry => requiredIds.every(id => !entry.pending.has(id)))
  // For pacing, only the exporters this flush called count; a paused one waits on its own.
  const calledComplete = !failed && !timedOut
    && pendingEntries.every(entry => [...entry.pending].every(id => skipped.has(id)))
  return Object.freeze({
    step: Object.freeze({ complete: calledComplete, paced: state.failures.size > 0, progressed: state.progressed }),
    complete: !failed && !timedOut && pendingEntries.length === 0,
    requiredComplete,
    exportedEvents: resources.counters.exported - beforeExported,
    pendingEvents: pendingEntries.length,
    rejectedCritical: resources.counters.criticalRejected,
    timedOut,
  })
}
