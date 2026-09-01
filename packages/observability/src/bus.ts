import {
  SDK_VERSION,
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  deepFreeze,
  safeErrorRecord,
  snapshotObservationSpan,
  type CaptureReceipt,
  type ObservationBoundary,
  type ObservationEvent,
  type ObservationResource,
  type ObservationSpan,
  type OpenObservationSpanInput,
  type SafeErrorRecord,
} from '@ai-agent-sdk/core'
import { createBusLogger } from './logger.ts'
import { sanitizeObservationEvent, serializedEventBytes } from './privacy.ts'
import type {
  ExportAck,
  FlushResult,
  LoggerContext,
  LogLevel,
  ObservationBatch,
  ObservationExporterRegistration,
  ObservationHealthSnapshot,
  ObservationProcessor,
  Observability,
  ObservabilityOptions,
  SdkLogger,
} from './types.ts'

const DEFAULT_MAX_QUEUE_EVENTS = 10_000
const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_BATCH_EVENTS = 256
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000

interface QueueEntry {
  readonly event: ObservationEvent
  readonly bytes: number
  readonly pending: Set<string>
  readonly protected: boolean
}

interface MutableHealth {
  accepted: number
  exported: number
  droppedVerbose: number
  droppedNormal: number
  criticalRejected: number
  processorFailures: number
  exporterFailures: number
  flushTimeouts: number
  lastExportAt?: string
  lastFailure?: SafeErrorRecord
  requiredFailure: boolean
}

interface FlushOutcome extends FlushResult {
  readonly requiredComplete: boolean
}

const BOUNDARY_RANK: Readonly<Record<ObservationBoundary, number>> = {
  none: 0, 'local-durable': 1, 'remote-acknowledged': 2,
}
const SAFE_FAILURE_CODES = new Set([
  'ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'OBSERVABILITY_EXPORT_FAILED', 'OBSERVABILITY_FLUSH_TIMEOUT',
  'OBSERVABILITY_PROCESSOR_FAILED',
])
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/
const CONTENT_POLICIES = new Set(['none', 'metadata', 'redacted', 'full'])
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`)
  return value
}

function safeFailure(error: unknown, message: string): SafeErrorRecord {
  const source = safeErrorRecord(error)
  return deepFreeze({
    type: ['AbortError', 'Error', 'RangeError', 'TypeError'].includes(source.type) ? source.type : 'Error',
    message,
    ...source.code !== undefined && SAFE_FAILURE_CODES.has(source.code) ? { code: source.code } : {},
    ...source.retryable === undefined ? {} : { retryable: source.retryable },
    ...source.status === undefined ? {} : { status: source.status },
  })
}

function receipt(
  eventId: string,
  status: CaptureReceipt['status'],
  boundary: ObservationBoundary = 'none',
  reason?: CaptureReceipt['reason'],
): CaptureReceipt {
  return Object.freeze({
    eventId, status, durable: status === 'accepted' && boundary !== 'none', boundary,
    ...reason === undefined ? {} : { reason },
  })
}

function eventIdOf(event: unknown): string {
  try {
    const value = Reflect.get(event as object, 'eventId')
    return typeof value === 'string' && value.length > 0 ? value : createOperationId()
  } catch { return createOperationId() }
}

function requiredBoundary(registrations: readonly ObservationExporterRegistration[]): ObservationBoundary {
  let result: ObservationBoundary = 'none'
  for (const registration of registrations) {
    if (registration.requirement === 'required'
      && BOUNDARY_RANK[registration.boundary] > BOUNDARY_RANK[result]) result = registration.boundary
  }
  return result
}

function validateRegistrations(
  mode: Observability['mode'],
  registrations: readonly ObservationExporterRegistration[],
): readonly ObservationExporterRegistration[] {
  const ids = new Set<string>()
  for (const registration of registrations) {
    const id = registration.exporter?.id
    if (typeof id !== 'string' || !COMPONENT_ID_PATTERN.test(id)) {
      throw new TypeError('observation exporter id must be a safe 1-64 character identifier')
    }
    if (ids.has(id)) throw new TypeError(`duplicate observation exporter id: ${id}`)
    ids.add(id)
    if (registration.requirement !== 'required' && registration.requirement !== 'best-effort') {
      throw new TypeError(`observation exporter ${id} has an invalid requirement`)
    }
    if (!(registration.boundary in BOUNDARY_RANK)) throw new TypeError(`observation exporter ${id} has an invalid boundary`)
    const supported = registration.exporter.supportedBoundaries ?? ['none']
    if (typeof registration.exporter.export !== 'function') {
      throw new TypeError(`observation exporter ${id} has no export function`)
    }
    if (!supported.includes(registration.boundary)) {
      throw new TypeError(`observation exporter ${id} does not support ${registration.boundary}`)
    }
    if (mode === 'operational' && registration.requirement === 'required') {
      throw new TypeError('operational observation exporters must be best-effort')
    }
  }
  if (mode !== 'operational' && !registrations.some(registration => (
    registration.requirement === 'required' && registration.boundary !== 'none'
  ))) throw new TypeError(`${mode} observability requires a durable required exporter`)
  return Object.freeze(registrations.map(registration => Object.freeze({ ...registration })))
}

function deadlineSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('observation deadline exceeded', 'TimeoutError')), timeoutMs)
  const abort = () => controller.abort(external?.reason ?? new DOMException('observation aborted', 'AbortError'))
  if (external?.aborted === true) abort()
  else external?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    clear() { clearTimeout(timeout); external?.removeEventListener('abort', abort) },
  }
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('observation aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('observation aborted')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

function isTimeoutAbort(signal: AbortSignal): boolean {
  try {
    const reason = signal.reason
    return typeof reason === 'object' && reason !== null
      && Reflect.get(reason, 'name') === 'TimeoutError'
  } catch { return false }
}

function publicFlushResult(outcome: FlushOutcome): FlushResult {
  return Object.freeze({
    complete: outcome.complete,
    exportedEvents: outcome.exportedEvents,
    pendingEvents: outcome.pendingEvents,
    rejectedCritical: outcome.rejectedCritical,
    timedOut: outcome.timedOut,
  })
}

function sameEnvelope(left: ObservationEvent, right: ObservationEvent): boolean {
  return left.eventId === right.eventId && left.sequence === right.sequence
    && left.name === right.name && left.phase === right.phase
    && left.occurredAt === right.occurredAt && left.monotonicMs === right.monotonicMs
    && left.priority === right.priority
    && JSON.stringify(left.resource) === JSON.stringify(right.resource)
    && JSON.stringify(left.correlation) === JSON.stringify(right.correlation)
}

class ObservationBus implements Observability {
  readonly mode: Observability['mode']
  readonly resource: ObservationResource
  private readonly registrations: readonly ObservationExporterRegistration[]
  private readonly processors: readonly ObservationProcessor[]
  private readonly options: Required<Pick<ObservabilityOptions,
    'content' | 'includeErrorStacks' | 'minimumLogLevel' | 'maxQueueEvents' | 'maxQueueBytes'
    | 'maxBatchEvents' | 'maxBatchBytes' | 'flushTimeoutMs' | 'shutdownTimeoutMs'>>
    & Pick<ObservabilityOptions, 'redactors' | 'onHealthChange' | 'openSpan'>
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
    this.resource = deepFreeze({
      sdkName: 'ai-agent-sdk',
      sdkVersion: input.resource?.sdkVersion ?? SDK_VERSION,
      ...input.resource?.serviceName === undefined ? {} : { serviceName: input.resource.serviceName },
      ...input.resource?.serviceVersion === undefined ? {} : { serviceVersion: input.resource.serviceVersion },
      runtime: input.resource?.runtime ?? 'unknown',
    })
    this.registrations = validateRegistrations(this.mode, input.exporters ?? [])
    const processorIds = new Set<string>()
    for (const processor of input.processors ?? []) {
      if (typeof processor.id !== 'string' || !COMPONENT_ID_PATTERN.test(processor.id)) {
        throw new TypeError('processor id must be a safe 1-64 character identifier')
      }
      if (processorIds.has(processor.id)) throw new TypeError(`duplicate observation processor id: ${processor.id}`)
      if (typeof processor.transform !== 'function') throw new TypeError(`observation processor ${processor.id} is invalid`)
      processorIds.add(processor.id)
    }
    this.processors = Object.freeze([...(input.processors ?? [])])
    if (!CONTENT_POLICIES.has(input.content ?? 'none')) throw new TypeError('invalid observation content policy')
    if (!LOG_LEVELS.has(input.minimumLogLevel ?? 'info')) throw new TypeError('invalid minimum log level')
    const redactorIds = new Set<string>()
    for (const redactor of input.redactors ?? []) {
      if (typeof redactor.id !== 'string' || !COMPONENT_ID_PATTERN.test(redactor.id)
        || typeof redactor.redact !== 'function') throw new TypeError('invalid observation content redactor')
      if (redactorIds.has(redactor.id)) throw new TypeError(`duplicate observation redactor id: ${redactor.id}`)
      redactorIds.add(redactor.id)
    }
    this.options = {
      content: input.content ?? 'none',
      includeErrorStacks: input.includeErrorStacks ?? false,
      minimumLogLevel: input.minimumLogLevel ?? 'info',
      maxQueueEvents: positiveSafeInteger(input.maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS, 'maxQueueEvents'),
      maxQueueBytes: positiveSafeInteger(input.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES, 'maxQueueBytes'),
      maxBatchEvents: positiveSafeInteger(input.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS, 'maxBatchEvents'),
      maxBatchBytes: positiveSafeInteger(input.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES, 'maxBatchBytes'),
      flushTimeoutMs: positiveSafeInteger(input.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS, 'flushTimeoutMs'),
      shutdownTimeoutMs: positiveSafeInteger(input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS, 'shutdownTimeoutMs'),
      redactors: Object.freeze([...(input.redactors ?? [])]),
      ...input.onHealthChange === undefined ? {} : { onHealthChange: input.onHealthChange },
      ...input.openSpan === undefined ? {} : { openSpan: input.openSpan },
    }
  }

  openSpan(input: OpenObservationSpanInput): ObservationSpan {
    const backend = this.options.openSpan
    if (backend === undefined) return createCoreSpan(input)
    try {
      const span = snapshotObservationSpan(backend(input))
      if (span !== undefined) return span
      this.counters.processorFailures++
      this.recordFailure('span:invalid', new TypeError('invalid span'), 'observation span backend returned an invalid span', false)
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
    const state: ObservationHealthSnapshot['state'] = this.closed
      ? 'closed'
      : this.counters.requiredFailure || this.counters.criticalRejected > 0 || this.counters.flushTimeouts > 0
        ? 'failed'
        : this.counters.processorFailures > 0 || this.counters.exporterFailures > 0
          || this.counters.droppedVerbose > 0 || this.counters.droppedNormal > 0
          ? 'degraded'
          : 'healthy'
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
          try { await raceAbort(Promise.resolve(shutdown.call(registration.exporter, deadline.signal)), deadline.signal) }
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
        this.recordExporterFailure(registration, error, false)
        entry.pending.delete(registration.exporter.id)
        removedPending = true
        if (registration.requirement === 'required') {
          this.removeEntry(entry, false)
          if (event.priority === 'critical') this.counters.criticalRejected++
          this.notifyHealth()
          return receipt(event.eventId, 'rejected', 'none', 'exporter-unavailable')
        }
      }
    }
    if (removedPending && entry.pending.size === 0) this.removeEntry(entry, false)
    return captured
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

  private scheduleFlush(targetIds: ReadonlySet<string>, timeoutMs: number, signal?: AbortSignal): Promise<FlushOutcome> {
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
    const beforeExported = this.counters.exported
    const deadline = deadlineSignal(timeoutMs, external)
    let failed = false
    let timedOut = false
    try {
      if (this.registrations.length === 0) {
        for (const entry of [...this.queue]) if (targetIds.has(entry.event.eventId)) this.removeEntry(entry, false)
      }
      for (const registration of this.registrations) {
        while (true) {
          const candidates = this.queue.filter(entry => (
            targetIds.has(entry.event.eventId) && entry.pending.has(registration.exporter.id)
          ))
          if (candidates.length === 0) break
          const entries: QueueEntry[] = []
          let bytes = 0
          for (const entry of candidates) {
            if (entries.length >= this.options.maxBatchEvents || bytes + entry.bytes > this.options.maxBatchBytes) break
            entries.push(entry)
            bytes += entry.bytes
          }
          if (entries.length === 0) break
          const batch: ObservationBatch = deepFreeze({
            schemaVersion: 1,
            batchId: createOperationId(),
            createdAt: new Date().toISOString(),
            events: entries.map(entry => entry.event),
          })
          let ack: ExportAck
          try {
            ack = await raceAbort(Promise.resolve(registration.exporter.export(batch, deadline.signal)), deadline.signal)
            if (ack.batchId !== batch.batchId || ack.accepted !== true) {
              throw new TypeError(`observation exporter ${registration.exporter.id} returned an invalid acknowledgment`)
            }
          } catch (error) {
            failed = true
            timedOut ||= isTimeoutAbort(deadline.signal)
            this.recordExporterFailure(registration, error, true)
            if (registration.requirement === 'best-effort') {
              for (const entry of entries) {
                entry.pending.delete(registration.exporter.id)
                if (entry.pending.size === 0) this.removeEntry(entry, false)
              }
            }
            break
          }
          this.counters.lastExportAt = new Date().toISOString()
          for (const entry of entries) {
            entry.pending.delete(registration.exporter.id)
            if (entry.pending.size === 0) this.removeEntry(entry, true)
          }
          this.notifyHealth()
        }
      }
    } finally {
      if (isTimeoutAbort(deadline.signal)) {
        timedOut = true
        this.counters.flushTimeouts++
        this.counters.lastFailure = safeFailure(deadline.signal.reason, 'observation flush timed out')
        this.notifyHealth()
      }
      deadline.clear()
    }
    const pendingEntries = this.queue.filter(entry => targetIds.has(entry.event.eventId))
    const requiredIds = this.registrations
      .filter(registration => registration.requirement === 'required')
      .map(registration => registration.exporter.id)
    const requiredComplete = pendingEntries.every(entry => requiredIds.every(id => !entry.pending.has(id)))
    return Object.freeze({
      complete: !failed && !timedOut && pendingEntries.length === 0,
      requiredComplete,
      exportedEvents: this.counters.exported - beforeExported,
      pendingEvents: pendingEntries.length,
      rejectedCritical: this.counters.criticalRejected,
      timedOut,
    })
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
