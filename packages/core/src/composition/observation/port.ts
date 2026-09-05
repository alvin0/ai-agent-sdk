import {
  createCoreSpan, snapshotObservationSpan, type CaptureReceipt, type DeliveryMode, type ObservationBoundary,
  type ObservationEvent, type ObservationPort, type ObservationSpan, type OpenObservationSpanInput,
} from '../../observation/index.ts'
import type { RuntimePlatform } from '../../platform/adapter.ts'
import { timeoutValue } from '../../platform/config.ts'
import { RuntimeResources } from '../../platform/resources.ts'
import { DiagnosticRing, type DiagnosticRingOptions, type DiagnosticRingSnapshot } from '../diagnostics/ring.ts'
import type { RunTerminalRecord } from '../exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import { DeliveryStaging, type StagingFailure } from '../delivery/staging.ts'
import type { RuntimeObservationResource } from '../delivery/resource.ts'
import { DeliveryQueueScheduler, type QueueFlushReport } from '../queue/scheduler.ts'
import { DeliveryQueueStore, type DeliveryQueueOptions } from '../queue/store.ts'
import type { QueueAdmission } from '../queue/types.ts'
import { CLOSED_RUNTIME_LOGGER, createCorrelatedRuntimeLogger, createRuntimeLogger, type RuntimeLoggerContext } from '../logging/logger.ts'
import type { CorrelationContext } from '../../observation/context.ts'
import { eventHasIntegrationEvidence } from '../logging/integration.ts'
import { LOG_LEVEL_RANK } from '../logging/config.ts'
import type { LogLevel, SdkLogger } from '../../logging/types.ts'
import type { ContentRedactor, ObservationProcessor } from '../../observation/telemetry-types.ts'
import { sanitizeObservationEvent } from '../../observation/privacy.ts'
import { RUNTIME_OBSERVATION_DEFAULTS } from './config.ts'
import type { RuntimeObservationHealthSnapshot } from './health.ts'
import { saturatingCounterAdd } from '../common/counter.ts'

export interface RuntimeObservationPortOptions extends DeliveryQueueOptions {
  readonly mode?: DeliveryMode
  readonly flushTimeoutMs?: number
  readonly diagnosticMaxEvents?: DiagnosticRingOptions['maxEvents']
  readonly diagnosticMaxBytes?: DiagnosticRingOptions['maxBytes']
  readonly minimumLogLevel?: LogLevel
  readonly processors?: readonly ObservationProcessor[]
  readonly redactors?: readonly ContentRedactor[]
  readonly includeErrorStacks?: boolean
  readonly openSpan?: (input: OpenObservationSpanInput) => ObservationSpan
  readonly shutdownTimeoutMs?: number
}

export interface TerminalCheckpointResult {
  readonly runId: string
  readonly status: 'accepted' | 'rejected' | 'closed'
  readonly durable: boolean
  readonly boundary: ObservationBoundary
  readonly reason?: 'capacity' | 'closed' | 'exporter-unavailable'
  readonly delivery?: QueueFlushReport
}
export interface RuntimeDiagnosticSnapshot extends DiagnosticRingSnapshot {
  readonly resource: RuntimeObservationResource
  readonly observationHealth: RuntimeObservationHealthSnapshot
}

/** Internal canonical port; public runtime wiring owns option grammar and terminal report projection. */
export class RuntimeObservationPort implements ObservationPort {
  readonly mode: DeliveryMode
  private readonly store: DeliveryQueueStore
  private readonly scheduler: DeliveryQueueScheduler
  private readonly diagnosticsRing: DiagnosticRing
  private readonly flushTimeoutMs: number
  private readonly stagingFailures: StagingFailure[] = []
  private stagingFailureCount = 0
  private readonly integrationEvidence = { accepted: 0, filtered: 0, dropped: 0, rejected: 0 }
  private readonly minimumLogLevel: LogLevel
  private readonly processors: readonly ObservationProcessor[]
  private readonly redactors: readonly ContentRedactor[]
  private readonly includeErrorStacks: boolean
  private readonly spanBackend: ((input: OpenObservationSpanInput) => ObservationSpan) | undefined
  private readonly shutdownTimeoutMs: number
  private processorFailures = 0
  readonly requiredBoundary: ObservationBoundary
  private admissionClosed = false
  private sealed = false

  constructor(
    readonly resource: RuntimeObservationResource,
    registrations: readonly RuntimeObservationExporterRegistration[],
    private readonly platform: RuntimePlatform,
    resources: RuntimeResources,
    options: RuntimeObservationPortOptions = {},
  ) {
    this.mode = options.mode ?? 'operational'
    validateMode(this.mode, registrations)
    this.requiredBoundary = this.mode === 'operational' ? 'none' : requiredBoundary(registrations)
    this.flushTimeoutMs = timeoutValue(options.flushTimeoutMs ?? RUNTIME_OBSERVATION_DEFAULTS.flushTimeoutMs)
    this.minimumLogLevel = options.minimumLogLevel ?? 'info'
    if (!(this.minimumLogLevel in LOG_LEVEL_RANK)) throw new TypeError('Invalid minimum log level')
    this.processors = Object.freeze([...(options.processors ?? [])])
    this.redactors = Object.freeze([...(options.redactors ?? [])])
    this.includeErrorStacks = options.includeErrorStacks ?? false
    this.spanBackend = options.openSpan
    this.shutdownTimeoutMs = timeoutValue(options.shutdownTimeoutMs ?? RUNTIME_OBSERVATION_DEFAULTS.shutdownTimeoutMs)
    const staging = new DeliveryStaging(registrations, failure => {
      this.stagingFailureCount = saturatingCounterAdd(this.stagingFailureCount, 1)
      if (this.stagingFailures.length === RUNTIME_OBSERVATION_DEFAULTS.stagingFailures) this.stagingFailures.splice(0, 1)
      this.stagingFailures.push(failure)
    })
    this.store = new DeliveryQueueStore(resource, staging, options, entry => {
      if (entry.kind === 'event' && eventHasIntegrationEvidence(entry.item as ObservationEvent)) this.integration('dropped')
    })
    this.scheduler = new DeliveryQueueScheduler(this.store, resource, registrations, platform, resources)
    this.diagnosticsRing = new DiagnosticRing({
      ...(options.diagnosticMaxEvents === undefined ? {} : { maxEvents: options.diagnosticMaxEvents }),
      ...(options.diagnosticMaxBytes === undefined ? {} : { maxBytes: options.diagnosticMaxBytes }),
    })
  }

  openSpan(input: OpenObservationSpanInput): ObservationSpan {
    if (this.spanBackend === undefined) return createCoreSpan(input)
    try {
      const span = snapshotObservationSpan(this.spanBackend(input))
      if (span !== undefined && span.correlation.runId === input.runId) return span
    } catch { /* Contained as observation health below. */ }
    this.processorFailures = saturatingCounterAdd(this.processorFailures, 1)
    return createCoreSpan(input)
  }

  capture(event: ObservationEvent): CaptureReceipt {
    const admission = this.admitEvent(event)
    return eventReceipt(event.eventId, admission)
  }

  async checkpoint(event: ObservationEvent, signal?: AbortSignal): Promise<CaptureReceipt> {
    const admission = this.admitEvent(event)
    const captured = eventReceipt(event.eventId, admission)
    if (captured.status !== 'accepted' || this.mode === 'operational') return captured
    const entry = admission.entry
    if (entry === undefined) return rejectedEvent(event.eventId, 'exporter-unavailable')
    const delivery = await this.scheduler.checkpointRun(entry.runId, entry.sequence,
      this.deadline(), signal)
    return delivery.requiredComplete && delivery.reachedBoundary !== 'none'
      ? acceptedEvent(event.eventId, delivery.reachedBoundary)
      : rejectedEvent(event.eventId, this.sealed ? 'closed' : 'exporter-unavailable')
  }

  admitTerminal(record: RunTerminalRecord): QueueAdmission { return this.store.admitRunRecord(record) }

  async checkpointTerminal(record: RunTerminalRecord, signal?: AbortSignal): Promise<TerminalCheckpointResult> {
    const admission = this.admitTerminal(record)
    if (admission.status === 'closed') return terminalResult(record.runId, 'closed', 'none', 'closed')
    if (admission.status === 'rejected') return terminalResult(record.runId, 'rejected', 'none', 'capacity')
    if (this.mode === 'operational') return terminalResult(record.runId, 'accepted', 'none')
    const delivery = await this.scheduler.checkpointRun(record.runId, undefined,
      this.deadline(), signal)
    return delivery.requiredComplete && delivery.reachedBoundary !== 'none'
      ? terminalResult(record.runId, 'accepted', delivery.reachedBoundary, undefined, delivery)
      : terminalResult(record.runId, this.sealed ? 'closed' : 'rejected', 'none',
        this.sealed ? 'closed' : 'exporter-unavailable', delivery)
  }

  flush(signal?: AbortSignal): Promise<QueueFlushReport> {
    return this.scheduler.flush(this.deadline(), signal)
  }

  /** Runtime close supplies its one shared absolute deadline rather than a fresh flush budget. */
  flushUntil(deadlineAt: number): Promise<QueueFlushReport> {
    return this.scheduler.flush(deadlineAt)
  }

  diagnostics(): RuntimeDiagnosticSnapshot {
    return Object.freeze({ resource: this.resource, ...this.diagnosticsRing.snapshot(), observationHealth: this.health() })
  }

  health(): RuntimeObservationHealthSnapshot {
    const queue = this.store.snapshot(), delivery = this.scheduler.health()
    const failed = queue.criticalRejected > 0 || delivery.requiredFailure || delivery.flushTimeouts > 0
    const degraded = queue.evictedVerbose > 0 || queue.evictedNormal > 0 || this.processorFailures > 0
      || delivery.exporterFailures > 0 || this.stagingFailureCount > 0
    const state: RuntimeObservationHealthSnapshot['state'] = this.sealed ? 'closed' : failed ? 'failed' : degraded ? 'degraded' : 'healthy'
    const lastFailure = queue.criticalRejected > 0
      ? Object.freeze({ type: 'Error', message: 'Observation queue capacity exhausted', code: 'OBSERVABILITY_CAPTURE_REJECTED' })
      : delivery.flushTimeouts > 0
        ? Object.freeze({ type: 'Error', message: 'Observation flush timed out', code: 'OBSERVABILITY_FLUSH_TIMEOUT' })
        : this.processorFailures > 0
          ? Object.freeze({ type: 'Error', message: 'Observation processor did not complete', code: 'OBSERVATION_PROCESSOR_FAILED' })
          : delivery.exporterFailures > 0 || this.stagingFailureCount > 0
          ? Object.freeze({ type: 'Error', message: 'Observation exporter did not complete', code: 'OBSERVABILITY_EXPORT_FAILED' })
          : undefined
    return Object.freeze({ state, queuedEvents: queue.queuedItems, queuedBytes: queue.queuedBytes,
      accepted: queue.accepted, exported: delivery.exported,
      droppedVerbose: queue.evictedVerbose, droppedNormal: queue.evictedNormal,
      criticalRejected: queue.criticalRejected, processorFailures: this.processorFailures,
      exporterFailures: saturatingCounterAdd(delivery.exporterFailures, this.stagingFailureCount),
      flushTimeouts: delivery.flushTimeouts,
      ...(delivery.lastExportAt === undefined ? {} : { lastExportAt: delivery.lastExportAt }),
      ...(lastFailure === undefined ? {} : { lastFailure }),
      integrationEvidence: Object.freeze({ ...this.integrationEvidence }) })
  }

  logger(context?: RuntimeLoggerContext): SdkLogger {
    if (this.admissionClosed) return CLOSED_RUNTIME_LOGGER
    return createRuntimeLogger({ resource: this.resource, platform: this.platform, content: this.store.content,
      redactors: this.redactors, includeErrorStacks: this.includeErrorStacks,
      minimumLevel: this.minimumLogLevel, isClosed: () => this.admissionClosed,
      capture: event => this.capture(event), integration: outcome => this.integration(outcome) }, context)
  }

  /** Internal active-run view; callers cannot supply or replace correlation IDs. */
  correlatedLogger(correlation: CorrelationContext, context?: RuntimeLoggerContext): SdkLogger {
    if (this.admissionClosed) return CLOSED_RUNTIME_LOGGER
    return createCorrelatedRuntimeLogger({ resource: this.resource, platform: this.platform, content: this.store.content,
      redactors: this.redactors, includeErrorStacks: this.includeErrorStacks,
      minimumLevel: this.minimumLogLevel, isClosed: () => this.admissionClosed,
      capture: event => this.capture(event), integration: outcome => this.integration(outcome) }, correlation, context)
  }

  integrationEvidenceSnapshot(): Readonly<typeof this.integrationEvidence> {
    return Object.freeze({ ...this.integrationEvidence })
  }

  stagingFailureSnapshot(): readonly StagingFailure[] { return Object.freeze([...this.stagingFailures]) }

  observationDeadline(sharedDeadlineAt: number): number {
    return Math.min(sharedDeadlineAt, this.platform.monotonicNow() + this.shutdownTimeoutMs)
  }

  /** Reject capture and make every retained bound logger a no-op before the final drain. */
  stopAdmission(): void {
    if (this.admissionClosed) return
    this.admissionClosed = true
    this.scheduler.stopAdmission()
  }

  /** Final terminal transition after the close drain has settled or reached its deadline. */
  seal(): void {
    if (this.sealed) return
    this.stopAdmission()
    this.sealed = true
    this.scheduler.seal()
  }

  private admitEvent(event: ObservationEvent): QueueAdmission {
    let current: ObservationEvent
    try {
      const privacy = { content: this.store.content, redactors: this.redactors,
        includeErrorStacks: this.includeErrorStacks }
      current = sanitizeObservationEvent(event, privacy)
      for (const processor of this.processors) {
        const next = processor.transform(current)
        if (next === undefined) throw new TypeError('Observation processor returned no event')
        const safe = sanitizeObservationEvent(next, privacy)
        if (!sameEnvelope(current, safe)) throw new TypeError('Observation processor changed the event envelope')
        current = safe
      }
    } catch {
      this.processorFailures = saturatingCounterAdd(this.processorFailures, 1)
      return Object.freeze({ status: 'rejected', reason: 'processor-failed' })
    }
    const admission = this.store.admitEvent(current)
    if (admission.status === 'accepted' && admission.entry?.kind === 'event') {
      this.diagnosticsRing.record(admission.entry.item as ObservationEvent)
    }
    return admission
  }

  private deadline(): number { return this.platform.monotonicNow() + this.flushTimeoutMs }

  private integration(outcome: keyof typeof this.integrationEvidence): void {
    this.integrationEvidence[outcome] = saturatingCounterAdd(this.integrationEvidence[outcome], 1)
  }
}

function validateMode(mode: DeliveryMode, registrations: readonly RuntimeObservationExporterRegistration[]): void {
  if (mode !== 'operational' && mode !== 'reliable' && mode !== 'audit') throw new TypeError('Invalid observation delivery mode')
  if (mode === 'operational' && registrations.some(value => value.requirement === 'required')) {
    throw new TypeError('Operational observation exporters must be best-effort')
  }
  if (mode !== 'operational' && !registrations.some(value => value.requirement === 'required' && value.boundary !== 'none')) {
    throw new TypeError(`${mode} observation requires a durable required exporter`)
  }
}

function requiredBoundary(registrations: readonly RuntimeObservationExporterRegistration[]): ObservationBoundary {
  const values = registrations.filter(value => value.requirement === 'required').map(value => value.boundary)
  return values.reduce((left, right) => boundaryRank(left) <= boundaryRank(right) ? left : right)
}
function boundaryRank(value: ObservationBoundary): number { return value === 'remote-acknowledged' ? 2 : value === 'local-durable' ? 1 : 0 }
function eventReceipt(eventId: string, admission: QueueAdmission): CaptureReceipt {
  if (admission.status === 'accepted' || admission.status === 'existing') return acceptedEvent(eventId, 'none')
  return rejectedEvent(eventId, admission.status === 'closed' ? 'closed'
    : admission.reason === 'processor-failed' ? 'processor-failed' : 'capacity')
}
function acceptedEvent(eventId: string, boundary: ObservationBoundary): CaptureReceipt {
  return Object.freeze({ eventId, status: 'accepted', durable: boundary !== 'none', boundary })
}
function rejectedEvent(
  eventId: string,
  reason: 'capacity' | 'closed' | 'processor-failed' | 'exporter-unavailable',
): CaptureReceipt {
  return Object.freeze({ eventId, status: 'rejected', durable: false, boundary: 'none', reason })
}

function sameEnvelope(left: ObservationEvent, right: ObservationEvent): boolean {
  return left.eventId === right.eventId && left.sequence === right.sequence
    && left.name === right.name && left.phase === right.phase
    && left.occurredAt === right.occurredAt && left.monotonicMs === right.monotonicMs
    && left.priority === right.priority
    && JSON.stringify(left.resource) === JSON.stringify(right.resource)
    && JSON.stringify(left.correlation) === JSON.stringify(right.correlation)
}
function terminalResult(
  runId: string, status: TerminalCheckpointResult['status'], boundary: ObservationBoundary,
  reason?: TerminalCheckpointResult['reason'], delivery?: QueueFlushReport,
): TerminalCheckpointResult {
  return Object.freeze({ runId, status, durable: status === 'accepted' && boundary !== 'none', boundary,
    ...(reason === undefined ? {} : { reason }), ...(delivery === undefined ? {} : { delivery }) })
}
