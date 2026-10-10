import { deepFreeze } from '../primitives/freeze.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import { createObservationRunScope, isSpanId, isTraceId, type CorrelationContext,
  type ObservationRunScope } from '../observation/context.ts'
import { safeErrorRecord, type OperationStatus, type SafeErrorRecord } from '../observation/event.ts'
import { createCoreSpan, disabledDeliverySummary, NOOP_OBSERVATION_PORT, snapshotObservationSpan,
  type CaptureReceipt, type DeliveryMode, type ObservationBoundary, type ObservationDeliverySummary,
  type ObservationPort, type ObservationSpan } from '../observation/port.ts'
import { OBSERVATION_ERROR_CODES } from '../observation/report.ts'

const scopes = new WeakMap<object, Map<string, ObservationRunScope>>()

export function nowMonotonic(): number {
  return globalThis.performance?.now() ?? Date.now()
}

export function scopeFor(key: object, runId: string, supplied?: ObservationRunScope): ObservationRunScope {
  if (supplied !== undefined) return supplied
  let runs = scopes.get(key)
  if (!runs) {
    runs = new Map()
    scopes.set(key, runs)
  }
  let scope = runs.get(runId)
  if (!scope) {
    scope = createObservationRunScope()
    runs.set(runId, scope)
  }
  return scope
}

/**
 * Carry the failure's own message through to the report untouched.
 *
 * A provider's rejection often names the exact reason (an unsupported
 * `reasoning.effort` value, a missing field, a quota message) that the
 * generic classification code cannot express — an agent or its caller reading
 * `report.error.message` needs that, not a pointer back to the code. Content
 * redaction belongs to the observation exporters (`observability.content` /
 * `redactors`), never to what this report itself carries.
 */
export function safeFailureFromFinish(
  chunk: Extract<StreamChunk, { type: 'finish' }>,
  isRetryable?: (code: string) => boolean,
): SafeErrorRecord | undefined {
  if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') return undefined
  const failure = chunk.reason.failure
  return Object.freeze({
    type: 'ModelError',
    message: failure.message,
    code: failure.code,
    ...isRetryable === undefined ? {} : { retryable: isRetryable(failure.code) },
    ...failure.status === undefined ? {} : { status: failure.status },
  })
}

function boundaryRank(boundary: ObservationBoundary): number {
  if (boundary === 'remote-acknowledged') return 2
  if (boundary === 'local-durable') return 1
  return 0
}

export interface DeliveryTracker {
  accepted: number
  rejected: number
  pending: number
  reached: ObservationBoundary
  lastFailure?: SafeErrorRecord
}

export function applyReceipt(tracker: DeliveryTracker, receipt: CaptureReceipt, critical: boolean): void {
  if (!critical) return
  if (receipt.status === 'accepted') tracker.accepted += 1
  else tracker.rejected += 1
  if (receipt.status === 'accepted'
    && boundaryRank(receipt.boundary) > boundaryRank(tracker.reached)) tracker.reached = receipt.boundary
}

export function deliverySummary(port: ObservationPort, mode: DeliveryMode,
  tracker: DeliveryTracker): ObservationDeliverySummary {
  if (port === NOOP_OBSERVATION_PORT) return disabledDeliverySummary()
  const requiredBoundary = requiredDeliveryBoundary(mode, tracker.reached)
  return deepFreeze({
    mode,
    requiredBoundary,
    reachedBoundary: tracker.reached,
    complete: tracker.rejected === 0 && tracker.pending === 0
      && boundaryRank(tracker.reached) >= boundaryRank(requiredBoundary),
    acceptedCritical: tracker.accepted,
    rejectedCritical: tracker.rejected,
    pendingCritical: tracker.pending,
    ...tracker.lastFailure === undefined ? {} : { lastFailure: tracker.lastFailure },
  })
}

export function validParent(value: Partial<CorrelationContext> | undefined): CorrelationContext | undefined {
  if (!value || !isTraceId(value.traceId) || !isSpanId(value.spanId)
    || typeof value.runId !== 'string' || value.runId.length === 0) return undefined
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    parentSpanId: value.parentSpanId === null || isSpanId(value.parentSpanId) ? value.parentSpanId : null,
    runId: value.runId,
    ...parentRunMetadata(value),
    ...parentRequestMetadata(value),
  }
}

export function openContainedSpan(port: ObservationPort, input: Parameters<ObservationPort['openSpan']>[0],
  tracker: DeliveryTracker): ObservationSpan {
  try {
    const span = snapshotObservationSpan(port.openSpan(input))
    if (span && span.correlation.runId === input.runId
      && span.correlation.modelCallId === input.correlation?.modelCallId) {
      let ended = false
      return Object.freeze({
        correlation: span.correlation,
        traceparent: span.traceparent,
        end(status: OperationStatus, endedAt: string, monotonicMs: number): void {
          if (ended) return
          ended = true
          try { span.end(status, endedAt, monotonicMs) } catch (error) { tracker.lastFailure = safeErrorRecord(error) }
        },
      })
    }
    tracker.lastFailure = Object.freeze({
      type: 'ObservationSpanError',
      message: 'observation backend returned an invalid or mismatched span identity',
      code: OBSERVATION_ERROR_CODES.OTEL_PROVIDER_UNCONFIGURED,
    })
  } catch (error) {
    tracker.lastFailure = safeErrorRecord(error)
  }
  return createCoreSpan(input)
}

function requiredDeliveryBoundary(mode: DeliveryMode, reached: ObservationBoundary): ObservationBoundary {
  if (mode === 'operational') return 'none'
  return boundaryRank(reached) > 0 ? reached : 'local-durable'
}

function parentRunMetadata(value: Partial<CorrelationContext>) {
  return {
    ...value.conversationId === undefined ? {} : { conversationId: value.conversationId },
    ...value.turnId === undefined ? {} : { turnId: value.turnId },
    ...value.modelCallId === undefined ? {} : { modelCallId: value.modelCallId },
    ...value.attemptId === undefined ? {} : { attemptId: value.attemptId },

  }
}

function parentRequestMetadata(value: Partial<CorrelationContext>) {
  return {
    ...value.toolCallId === undefined ? {} : { toolCallId: value.toolCallId },
    ...value.providerRequestId === undefined ? {} : { providerRequestId: value.providerRequestId },
    ...value.sessionId === undefined ? {} : { sessionId: value.sessionId },
  }
}
