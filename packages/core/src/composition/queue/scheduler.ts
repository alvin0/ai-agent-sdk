import type { ObservationBoundary, ObservationEvent } from '../../observation/index.ts'
import type { RuntimePlatform } from '../../platform/adapter.ts'
import { RuntimeResources } from '../../platform/resources.ts'
import { createDeliveryBatch, deliveryBatchItemsBytes } from '../delivery/batch.ts'
import { DeliveryCheckpoint, type BatchCheckpointReport } from '../delivery/checkpoint.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import type { RunTerminalRecord } from '../exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import { DeliveryQueueStore } from './store.ts'
import type { DeliveryQueueEntry } from './types.ts'
import { saturatingCounterAdd } from '../common/counter.ts'

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

/** Serial snapshot-drain scheduler. A required incomplete batch retains its exact identity for retry. */
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

  constructor(
    private readonly store: DeliveryQueueStore,
    private readonly resource: RuntimeObservationResource,
    private readonly registrations: readonly RuntimeObservationExporterRegistration[],
    private readonly platform: RuntimePlatform,
    private readonly resources: RuntimeResources,
  ) {}

  flush(deadlineAt: number, caller?: AbortSignal): Promise<QueueFlushReport> {
    return this.schedule(this.store.activeEntries(), deadlineAt, caller)
  }

  checkpointRun(runId: string, throughSequence: number | undefined, deadlineAt: number, caller?: AbortSignal): Promise<QueueFlushReport> {
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

  private schedule(targets: readonly DeliveryQueueEntry[], deadlineAt: number, caller?: AbortSignal): Promise<QueueFlushReport> {
    const run = this.tail.then(() => this.flushOnce(targets, deadlineAt, caller))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async flushOnce(targets: readonly DeliveryQueueEntry[], deadlineAt: number, caller?: AbortSignal): Promise<QueueFlushReport> {
    if (this.sealed || this.resources.isClosed) return this.report('closed', targets, [])
    if (caller?.aborted) return this.report('aborted', targets, [])
    if (!Number.isFinite(deadlineAt) || this.platform.monotonicNow() >= deadlineAt) return this.report('timed-out', targets, [])
    const activeTargets = targets.filter(entry => this.store.contains(entry))
    this.createTasks(activeTargets.filter(entry => !this.assigned.has(entry)))
    const relevant = [...this.tasks].filter(task => task.entries.some(entry => targets.includes(entry)))
    const reports: BatchCheckpointReport[] = []
    for (const task of relevant) {
      const report = await task.checkpoint.run(deadlineAt, caller)
      reports.push(report)
      this.apply(task, report)
    }
    const state = this.sealed || this.resources.isClosed ? 'closed'
      : caller?.aborted ? 'aborted'
        : this.platform.monotonicNow() >= deadlineAt ? 'timed-out'
          : undefined
    if (state === 'timed-out') this.flushTimeouts = saturatingCounterAdd(this.flushTimeouts, 1)
    return this.report(state, targets, reports)
  }

  private createTasks(entries: readonly DeliveryQueueEntry[]): void {
    let cursor = 0
    while (cursor < entries.length) {
      const selected: DeliveryQueueEntry[] = []
      while (cursor < entries.length && selected.length < this.store.maxBatchEvents) {
        const candidate = entries[cursor]!
        if (selected.length > 0 && this.batchBytes([...selected, candidate]) > this.store.maxBatchBytes) break
        if (this.batchBytes([candidate]) > this.store.maxBatchBytes) throw new Error('Queue admitted an undeliverable item')
        selected.push(candidate)
        cursor++
      }
      const events = selected.filter(entry => entry.kind === 'event').map(entry => entry.item as ObservationEvent)
      const records = selected.filter(entry => entry.kind === 'run-record').map(entry => entry.item as RunTerminalRecord)
      const batch = createDeliveryBatch(this.resource, events, records, this.platform,
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

  private batchBytes(entries: readonly DeliveryQueueEntry[]): number {
    return deliveryBatchItemsBytes(this.resource,
      entries.filter(entry => entry.kind === 'event').map(entry => entry.item as ObservationEvent),
      entries.filter(entry => entry.kind === 'run-record').map(entry => entry.item as RunTerminalRecord))
  }

  private apply(task: QueueTask, report: BatchCheckpointReport): void {
    for (const row of report.exporters) {
      if (row.delivery.status === 'failed' || row.delivery.status === 'timed-out') {
        this.exporterFailures = saturatingCounterAdd(this.exporterFailures, 1)
        if (row.requirement === 'required') this.requiredFailure = true
      }
      const acceptedEvents = new Set(row.delivery.acceptedEventIds), acceptedRuns = new Set(row.delivery.acceptedRunIds)
      const terminalBestEffort = row.requirement === 'best-effort'
        && ['failed', 'timed-out', 'aborted', 'closed'].includes(row.delivery.status)
      for (const entry of task.entries) {
        if (terminalBestEffort) this.failed.add(entry)
        if (terminalBestEffort || (entry.kind === 'event' ? acceptedEvents.has(entry.id) : acceptedRuns.has(entry.id))) {
          this.pending.get(entry)?.delete(row.exporterIndex)
        }
      }
    }
    const settled = task.entries.filter(entry => this.pending.get(entry)?.size === 0)
    for (const entry of settled) this.finished.add(entry)
    if (report.complete) {
      for (const entry of settled) this.delivered.add(entry)
      if (this.registrations.length > 0 && settled.length > 0) {
        this.exported = saturatingCounterAdd(this.exported, settled.length)
        this.lastExportAt = new Date(this.platform.wallNow()).toISOString()
      }
    }
    this.store.unprotect(settled)
    this.store.remove(settled)
    for (const entry of settled) this.assigned.delete(entry)
    if (settled.length === task.entries.length) this.tasks.delete(task)
  }

  private report(
    forced: QueueFlushReport['status'] | undefined, targets: readonly DeliveryQueueEntry[], batches: readonly BatchCheckpointReport[],
  ): QueueFlushReport {
    const requiredIndexes = new Set(this.registrations.map((value, index) => value.requirement === 'required' ? index : -1).filter(index => index >= 0))
    const outstanding = (entry: DeliveryQueueEntry): number => this.finished.has(entry) ? 0
      : this.pending.get(entry)?.size ?? (this.store.contains(entry) ? Math.max(1, this.registrations.length) : 1)
    const pendingItems = targets.filter(entry => outstanding(entry) > 0).length
    const pendingRequired = targets.filter(entry => {
      if (this.finished.has(entry)) return false
      const pending = this.pending.get(entry)
      if (pending !== undefined) return [...pending].some(index => requiredIndexes.has(index))
      return requiredIndexes.size > 0
    }).length
    const requiredComplete = forced !== 'closed' && forced !== 'aborted' && forced !== 'timed-out' && pendingRequired === 0
    const complete = requiredComplete && pendingItems === 0 && batches.every(batch => batch.complete)
      && targets.every(entry => !this.failed.has(entry))
    const reachedBoundary = requiredComplete && requiredIndexes.size > 0
      ? [...requiredIndexes].map(index => this.registrations[index]!.boundary).reduce(weakerBoundary)
      : 'none'
    const status = forced ?? (complete ? 'complete' : requiredComplete ? 'required-complete' : 'incomplete')
    return Object.freeze({ status, requiredComplete, complete, reachedBoundary,
      targetItems: targets.length, pendingRequired, pendingItems, batches: Object.freeze([...batches]) })
  }
}

function weakerBoundary(left: ObservationBoundary, right: ObservationBoundary): ObservationBoundary {
  return rank(left) <= rank(right) ? left : right
}
function rank(value: ObservationBoundary): number { return value === 'remote-acknowledged' ? 2 : value === 'local-durable' ? 1 : 0 }
