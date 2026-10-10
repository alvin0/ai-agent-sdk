import {
  deepFreeze,
} from '../primitives/index.ts'
import {
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  snapshotObservationSpan,
  type CaptureReceipt,
  type ObservationEvent,
  type ObservationResource,
  type ObservationSpan,
  type OpenObservationSpanInput,
} from '../observation/index.ts'
import { createBusLogger } from './logger.ts'
import { sanitizeObservationEvent, serializedEventBytes } from './privacy.ts'
import type {
  FlushResult,
  LoggerContext,
  LogLevel,
  ObservationExporterRegistration,
  ObservationHealthSnapshot,
  ObservationProcessor,
  Observability,
  ObservabilityOptions,
  SdkLogger,
} from './types.ts'

import type { BusOptions, QueueEntry, MutableHealth } from './bus-types.ts'
import {
  busResource, busProcessors, busOptions, busHealthState, validateRegistrations, eventIdOf,
  safeFailure, receipt, requiredBoundary, deadlineSignal, raceAbort, publicFlushResult, sameEnvelope,
} from './bus-helpers.ts'
import { flushBus } from './bus-delivery.ts'
import type { FlushOutcome } from './bus-types.ts'

class ObservationBus implements Observability {
  readonly mode: Observability['mode']
  readonly resource: ObservationResource
  private readonly registrations: readonly ObservationExporterRegistration[]
  private readonly processors: readonly ObservationProcessor[]
  private readonly options: BusOptions
  private readonly queue: QueueEntry[] = []
  private queueBytes = 0
  private closing = false
  private closed = false
  private shutdownPromise: Promise<FlushResult> | undefined
  private flushChain: Promise<void> = Promise.resolve()
  private readonly protectedFailures = new Set<string>()
  private readonly healthScope = createObservationRunScope()
  private readonly healthRunId = createOperationId()
  private readonly healthCorrelation = createCoreSpan({
    name: 'sdk.integration.request', runId: this.healthRunId,
    startedAt: new Date().toISOString(), monotonicMs: this.healthScope.monotonicMs(),
  }).correlation
  private readonly counters: MutableHealth = {
    accepted: 0, exported: 0, droppedVerbose: 0, droppedNormal: 0,
    criticalRejected: 0, processorFailures: 0, exporterFailures: 0,
    flushTimeouts: 0, requiredFailure: false,
  }

  constructor(input: ObservabilityOptions) {
    this.mode = input.mode ?? 'operational'
    if (!['operational', 'reliable', 'audit'].includes(this.mode)) throw new TypeError('invalid observation mode')
    this.resource = busResource(input)
    this.registrations = validateRegistrations(this.mode, input.exporters ?? [])
    this.processors = busProcessors(input)
    this.options = busOptions(input)
  }

  openSpan(input: OpenObservationSpanInput): ObservationSpan {
    const backend = this.options.openSpan
    if (backend === undefined) return createCoreSpan(input)
    try {
      const span = snapshotObservationSpan(backend(input))
      if (span !== undefined) return span
      this.counters.processorFailures++
      this.recordFailure('span:invalid', new TypeError('invalid span'),
        'observation span backend returned an invalid span', false)
    } catch (error) {
      this.counters.processorFailures++
      this.recordFailure('span:throw', error, 'observation span backend failed', false)
    }
    return createCoreSpan(input)
  }

  capture(event: ObservationEvent): CaptureReceipt {
    const eventId = eventIdOf(event)
    if (this.closing || this.closed) return receipt(eventId, 'rejected', 'none', 'closed')
    let processed: ObservationEvent
    try {
      processed = this.prepareEvent(event, false)
    } catch (error) {
      this.counters.processorFailures++
      this.counters.lastFailure = safeFailure(error, 'observation processor failed')
      this.notifyHealth()
      this.recordFailure('processor:capture', error, 'observation processor failed', true)
      return receipt(eventId, 'rejected', 'none', 'processor-failed')
    }
    const captured = this.enqueue(processed, false)
    if (captured.status !== 'accepted') return captured
    return this.stageExporters(processed, captured)
  }

  async checkpoint(event: ObservationEvent, signal?: AbortSignal): Promise<CaptureReceipt> {
    const captured = this.capture(event)
    if (captured.status !== 'accepted') return captured
    if (this.mode === 'operational') return captured
    const terminal = this.queue.find(entry => entry.event.eventId === captured.eventId)?.event
    if (terminal === undefined) return receipt(captured.eventId, 'rejected', 'none', 'exporter-unavailable')
    const targetIds = new Set(this.queue
      .filter(entry => entry.event.priority === 'critical'
        && entry.event.correlation.runId === terminal.correlation.runId
        && entry.event.sequence <= terminal.sequence)
      .map(entry => entry.event.eventId))
    const outcome = await this.scheduleFlush(targetIds, this.options.flushTimeoutMs, signal)
    if (!outcome.requiredComplete) return receipt(captured.eventId, 'rejected', 'none', 'exporter-unavailable')
    return receipt(captured.eventId, 'accepted', requiredBoundary(this.registrations))
  }

  logger(context?: LoggerContext): SdkLogger {
    return createBusLogger({
      minimumLevel: this.options.minimumLogLevel as LogLevel,
      resource: this.resource,
      emit: event => { this.capture(event) },
    }, context)
  }

  health(): ObservationHealthSnapshot {
    const state = busHealthState(this.counters, this.closed)
    return deepFreeze({
      state,
      queuedEvents: this.queue.length,
      queuedBytes: this.queueBytes,
      accepted: this.counters.accepted,
      exported: this.counters.exported,
      droppedVerbose: this.counters.droppedVerbose,
      droppedNormal: this.counters.droppedNormal,
      criticalRejected: this.counters.criticalRejected,
      processorFailures: this.counters.processorFailures,
      exporterFailures: this.counters.exporterFailures,
      flushTimeouts: this.counters.flushTimeouts,
      ...this.counters.lastExportAt === undefined ? {} : { lastExportAt: this.counters.lastExportAt },
      ...this.counters.lastFailure === undefined ? {} : { lastFailure: this.counters.lastFailure },
    })
  }

  flush(signal?: AbortSignal): Promise<FlushResult> {
    if (this.closed || this.closing) throw new TypeError('observability is closed')
    return this.scheduleFlush(
      new Set(this.queue.map(entry => entry.event.eventId)), this.options.flushTimeoutMs, signal,
    ).then(publicFlushResult)
  }

  shutdown(signal?: AbortSignal): Promise<FlushResult> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.closing = true
    const targetIds = new Set(this.queue.map(entry => entry.event.eventId))
    this.shutdownPromise = (async () => {
      const deadline = deadlineSignal(this.options.shutdownTimeoutMs, signal)
      let result: FlushResult
      try {
        result = publicFlushResult(await this.scheduleFlush(
          targetIds, this.options.shutdownTimeoutMs, deadline.signal,
        ))
        for (const registration of [...this.registrations].reverse()) {
          const shutdown = registration.exporter.shutdown
          if (shutdown === undefined) continue
          try { await raceAbort(Promise.resolve(shutdown.call(registration.exporter, deadline.signal)),
            deadline.signal) }
          catch (error) {
            this.recordExporterFailure(registration, error, false)
            result = Object.freeze({ ...result, complete: false })
          }
        }
      } finally {
        deadline.clear()
        this.closed = true
        this.notifyHealth()
      }
      return result
    })()
    return this.shutdownPromise
  }

  private prepareEvent(event: ObservationEvent, protectedPath: boolean): ObservationEvent {
    const privacy = {
      content: this.options.content,
      redactors: this.options.redactors ?? [],
      includeErrorStacks: this.options.includeErrorStacks,
    }
    let current = sanitizeObservationEvent(event, privacy)
    if (protectedPath) return current
    for (const processor of this.processors) {
      const next = processor.transform(current)
      if (next === undefined) throw new TypeError(`observation processor ${processor.id} returned undefined`)
      const sanitized = sanitizeObservationEvent(next, privacy)
      if (!sameEnvelope(current, sanitized)) {
        throw new TypeError(`observation processor ${processor.id} changed the immutable event envelope`)
      }
      current = sanitized
    }
    return current
  }

  private enqueue(event: ObservationEvent, protectedPath: boolean): CaptureReceipt {
    const bytes = serializedEventBytes(event)
    if (bytes > this.options.maxBatchBytes || bytes > this.options.maxQueueBytes
      || !this.makeCapacity(bytes, protectedPath)) {
      if (!protectedPath && event.priority === 'critical') this.counters.criticalRejected++
      if (!protectedPath) {
        this.counters.lastFailure = safeFailure(new RangeError('capacity'), 'observation queue capacity exhausted')
        this.notifyHealth()
      }
      return receipt(event.eventId, 'rejected', 'none', 'capacity')
    }
    this.queue.push({
      event, bytes, protected: protectedPath,
      pending: new Set(this.registrations.map(registration => registration.exporter.id)),
    })
    this.queueBytes += bytes
    this.counters.accepted++
    this.notifyHealth()
    return receipt(event.eventId, 'accepted')
  }

  private stageExporters(event: ObservationEvent, captured: CaptureReceipt): CaptureReceipt {
    const entry = this.queue.find(candidate => candidate.event.eventId === event.eventId)
    if (entry === undefined) return receipt(event.eventId, 'rejected', 'none', 'exporter-unavailable')
    let removedPending = false
    for (const registration of this.registrations) {
      const stage = registration.exporter.stage
      if (stage === undefined) continue
      try {
        const pending = stage.call(registration.exporter, event)
        if (pending !== undefined) void Promise.resolve(pending).catch(() => undefined)
      } catch (error) {
        const failed = this.rejectStagedExporter(entry, registration, error)
        removedPending = true
        if (failed !== undefined) return failed
      }
    }
    if (removedPending && entry.pending.size === 0) this.removeEntry(entry, false)
    return captured
  }

  private rejectStagedExporter(
    entry: QueueEntry, registration: ObservationExporterRegistration, error: unknown,
  ): CaptureReceipt | undefined {
    const event = entry.event
    this.recordExporterFailure(registration, error, false)
    entry.pending.delete(registration.exporter.id)
    if (registration.requirement !== 'required') return undefined
    this.removeEntry(entry, false)
    if (event.priority === 'critical') this.counters.criticalRejected++
    this.notifyHealth()
    return receipt(event.eventId, 'rejected', 'none', 'exporter-unavailable')
  }

  private makeCapacity(incomingBytes: number, protectedPath: boolean): boolean {
    while (this.queue.length + 1 > this.options.maxQueueEvents
      || this.queueBytes + incomingBytes > this.options.maxQueueBytes) {
      let index = this.queue.findIndex(entry => entry.event.priority === 'verbose')
      if (index === -1) index = this.queue.findIndex(entry => entry.event.priority === 'normal')
      if (index === -1) return false
      const [removed] = this.queue.splice(index, 1)
      if (removed === undefined) return false
      this.queueBytes -= removed.bytes
      if (!protectedPath) {
        if (removed.event.priority === 'verbose') this.counters.droppedVerbose++
        else this.counters.droppedNormal++
      }
    }
    return true
  }

  private scheduleFlush(targetIds: ReadonlySet<string>, timeoutMs: number,
    signal?: AbortSignal): Promise<FlushOutcome> {
    let resolveResult!: (result: FlushOutcome) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<FlushOutcome>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
    const task = async () => {
      try { resolveResult(await this.flushInternal(targetIds, timeoutMs, signal)) }
      catch (error) { rejectResult(error) }
    }
    this.flushChain = this.flushChain.then(task, task)
    return result
  }

  private async flushInternal(
    targetIds: ReadonlySet<string>,
    timeoutMs: number,
    external?: AbortSignal,
  ): Promise<FlushOutcome> {
    return await flushBus({
      queue: this.queue, registrations: this.registrations, counters: this.counters, options: this.options,
      removeEntry: (entry, exported) => this.removeEntry(entry, exported),
      recordExporterFailure: (registration, error) => this.recordExporterFailure(registration, error, true),
      notifyHealth: () => this.notifyHealth(),
    }, targetIds, timeoutMs, external)
  }

  private removeEntry(entry: QueueEntry, exported: boolean): void {
    const index = this.queue.indexOf(entry)
    if (index === -1) return
    this.queue.splice(index, 1)
    this.queueBytes -= entry.bytes
    if (exported) this.counters.exported++
  }

  private recordExporterFailure(
    registration: ObservationExporterRegistration,
    error: unknown,
    emitProtected: boolean,
  ): void {
    this.counters.exporterFailures++
    if (registration.requirement === 'required') this.counters.requiredFailure = true
    this.counters.lastFailure = safeFailure(error, 'observation exporter failed')
    this.notifyHealth()
    if (emitProtected) this.recordFailure(
      `exporter:${registration.exporter.id}`, error, 'observation exporter failed', true,
    )
  }

  private recordFailure(key: string, error: unknown, message: string, emit: boolean): void {
    this.counters.lastFailure = safeFailure(error, message)
    this.notifyHealth()
    if (!emit || this.protectedFailures.has(key) || this.closing || this.closed) return
    this.protectedFailures.add(key)
    try {
      const event = this.prepareEvent({
        schemaVersion: 1,
        eventId: createOperationId(),
        sequence: this.healthScope.nextSequence(),
        name: 'sdk.observer.failure',
        phase: 'point',
        occurredAt: new Date().toISOString(),
        monotonicMs: this.healthScope.monotonicMs(),
        priority: 'critical',
        resource: this.resource,
        correlation: this.healthCorrelation,
        data: {
          observerId: key,
          failureKind: 'contained',
          count: 1,
          error: { ...this.counters.lastFailure },
        },
      }, true)
      this.enqueue(event, true)
    } catch { /* health counters are the final protected path */ }
  }

  private notifyHealth(): void {
    const callback = this.options.onHealthChange
    if (callback === undefined) return
    try { callback(this.health()) } catch { /* emergency callback is separately contained */ }
  }
}

/** Create one Universal observation bus. Construction validates every durability claim. */
export function createObservability(options: ObservabilityOptions = {}): Observability {
  return new ObservationBus(options)
}
