import { SDK_VERSION, deepFreeze } from '../primitives/index.ts'
import { createOperationId, safeErrorRecord, type CaptureReceipt, type ObservationBoundary,
  type ObservationEvent, type ObservationResource, type SafeErrorRecord } from '../observation/index.ts'
import type { FlushResult, ObservationExporterRegistration, ObservationProcessor,
  Observability, ObservabilityOptions, ObservationHealthSnapshot } from './types.ts'
import type { BusOptions, FlushOutcome, MutableHealth } from './bus-types.ts'

const DEFAULT_MAX_QUEUE_EVENTS = 10_000
const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_BATCH_EVENTS = 256
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000

const BOUNDARY_RANK: Readonly<Record<ObservationBoundary, number>> = {
  none: 0, 'local-durable': 1, 'remote-acknowledged': 2,
}
const SAFE_FAILURE_CODES = new Set([
  'ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ETIMEDOUT', 'OBSERVABILITY_EXPORT_FAILED', 'OBSERVABILITY_FLUSH_TIMEOUT',
  'OBSERVABILITY_PROCESSOR_FAILED', 'OTEL_PROVIDER_UNCONFIGURED',
])
const COMPONENT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/
const CONTENT_POLICIES = new Set(['none', 'metadata', 'redacted', 'full'])
const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`)
  return value
}

export function safeFailure(error: unknown, message: string): SafeErrorRecord {
  const source = safeErrorRecord(error)
  return deepFreeze({
    type: ['AbortError', 'Error', 'RangeError', 'TypeError'].includes(source.type) ? source.type : 'Error',
    message,
    ...source.code !== undefined && SAFE_FAILURE_CODES.has(source.code) ? { code: source.code } : {},
    ...source.retryable === undefined ? {} : { retryable: source.retryable },
    ...source.status === undefined ? {} : { status: source.status },
  })
}

export function receipt(
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

export function eventIdOf(event: unknown): string {
  try {
    const value = Reflect.get(event as object, 'eventId')
    return typeof value === 'string' && value.length > 0 ? value : createOperationId()
  } catch { return createOperationId() }
}

export function requiredBoundary(registrations: readonly ObservationExporterRegistration[]): ObservationBoundary {
  let result: ObservationBoundary = 'none'
  for (const registration of registrations) {
    if (registration.requirement === 'required'
      && BOUNDARY_RANK[registration.boundary] > BOUNDARY_RANK[result]) result = registration.boundary
  }
  return result
}

export function validateRegistrations(
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
    validateExporter(registration, id, mode)
  }
  if (mode !== 'operational' && !registrations.some(registration => (
    registration.requirement === 'required' && registration.boundary !== 'none'
  ))) throw new TypeError(`${mode} observability requires a durable required exporter`)
  return Object.freeze(registrations.map(registration => Object.freeze({ ...registration })))
}

function validateExporter(
  registration: ObservationExporterRegistration, id: string, mode: Observability['mode'],
): void {
  if (registration.requirement !== 'required' && registration.requirement !== 'best-effort') {
    throw new TypeError(`observation exporter ${id} has an invalid requirement`)
  }
  if (!(registration.boundary in BOUNDARY_RANK)) {
    throw new TypeError(`observation exporter ${id} has an invalid boundary`)
  }
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

export function deadlineSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('observation deadline exceeded',
    'TimeoutError')), timeoutMs)
  const abort = () => controller.abort(external?.reason ?? new DOMException('observation aborted', 'AbortError'))
  if (external?.aborted === true) abort()
  else external?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    clear() { clearTimeout(timeout); external?.removeEventListener('abort', abort) },
  }
}

export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
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

export function isTimeoutAbort(signal: AbortSignal): boolean {
  try {
    const reason = signal.reason
    return typeof reason === 'object' && reason !== null
      && Reflect.get(reason, 'name') === 'TimeoutError'
  } catch { return false }
}

export function publicFlushResult(outcome: FlushOutcome): FlushResult {
  return Object.freeze({
    complete: outcome.complete,
    exportedEvents: outcome.exportedEvents,
    pendingEvents: outcome.pendingEvents,
    rejectedCritical: outcome.rejectedCritical,
    timedOut: outcome.timedOut,
  })
}

export function sameEnvelope(left: ObservationEvent, right: ObservationEvent): boolean {
  return left.eventId === right.eventId && left.sequence === right.sequence
    && left.name === right.name && left.phase === right.phase
    && left.occurredAt === right.occurredAt && left.monotonicMs === right.monotonicMs
    && left.priority === right.priority
    && JSON.stringify(left.resource) === JSON.stringify(right.resource)
    && JSON.stringify(left.correlation) === JSON.stringify(right.correlation)
}

export function busResource(input: ObservabilityOptions): ObservationResource {
  return deepFreeze({
      sdkName: 'ai-agent-sdk',
      sdkVersion: input.resource?.sdkVersion ?? SDK_VERSION,
      ...input.resource?.serviceName === undefined ? {} : { serviceName: input.resource.serviceName },
      ...input.resource?.serviceVersion === undefined ? {} : { serviceVersion: input.resource.serviceVersion },
      runtime: input.resource?.runtime ?? 'unknown',
    })
}

export function busProcessors(input: ObservabilityOptions): readonly ObservationProcessor[] {
  const processorIds = new Set<string>()
  for (const processor of input.processors ?? []) {
    if (typeof processor.id !== 'string' || !COMPONENT_ID_PATTERN.test(processor.id)) {
      throw new TypeError('processor id must be a safe 1-64 character identifier')
    }
    if (processorIds.has(processor.id)) throw new TypeError(`duplicate observation processor id: ${processor.id}`)
    if (typeof processor.transform !== 'function') {
      throw new TypeError(`observation processor ${processor.id} is invalid`)
    }
    processorIds.add(processor.id)
  }
  return Object.freeze([...(input.processors ?? [])])
}

export function busOptions(input: ObservabilityOptions): BusOptions {
  validateBusOptions(input)
  return {
    content: input.content ?? 'none',
    includeErrorStacks: input.includeErrorStacks ?? false,
    minimumLogLevel: input.minimumLogLevel ?? 'info',
    ...busLimits(input),
    redactors: Object.freeze([...(input.redactors ?? [])]),
    ...input.onHealthChange === undefined ? {} : { onHealthChange: input.onHealthChange },
    ...input.openSpan === undefined ? {} : { openSpan: input.openSpan },
  }
}

function validateBusOptions(input: ObservabilityOptions): void {
  if (!CONTENT_POLICIES.has(input.content ?? 'none')) throw new TypeError('invalid observation content policy')
  if (!LOG_LEVELS.has(input.minimumLogLevel ?? 'info')) throw new TypeError('invalid minimum log level')
  validateRedactors(input.redactors ?? [])
}

function validateRedactors(redactors: NonNullable<ObservabilityOptions['redactors']>): void {
  const redactorIds = new Set<string>()
  for (const redactor of redactors) {
    if (typeof redactor.id !== 'string' || !COMPONENT_ID_PATTERN.test(redactor.id)
      || typeof redactor.redact !== 'function') throw new TypeError('invalid observation content redactor')
    if (redactorIds.has(redactor.id)) throw new TypeError(`duplicate observation redactor id: ${redactor.id}`)
    redactorIds.add(redactor.id)
  }
}

function busLimits(input: ObservabilityOptions): Pick<BusOptions,
  'maxQueueEvents' | 'maxQueueBytes' | 'maxBatchEvents' | 'maxBatchBytes' | 'flushTimeoutMs' | 'shutdownTimeoutMs'> {
  return {
      maxQueueEvents: positiveSafeInteger(input.maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS, 'maxQueueEvents'),
      maxQueueBytes: positiveSafeInteger(input.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES, 'maxQueueBytes'),
      maxBatchEvents: positiveSafeInteger(input.maxBatchEvents ?? DEFAULT_MAX_BATCH_EVENTS, 'maxBatchEvents'),
      maxBatchBytes: positiveSafeInteger(input.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES, 'maxBatchBytes'),
      flushTimeoutMs: positiveSafeInteger(input.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS, 'flushTimeoutMs'),
      shutdownTimeoutMs: positiveSafeInteger(input.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        'shutdownTimeoutMs'),
  }
}

export function busHealthState(counters: MutableHealth, closed: boolean): ObservationHealthSnapshot['state'] {
  if (closed) return 'closed'
  if (counters.requiredFailure || counters.criticalRejected > 0 || counters.flushTimeouts > 0) return 'failed'
  if (counters.processorFailures > 0 || counters.exporterFailures > 0
    || counters.droppedVerbose > 0 || counters.droppedNormal > 0) return 'degraded'
  return 'healthy'
}
