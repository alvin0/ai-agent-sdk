import type { ObservationBoundary, ObservationEvent } from '../../observation/index.ts'
import { RuntimeResources } from '../../platform/resources.ts'
import { createDeliveryBatch } from '../delivery/batch.ts'
import { DeliveryCheckpoint, type BatchCheckpointReport } from '../delivery/checkpoint.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import type { RunTerminalRecord } from '../exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import { DeliveryQueueStore } from './store.ts'
import { acceptedEntry, reportStatus, rowDelivered, rowFailed, settlesAsFailed, weakerBoundary } from './rows.ts'
import type { DeliveryQueueEntry } from './types.ts'
import { selectBatch } from './select-batch.ts'
import { saturatingCounterAdd } from '../common/counter.ts'
import {
  BackgroundDrain, DRAIN_POLICY, ExporterPacing, type BackgroundDrainRequest, type DrainStepOutcome,
} from '../../primitives/background-drain.ts'

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

export type DrainRequest = BackgroundDrainRequest

/**
 * A background step is an attempt nobody asked for: its deadline is pacing, never
 * a flush timeout, it does not call a paused exporter, and its exporter failures
 * are tentative until the exporter counts as down (see `settleFailure`).
 */
interface FlushMode {
  readonly background: boolean
  /** Exporter indexes that failed in this flush. */
  readonly failures: Set<number>
  readonly yieldBeforeBatch?: () => boolean
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
  /** The last step left retained tasks out for lack of room: keep stepping until they are all retried. */
  private moreRetained = false
  private exported = 0
  private exporterFailures = 0
  private flushTimeouts = 0
  private requiredFailure = false
  private lastExportAt: string | undefined
  /** Flushes and checkpoints queued on the serial chain; a background step yields to them. */
  private foregroundWaiting = 0
  private readonly drain: BackgroundDrain<readonly DeliveryQueueEntry[]>
  private readonly pacing: ExporterPacing<number>

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
    const now = () => this.resources.platform.monotonicNow()
    this.pacing = new ExporterPacing(now)
    this.drain = new BackgroundDrain({
      canDrain: () => !this.sealed && !this.store.isClosed && !this.resources.isClosed
        && this.registrations.length > 0,
      hasBacklog: force => this.registrations.some((_registration, index) => this.stepExporter(index))
        && ((force ? !this.store.hasNoBacklog() : this.store.hasBatchBacklog()) || this.retryDue()),
      stepTargets: () => this.stepTargets(),
      resumeAt: () => this.store.hasNoBacklog() && this.tasks.size === 0 ? undefined
        : this.pacing.earliestResume(this.registrations.keys(), () => true),
      flush: async (targets, yieldBeforeBatch) => await this.backgroundStep(targets, yieldBeforeBatch),
      foregroundWaiting: () => this.foregroundWaiting > 0,
      enqueue: (task) => {
        const run = this.tail.then(task)
        this.tail = run.then(() => undefined, () => undefined)
      },
    }, now)
  }

  /**
   * Schedule one coalesced background export step if there is work worth sending
   * (see {@link BackgroundDrain}). Synchronous and non-throwing: safe to call from capture.
   */
  requestDrain(request: DrainRequest = {}): void { this.drain.request(request) }

  /**
   * Exporters a background step works for: those not paused, and one whose items
   * the step settles as failed without calling it (see {@link sheds}).
   */
  private stepExporter(index: number): boolean { return !this.pacing.paused(index) || this.sheds(index) }

  /**
   * A down best-effort exporter's items settle as failed in background steps only
   * under queue pressure (`DRAIN_POLICY.shedPressure`); below it they wait for its next probe.
   */
  private sheds(index: number): boolean {
    return this.registrations[index]?.requirement === 'best-effort' && this.pacing.down(index) && this.pressured()
  }

  /** A deferred exporter sheds for a pause (or a failure earlier in this step); one deferred for lack of time waits. */
  private shedsDeferred(index: number, mode: FlushMode): boolean {
    return (this.pacing.paused(index) || mode.failures.has(index)) && this.sheds(index)
  }

  private pressured(): boolean { return this.store.underPressure(DELIVERY_DRAIN_POLICY.shedPressure) }

  /**
   * Retained tasks (a failed attempt kept for retry) may be due: their entries are
   * protected, so the store does not count them as backlog. Only an exporter that
   * failed leaves a task retained, so they are due once such an exporter is no
   * longer paused (or is shed), and after it recovers while the last step left
   * some out for lack of room; checking that never scans the tasks.
   */
  private retryDue(): boolean {
    return this.tasks.size > 0 && (this.moreRetained || this.registrations.some((_registration, index) =>
      this.pacing.failing(index) && this.stepExporter(index)))
  }

  /** Retained tasks still waiting on an exporter a background step works for. */
  private retained(): QueueTask[] {
    return [...this.tasks].filter(task => task.entries.some(entry =>
      [...this.pending.get(entry) ?? []].some(index => this.stepExporter(index))))
  }

  /** Retained tasks to retry, then the oldest unassigned entries: retries never crowd out newer work. */
  private stepTargets(): readonly DeliveryQueueEntry[] | undefined {
    const limit = this.store.maxBatchEvents * DELIVERY_DRAIN_POLICY.batchesPerStep
    const targets: DeliveryQueueEntry[] = []
    const retained = this.retained()
    let taken = 0
    for (; taken < retained.length && targets.length < limit; taken++) targets.push(...retained[taken]!.entries)
    this.moreRetained = taken < retained.length
    targets.push(...this.store.unprotectedEntries(limit))
    return targets.length === 0 ? undefined : targets
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
    this.drain.stop()
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

  /**
   * One background step. Only the exporters it called count toward `complete`;
   * one that failed is now paused on its own (`paced`).
   */
  private async backgroundStep(targets: readonly DeliveryQueueEntry[], yieldBeforeBatch: () => boolean,
  ): Promise<DrainStepOutcome> {
    const mode: FlushMode = { background: true, failures: new Set(), yieldBeforeBatch }
    const report = await this.flushOnce(targets, this.resources.platform.monotonicNow() + this.drainTimeoutMs,
      undefined, mode)
    const complete = report.status !== 'timed-out' && report.status !== 'closed' && mode.failures.size === 0
      && report.batches.every(batch => batch.exporters.every(row =>
        row.delivery.complete || row.delivery.status === 'deferred'))
    const progressed = report.batches.some(batch => batch.exporters.some(row => rowDelivered(row.delivery.status)))
    return { complete, paced: mode.failures.size > 0, progressed }
  }

  /**
   * Every flush is evidence about the sink, not only background steps: an exporter
   * that fails in a caller's flush or a checkpoint is paused for background steps
   * too, so a sink that is down is not also re-sent every failed batch.
   */
  private async flushOnce(targets: readonly DeliveryQueueEntry[], deadlineAt: number,
    caller?: AbortSignal, mode: FlushMode = { background: false, failures: new Set() }): Promise<QueueFlushReport> {
    if (this.sealed || this.resources.isClosed) return this.report('closed', targets, [])
    if (caller?.aborted) return this.report('aborted', targets, [])
    if (!Number.isFinite(deadlineAt) || this.resources.platform.monotonicNow() >= deadlineAt) {
      return this.report('timed-out', targets, [])
    }
    const activeTargets = targets.filter(entry => this.store.contains(entry))
    this.createTasks(activeTargets.filter(entry => !this.assigned.has(entry)))
    const targetSet = new Set(targets)
    const relevant = [...this.tasks].filter(task => task.entries.some(entry => targetSet.has(entry)))
    const reports = await this.runTasks(relevant, deadlineAt, caller, mode)
    const state = this.flushState(caller, deadlineAt)
    // Only a caller's flush can time out; a background step's own deadline is pacing.
    if (state === 'timed-out' && !mode.background) {
      this.flushTimeouts = saturatingCounterAdd(this.flushTimeouts, 1)
    }
    return this.report(state, targets, reports)
  }

  /** Export each task in order; a background step stops before a batch once asked to yield. */
  private async runTasks(tasks: readonly QueueTask[], deadlineAt: number, caller: AbortSignal | undefined,
    mode: FlushMode): Promise<BatchCheckpointReport[]> {
    const reports: BatchCheckpointReport[] = []
    // A background step does not call an exporter that is paused, already failed in this step (one
    // probe per pause), or whose turn comes after the step's deadline (its time went to another exporter).
    const defer = mode.background ? (index: number) => this.pacing.paused(index) || mode.failures.has(index)
      || this.resources.platform.monotonicNow() >= deadlineAt : undefined
    try {
      for (const task of tasks) {
        if (mode.yieldBeforeBatch?.() === true) break
        if (mode.background && this.resources.platform.monotonicNow() >= deadlineAt) break
        const report = await task.checkpoint.run(deadlineAt, caller, defer)
        reports.push(report)
        this.apply(task, report, mode)
      }
    } finally {
      this.pacing.failed(mode.failures)
      // Tasks this step created but did not reach are protected, so not backlog: the next step takes them.
      if (mode.background && reports.length < tasks.length) this.moreRetained = true
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
      const selected = selectBatch(entries, cursor, emptyBytes, this.store)
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

  private apply(task: QueueTask, report: BatchCheckpointReport, mode: FlushMode): void {
    for (const row of report.exporters) {
      this.applyExporter(task, row, mode)
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
    // Removal also drops protection; unprotecting first would re-file them as evictable.
    this.store.remove(settled)
    for (const entry of settled) this.assigned.delete(entry)
    if (settled.length === task.entries.length) this.tasks.delete(task)
  }

  private applyExporter(task: QueueTask, row: BatchCheckpointReport['exporters'][number], mode: FlushMode): void {
    const terminal = this.settleFailure(row, mode)
    const acceptedEvents = new Set(row.delivery.acceptedEventIds)
    const acceptedRuns = new Set(row.delivery.acceptedRunIds)
    for (const entry of task.entries) {
      if (terminal) this.failed.add(entry)
      if (terminal || acceptedEntry(entry, acceptedEvents, acceptedRuns)) {
        this.pending.get(entry)?.delete(row.exporterIndex)
      }
    }
  }

  /**
   * Record an exporter's failure unless it is tentative; true when its best-effort
   * items settle as failed. In a background step a failure is tentative until the
   * exporter counts as down, and its items settle as failed only under queue
   * pressure, whether the step called it or skipped it while paused.
   */
  private settleFailure(row: BatchCheckpointReport['exporters'][number], mode: FlushMode): boolean {
    const { status } = row.delivery
    const index = row.exporterIndex
    if (rowDelivered(status)) this.pacing.delivered(index)
    if (status === 'deferred') return this.shedsDeferred(index, mode)
    const failed = rowFailed(status)
    if (failed) mode.failures.add(index)
    if (mode.background && (!failed || this.pacing.tentative(index))) return false
    if (failed) this.recordExporterFailure(row.requirement)
    return settlesAsFailed(row) && (!mode.background || this.pressured())
  }

  private recordExporterFailure(requirement: BatchCheckpointReport['exporters'][number]['requirement']): void {
    this.exporterFailures = saturatingCounterAdd(this.exporterFailures, 1)
    if (requirement === 'required') this.requiredFailure = true
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
