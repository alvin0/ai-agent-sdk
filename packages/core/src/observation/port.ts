import { deepFreeze } from '../primitives/freeze.ts'
import { createSpanId, createTraceId, freezeCorrelation, isSpanId, isTraceId, traceparent, type CorrelationContext } from './context.ts'
import type { ObservationEvent, OperationStatus, SafeErrorRecord } from './event.ts'

export type DeliveryMode = 'operational' | 'reliable' | 'audit'
export type ObservationBoundary = 'none' | 'local-durable' | 'remote-acknowledged'

export interface CaptureReceipt {
  readonly eventId: string
  readonly status: 'accepted' | 'rejected' | 'disabled'
  readonly durable: boolean
  readonly boundary: ObservationBoundary
  readonly reason?: 'capacity' | 'closed' | 'processor-failed' | 'exporter-unavailable'
}

const RECEIPT_STATUSES = new Set<CaptureReceipt['status']>(['accepted', 'rejected', 'disabled'])
const RECEIPT_BOUNDARIES = new Set<ObservationBoundary>(['none', 'local-durable', 'remote-acknowledged'])
const RECEIPT_REASONS = new Set<NonNullable<CaptureReceipt['reason']>>([
  'capacity',
  'closed',
  'processor-failed',
  'exporter-unavailable',
])

/** Validate an untrusted observer receipt before using it for delivery claims. */
export function validateCaptureReceipt(value: unknown, eventId: string): CaptureReceipt {
  if (typeof value !== 'object' || value === null) throw new TypeError('observation receipt must be an object')
  let receipt: Readonly<Record<string, unknown>>
  try {
    receipt = {
      eventId: Reflect.get(value, 'eventId'),
      status: Reflect.get(value, 'status'),
      durable: Reflect.get(value, 'durable'),
      boundary: Reflect.get(value, 'boundary'),
      reason: Reflect.get(value, 'reason'),
    }
  } catch {
    throw new TypeError('observation receipt properties could not be read')
  }
  if (receipt.eventId !== eventId) throw new TypeError('observation receipt eventId mismatch')
  if (!RECEIPT_STATUSES.has(receipt.status as CaptureReceipt['status'])) throw new TypeError('observation receipt status is invalid')
  if (typeof receipt.durable !== 'boolean') throw new TypeError('observation receipt durable flag is invalid')
  if (!RECEIPT_BOUNDARIES.has(receipt.boundary as ObservationBoundary)) throw new TypeError('observation receipt boundary is invalid')
  if (receipt.reason !== undefined && !RECEIPT_REASONS.has(receipt.reason as NonNullable<CaptureReceipt['reason']>)) {
    throw new TypeError('observation receipt reason is invalid')
  }
  const status = receipt.status as CaptureReceipt['status']
  const boundary = receipt.boundary as ObservationBoundary
  const durable = receipt.durable
  if ((boundary === 'none') === durable) throw new TypeError('observation receipt durable flag contradicts its boundary')
  if (status !== 'accepted' && (durable || boundary !== 'none')) {
    throw new TypeError('a rejected or disabled observation receipt cannot claim durability')
  }
  return Object.freeze({
    eventId,
    status,
    durable,
    boundary,
    ...receipt.reason === undefined ? {} : { reason: receipt.reason as NonNullable<CaptureReceipt['reason']> },
  })
}

export type ObservationSpanName =
  | 'sdk.agent.run'
  | 'sdk.agent.turn'
  | 'sdk.model.call'
  | 'sdk.embedding.call'
  | 'sdk.embedding.batch'
  | 'sdk.provider.attempt'
  | 'sdk.tool.call'
  | 'sdk.compaction'
  | 'sdk.hook.call'
  | 'sdk.user.input.wait'
  | 'sdk.skill.operation'
  | 'sdk.memory.operation'
  | 'sdk.credential.operation'
  | 'sdk.integration.request'

export interface OpenObservationSpanInput {
  readonly name: ObservationSpanName
  readonly runId: string
  readonly parent?: CorrelationContext
  readonly correlation?: Omit<Partial<CorrelationContext>, 'traceId' | 'spanId' | 'parentSpanId' | 'runId'>
  readonly startedAt: string
  readonly monotonicMs: number
}

export interface ObservationSpan {
  readonly correlation: CorrelationContext
  readonly traceparent: string
  end(status: OperationStatus, endedAt: string, monotonicMs: number): void
}

export interface ObservationPort {
  readonly mode: DeliveryMode
  openSpan(input: OpenObservationSpanInput): ObservationSpan
  capture(event: ObservationEvent): CaptureReceipt
  checkpoint?(event: ObservationEvent, signal?: AbortSignal): Promise<CaptureReceipt>
}

export interface ObservationDeliverySummary {
  readonly mode: DeliveryMode
  readonly requiredBoundary: ObservationBoundary
  readonly reachedBoundary: ObservationBoundary
  readonly complete: boolean
  readonly acceptedCritical: number
  readonly rejectedCritical: number
  readonly pendingCritical: number
  readonly lastFailure?: SafeErrorRecord
}

export function createCoreSpan(input: OpenObservationSpanInput): ObservationSpan {
  const correlation = freezeCorrelation({
    traceId: input.parent?.traceId ?? createTraceId(),
    spanId: createSpanId(),
    parentSpanId: input.parent?.spanId ?? null,
    runId: input.runId,
    ...input.correlation,
  })
  let ended = false
  return Object.freeze({
    correlation,
    traceparent: traceparent(correlation),
    end(_status: OperationStatus, _endedAt: string, _monotonicMs: number): void {
      if (ended) return
      ended = true
    },
  })
}

interface ObservationSpanSnapshot extends ObservationSpan {
  readonly end: ObservationSpan['end']
}

function traceparentMatchesCorrelation(value: unknown, correlation: CorrelationContext): value is string {
  if (typeof value !== 'string') return false
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value)
  return match?.[1] === correlation.traceId && match[2] === correlation.spanId
}

const OPTIONAL_CORRELATION_KEYS = [
  'conversationId',
  'turnId',
  'modelCallId',
  'attemptId',
  'toolCallId',
  'providerRequestId',
  'sessionId',
] as const

/** Copy an untrusted backend span so its getters or later mutations cannot affect events. */
export function snapshotObservationSpan(value: unknown): ObservationSpanSnapshot | undefined {
  try {
    if (typeof value !== 'object' || value === null) return undefined
    const correlationValue = Reflect.get(value, 'correlation')
    if (typeof correlationValue !== 'object' || correlationValue === null) return undefined
    const traceId = Reflect.get(correlationValue, 'traceId')
    const spanId = Reflect.get(correlationValue, 'spanId')
    const parentSpanId = Reflect.get(correlationValue, 'parentSpanId')
    const runId = Reflect.get(correlationValue, 'runId')
    if (!isTraceId(traceId) || !isSpanId(spanId)
      || (parentSpanId !== null && !isSpanId(parentSpanId))
      || typeof runId !== 'string' || runId.length === 0) return undefined
    const optional: Partial<Record<typeof OPTIONAL_CORRELATION_KEYS[number], string>> = {}
    for (const key of OPTIONAL_CORRELATION_KEYS) {
      const field = Reflect.get(correlationValue, key)
      if (field === undefined) continue
      if (typeof field !== 'string' || field.length === 0) return undefined
      optional[key] = field
    }
    const correlation = freezeCorrelation({ traceId, spanId, parentSpanId, runId, ...optional })
    const backendTraceparent = Reflect.get(value, 'traceparent')
    const end = Reflect.get(value, 'end')
    if (!traceparentMatchesCorrelation(backendTraceparent, correlation) || typeof end !== 'function') return undefined
    return Object.freeze({
      correlation,
      traceparent: backendTraceparent,
      end: (status: OperationStatus, endedAt: string, monotonicMs: number) => {
        Reflect.apply(end, value, [status, endedAt, monotonicMs])
      },
    })
  } catch {
    return undefined
  }
}

export function validObservationSpan(value: unknown): value is ObservationSpan {
  return snapshotObservationSpan(value) !== undefined
}

export function disabledDeliverySummary(): ObservationDeliverySummary {
  return deepFreeze({
    mode: 'operational',
    requiredBoundary: 'none',
    reachedBoundary: 'none',
    complete: true,
    acceptedCritical: 0,
    rejectedCritical: 0,
    pendingCritical: 0,
  })
}

export const NOOP_OBSERVATION_PORT: ObservationPort = Object.freeze({
  mode: 'operational' as const,
  openSpan: createCoreSpan,
  capture(event: ObservationEvent): CaptureReceipt {
    return Object.freeze({ eventId: event.eventId, status: 'disabled', durable: false, boundary: 'none' })
  },
  checkpoint(event: ObservationEvent): Promise<CaptureReceipt> {
    return Promise.resolve(Object.freeze({ eventId: event.eventId, status: 'disabled', durable: false, boundary: 'none' }))
  },
})
