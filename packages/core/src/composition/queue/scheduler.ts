import type { ObservationBoundary, ObservationEvent } from '../../observation/index.ts'
import { RuntimeResources } from '../../platform/resources.ts'
import { createDeliveryBatch } from '../delivery/batch.ts'
import { DeliveryCheckpoint, type BatchCheckpointReport } from '../delivery/checkpoint.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import type { RunTerminalRecord } from '../exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import { DeliveryQueueStore } from './store.ts'
import type { DeliveryQueueEntry } from './types.ts'
import { saturatingCounterAdd } from '../common/counter.ts'
import { DRAIN_POLICY, DrainBackoff } from '../../primitives/drain-backoff.ts'

interface QueueTask {
  readonly entries: readonly DeliveryQueueEntry[]
  readonly checkpoint: DeliveryCheckpoint
}

export interface QueueFlushReport {
  readonly status: 'complete' | 'required-complete' | 'incomplete' | 'timed-out' | 'aborted' | 'closed'
  readonly requiredComplete: boolean
  readonly complete: boolean
  readonly reachedBoundary: ObservationBoundary
  readonly targetItems: number
  readonly pendingRequired: number
  readonly pendingItems: number
  readonly batches: readonly BatchCheckpointReport[]
}

export interface DeliverySchedulerHealth {
  readonly exported: number
  readonly exporterFailures: number
  readonly flushTimeouts: number
  readonly requiredFailure: boolean
  readonly lastExportAt?: string
}

/** Background drain tuning. Internal; capture never waits on any of it. */
export const DELIVERY_DRAIN_POLICY = Object.freeze({
  ...DRAIN_POLICY,
  /** Default per-step export deadline when the owner supplies none. */
  timeoutMs: 10_000,
})

export interface DeliverySchedulerRuntime {
  readonly resources: RuntimeResources
  /** Deadline for one background export step; the owner passes its flush timeout. */
  readonly drainTimeoutMs?: number
}

export interface DrainRequest {
  /** Drain even when less than one batch is queued (a run just finished). */
  readonly force?: boolean
}

/**
 * Serial snapshot-drain scheduler. A required incomplete batch retains its exact identity for retry.
 *
 * Besides explicit flushes and run checkpoints, the owner requests coalesced
 * background drains so a long-lived runtime does not hold every event until
 * close. Without them the queue fills to capacity, evicts, and then rejects
 * critical evidence for every later run.
 */
export class DeliveryQueueScheduler {
  private readonly tasks = new Set<QueueTask>()
  private readonly assigned = new WeakSet<DeliveryQueueEntry>()
  private readonly pending = new WeakMap<DeliveryQueueEntry, Set<number>>()
  private readonly delivered = new WeakSet<DeliveryQueueEntry>()
  private readonly finished = new WeakSet<DeliveryQueueEntry>()
  private readonly failed = new WeakSet<DeliveryQueueEntry>()
  private tail: Promise<void> = Promise.resolve()
  private sealed = false
  private exported = 0
  private exporterFailures = 0
  private flushTimeouts = 0
  private requiredFailure = false
  private lastExportAt: string | undefined
  private drainQueued = false
  /** A forced request arrived while a step was already queued; that step drains fully. */
  private drainForce = false
  /** Flushes and checkpoints queued on the serial chain; a background step yields to them. */
  private foregroundWaiting = 0
  private readonly backoff = new DrainBackoff(() => this.resources.platform.monotonicNow())

  private readonly resources: RuntimeResources
  private readonly drainTimeoutMs: number

  constructor(
    private readonly store: DeliveryQueueStore,
    private readonly resource: RuntimeObservationResource,
    private readonly registrations: readonly RuntimeObservationExporterRegistration[],
    runtime: RuntimeResources | DeliverySchedulerRuntime,
  ) {
    if (runtime instanceof RuntimeResources) {
      this.resources = runtime
      this.drainTimeoutMs = DELIVERY_DRAIN_POLICY.timeoutMs
    } else {
      this.resources = runtime.resources
      this.drainTimeoutMs = runtime.drainTimeoutMs ?? DELIVERY_DRAIN_POLICY.timeoutMs
    }
  }

  /**
   * Schedule one background export step if there is work worth sending. Requests
   * coalesce into a single queued step that reads the store when it runs (a forced
   * request upgrades an already-queued step); a step that does not fully deliver
   * pauses further background requests with backoff. A step yields the serial
   * chain between batches to any flush or checkpoint queued behind it, so their
   * deadlines wait for at most one batch in flight.
   * Synchronous and non-throwing: safe to call from capture.
   */
  requestDrain(request: DrainRequest = {}): void {
    const force = request.force === true
    if (this.drainQueued) {
      if (force) this.drainForce = true
      return
    }
    if (!this.canDrain() || !(force ? !this.store.hasNoBacklog() : this.store.hasBatchBacklog())) return
    this.drainQueued = true
    this.drainForce = force
    const run = this.tail.then(() => this.drainStep())
    this.tail = run.then(() => undefined, () => undefined)
  }

  private canDrain(): boolean {
    return !this.sealed && !this.store.isClosed && !this.resources.isClosed
      && this.registrations.length > 0
      && !this.backoff.paused
  }

  flush(deadlineAt: number, caller?: AbortSignal): Promise<QueueFlushReport> {
    return this.schedule(this.store.activeEntries(), deadlineAt, caller)
  }

  checkpointRun(runId: string, throughSequence: number | undefined, deadlineAt: number,
    caller?: AbortSignal): Promise<QueueFlushReport> {
    return this.schedule(this.store.runEntries(runId, throughSequence), deadlineAt, caller)
  }

  /** Stop new queue admission while preserving the already-captured final drain. */
  stopAdmission(): void { this.store.seal() }

  seal(): void {
    if (this.sealed) return
    this.sealed = true
    this.stopAdmission()
    for (const task of this.tasks) task.checkpoint.seal()
  }

  health(): DeliverySchedulerHealth {
    return Object.freeze({ exported: this.exported, exporterFailures: this.exporterFailures,
      flushTimeouts: this.flushTimeouts, requiredFailure: this.requiredFailure,
      ...(this.lastExportAt === undefined ? {} : { lastExportAt: this.lastExportAt }) })
  }

  private schedule(targets: readonly DeliveryQueueEntry[], deadlineAt: number,
    caller?: AbortSignal): Promise<QueueFlushReport> {
    this.foregroundWaiting++
    const run = this.tail.then(() => {
      this.foregroundWaiting--
      return this.flushOnce(targets, deadlineAt, caller)
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async drainStep(): Promise<void> {
    const force = this.drainForce
    this.drainQueued = false
    this.drainForce = false
    if (this.sealed || this.store.isClosed || this.resources.isClosed) return
    const targets = this.store.activeEntries(this.store.maxBatchEvents * DELIVERY_DRAIN_POLICY.batchesPerStep)
    if (targets.length === 0) return
    let yielded = false
    const report = await this.flushOnce(targets, this.resources.platform.monotonicNow() + this.drainTimeoutMs,
      undefined, () => (yielded = this.foregroundWaiting > 0))
    if (yielded) {
      // Queued again behind the waiting flush or checkpoint; not a failure.
      this.requestDrain({ force })
      return
    }
    if (report.status !== 'complete') {
      // flushOnce already backed off when an exporter failed; an otherwise
      // incomplete step (e.g. a partial acknowledgment) must not spin either.
      if (!this.backoff.paused) this.backoff.fail()
      return
    }
    // Keep going while work remains: a forced drain empties the backlog, a
    // threshold drain continues only while another full batch is waiting.
    this.requestDrain({ force })
  }

  /**
   * Every flush is evidence about the sink, not only background steps. Reliable
   * checkpoints still attempt delivery (their callers wait for the boundary), but
   * while they fail the background drain stays paused, so a sink that is down is
   * not also re-sent every failed batch each time a run finishes.
   */
  private noteDelivery(reports: readonly BatchCheckpointReport[]): void {
    if (reports.length === 0) return
    if (reports.some(report => report.exporters.some(row =>
      row.delivery.status === 'failed' || row.delivery.status === 'timed-out'))) {
      this.backoff.fail()
    } else if (reports.every(report => report.complete)) {
      this.backoff.succeed()
    }
  }

  private async flushOnce(targets: readonly DeliveryQueueEntry[], deadlineAt: number,
    caller?: AbortSignal, yieldBeforeBatch?: () => boolean): Promise<QueueFlushReport> {
    if (this.sealed || this.resources.isClosed) return this.report('closed', targets, [])
    if (caller?.aborted) return this.report('aborted', targets, [])
    if (!Number.isFinite(deadlineAt) || this.resources.platform.monotonicNow() >= deadlineAt) {
      return this.report('timed-out', targets, [])
    }
    const activeTargets = targets.filter(entry => this.store.contains(entry))
    this.createTasks(activeTargets.filter(entry => !this.assigned.has(entry)))
    const targetSet = new Set(targets)
    const relevant = [...this.tasks].filter(task => task.entries.some(entry => targetSet.has(entry)))
    const reports = await this.runTasks(relevant, deadlineAt, caller, yieldBeforeBatch)
    this.noteDelivery(reports)
    const state = this.flushState(caller, deadlineAt)
    if (state === 'timed-out') this.flushTimeouts = saturatingCounterAdd(this.flushTimeouts, 1)
    return this.report(state, targets, reports)
  }

  /** Export each task in order; a background step stops before a batch once asked to yield. */
  private async runTasks(tasks: readonly QueueTask[], deadlineAt: number, caller: AbortSignal | undefined,
    yieldBeforeBatch: (() => boolean) | undefined): Promise<BatchCheckpointReport[]> {
    const reports: BatchCheckpointReport[] = []
    for (const task of tasks) {
      if (yieldBeforeBatch?.() === true) break
      const report = await task.checkpoint.run(deadlineAt, caller)
      reports.push(report)
      this.apply(task, report)
    }
    return reports
  }

  private flushState(caller: AbortSignal | undefined, deadlineAt: number): QueueFlushReport['status'] | undefined {
    if (this.sealed || this.resources.isClosed) return 'closed'
    if (caller?.aborted) return 'aborted'
    return this.resources.platform.monotonicNow() >= deadlineAt ? 'timed-out' : undefined
  }

  private createTasks(entries: readonly DeliveryQueueEntry[]): void {
    if (entries.length === 0) return
    const emptyBytes = this.store.batchEnvelopeBytes
    let cursor = 0
    while (cursor < entries.length) {
      const selected = this.selectBatch(entries, cursor, emptyBytes)
      cursor += selected.length
      const events = selected.filter(entry => entry.kind === 'event').map(entry => entry.item as ObservationEvent)
      const records = selected.filter(entry => entry.kind === 'run-record')
        .map(entry => entry.item as RunTerminalRecord)
      const batch = createDeliveryBatch(this.resource, { events, records }, this.resources.platform,
        { content: this.store.content, maxItems: this.store.maxBatchEvents, maxBytes: this.store.maxBatchBytes })
      const task: QueueTask = Object.freeze({ entries: Object.freeze(selected),
        checkpoint: new DeliveryCheckpoint(batch, this.registrations, this.resources) })
      for (const entry of selected) {
        this.assigned.add(entry)
        this.pending.set(entry, new Set(this.registrations.map((_value, index) => index)))
      }
      this.store.protect(selected)
      this.tasks.add(task)
    }
  }

  /**
   * Take the longest prefix from `start` that fits one batch. A batch serializes as
   * `{...,"events":[e1,e2],"runRecords":[r1]}`, so its wire size is the empty envelope
   * plus each item's own size (`entry.bytes`, measured once at admission) plus one
   * comma between siblings. Summing is exact and avoids re-serializing the growing
   * batch for every candidate, which was quadratic in `maxBatchEvents`.
   */
  private selectBatch(entries: readonly DeliveryQueueEntry[], start: number,
    emptyBytes: number): DeliveryQueueEntry[] {
    const selected: DeliveryQueueEntry[] = []
    const siblings = { event: 0, 'run-record': 0 }
    let size = emptyBytes
    for (let cursor = start; cursor < entries.length && selected.length < this.store.maxBatchEvents; cursor++) {
      const candidate = entries[cursor]!
      const itemBytes = candidate.bytes
      const next = size + itemBytes + (siblings[candidate.kind] > 0 ? 1 : 0)
      if (selected.length > 0 && next > this.store.maxBatchBytes) break
      if (emptyBytes + itemBytes > this.store.maxBatchBytes) throw new Error('Queue admitted an undeliverable item')
      selected.push(candidate)
      siblings[candidate.kind]++
      size = next
    }
    return selected
  }

  private apply(task: QueueTask, report: BatchCheckpointReport): void {
    for (const row of report.exporters) {
      this.applyExporter(task.entries, row)
    }
    const settled = task.entries.filter(entry => this.pending.get(entry)?.size === 0)
    for (const entry of settled) this.finished.add(entry)
    if (report.complete) {
      for (const entry of settled) this.delivered.add(entry)
      if (this.registrations.length > 0 && settled.length > 0) {
        this.exported = saturatingCounterAdd(this.exported, settled.length)
        this.lastExportAt = new Date(this.resources.platform.wallNow()).toISOString()
      }
    }
    this.store.unprotect(settled)
    this.store.remove(settled)
    for (const entry of settled) this.assigned.delete(entry)
    if (settled.length === task.entries.length) this.tasks.delete(task)
  }

  private applyExporter(
    entries: readonly DeliveryQueueEntry[], row: BatchCheckpointReport['exporters'][number],
  ): void {
    if (row.delivery.status === 'failed' || row.delivery.status === 'timed-out') {
      this.exporterFailures = saturatingCounterAdd(this.exporterFailures, 1)
      if (row.requirement === 'required') this.requiredFailure = true
    }
    const acceptedEvents = new Set(row.delivery.acceptedEventIds)
    const acceptedRuns = new Set(row.delivery.acceptedRunIds)
    const terminal = row.requirement === 'best-effort'
      && ['failed', 'timed-out', 'aborted', 'closed'].includes(row.delivery.status)
    for (const entry of entries) {
      if (terminal) this.failed.add(entry)
      if (terminal || acceptedEntry(entry, acceptedEvents, acceptedRuns)) {
        this.pending.get(entry)?.delete(row.exporterIndex)
      }
    }
  }

  private report(
    forced: QueueFlushReport['status'] | undefined, targets: readonly DeliveryQueueEntry[],
      batches: readonly BatchCheckpointReport[],
  ): QueueFlushReport {
    const requiredIndexes = new Set(this.registrations.map((value,
      index) => value.requirement === 'required' ? index : -1).filter(index => index >= 0))
    const outstanding = (entry: DeliveryQueueEntry): number => this.finished.has(entry) ? 0
      : this.pending.get(entry)?.size ?? (this.store.contains(entry) ? Math.max(1, this.registrations.length) : 1)
    const pendingItems = targets.filter(entry => outstanding(entry) > 0).length
    const pendingRequired = targets.filter(entry => {
      if (this.finished.has(entry)) return false
      const pending = this.pending.get(entry)
      if (pending !== undefined) return [...pending].some(index => requiredIndexes.has(index))
      return requiredIndexes.size > 0
    }).length
    const requiredComplete = forced !== 'closed' && forced !== 'aborted' && forced !== 'timed-out'
      && pendingRequired === 0
    const complete = requiredComplete && pendingItems === 0 && batches.every(batch => batch.complete)
      && targets.every(entry => !this.failed.has(entry))
    const reachedBoundary = requiredComplete && requiredIndexes.size > 0
      ? [...requiredIndexes].map(index => this.registrations[index]!.boundary).reduce(weakerBoundary)
      : 'none'
    const status = forced ?? reportStatus(complete, requiredComplete)
    return Object.freeze({ status, requiredComplete, complete, reachedBoundary,
      targetItems: targets.length, pendingRequired, pendingItems, batches: Object.freeze([...batches]) })
  }
}

function acceptedEntry(
  entry: DeliveryQueueEntry, events: ReadonlySet<string>, runs: ReadonlySet<string>,
): boolean {
  return entry.kind === 'event' ? events.has(entry.id) : runs.has(entry.id)
}

function reportStatus(complete: boolean, requiredComplete: boolean): QueueFlushReport['status'] {
  if (complete) return 'complete'
  return requiredComplete ? 'required-complete' : 'incomplete'
}

function weakerBoundary(left: ObservationBoundary, right: ObservationBoundary): ObservationBoundary {
  return rank(left) <= rank(right) ? left : right
}
function rank(value: ObservationBoundary): number {
  if (value === 'remote-acknowledged') return 2
  return value === 'local-durable' ? 1 : 0
}
