import { normalizeModelFailure } from '../../errors/failure.ts'
import { createObservationRunScope, createOperationId, isSpanId, isTraceId,
  type CorrelationContext, type ObservationRunScope } from '../../observation/context.ts'
import type {
  ObservationEvent, ObservationEventName, ObservationResource, SafeErrorRecord,
} from '../../observation/event.ts'
import { createCoreSpan, NOOP_OBSERVATION_PORT, snapshotObservationSpan,
  type ObservationPort, type ObservationSpan, type OpenObservationSpanInput } from '../../observation/port.ts'
import { deepFreeze } from '../../primitives/freeze.ts'
import type { JsonObject } from '../../primitives/json.ts'
import { SDK_VERSION } from '../../primitives/version.ts'
import type { EmbeddingObservationDependencies } from './observation-types.ts'

/** Resource identity used when neither the caller nor the runtime supplied one. */
const ANONYMOUS_RESOURCE: ObservationResource = Object.freeze({
  sdkName: 'ai-agent-sdk' as const,
  sdkVersion: SDK_VERSION,
  runtime: 'unknown' as const,
})

/**
 * Reduce any failure to what a trace record may carry.
 *
 * The core-side mirror of the transport's `safeProviderFailure`: a stable code
 * and, when known, an HTTP status. Provider prose is dropped rather than
 * truncated, because a response body is exactly the place a credential or a
 * fragment of the caller's document tends to be echoed back.
 */
export function safeEmbeddingFailure(error: unknown): SafeErrorRecord {
  const failure = normalizeModelFailure(error)
  return Object.freeze({
    type: 'EmbeddingError',
    message: 'embedding operation failed; inspect the stable code and request ID',
    code: failure.code,
    ...(failure.status === undefined ? {} : { status: failure.status }),
  })
}

/** A caller correlation usable as a span parent, or nothing. */
export function validParent(value: Partial<CorrelationContext> | undefined): CorrelationContext | undefined {
  if (value === undefined || !isTraceId(value.traceId) || !isSpanId(value.spanId)
    || typeof value.runId !== 'string' || value.runId.length === 0) return undefined
  return Object.freeze({
    traceId: value.traceId,
    spanId: value.spanId,
    parentSpanId: validParentSpan(value),
    runId: value.runId,
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
  })
}

/**
 * Open a span through the backend, falling back to a core span.
 *
 * The backend's span is snapshotted rather than used directly, and a span whose
 * identity does not match what was asked for is discarded: a trace with the
 * wrong parent is worse than a trace assembled locally.
 */
export function openSpanSafely(port: ObservationPort, input: OpenObservationSpanInput): ObservationSpan {
  try {
    const span = snapshotObservationSpan(port.openSpan(input))
    if (span !== undefined && span.correlation.runId === input.runId) return span
  } catch {
    // A tracer that throws is a degraded trace, never a failed embedding call.
  }
  return createCoreSpan(input)
}

/** Everything the three record levels share for the lifetime of one call. */
export interface ObservationChannel {
  readonly port: ObservationPort
  readonly resource: ObservationResource
  readonly scope: ObservationRunScope
  readonly runId: string
  capture(name: ObservationEventName, phase: 'start' | 'end', correlation: CorrelationContext, data: JsonObject): void
}

export function createChannel(dependencies: EmbeddingObservationDependencies): ObservationChannel {
  const port = dependencies.context?.observation ?? dependencies.observation ?? NOOP_OBSERVATION_PORT
  const resource = channelResource(dependencies)
  const scope = dependencies.context?.scope ?? createObservationRunScope()
  const suppliedRunId = dependencies.context?.correlation?.runId
  const runId = typeof suppliedRunId === 'string' && suppliedRunId.length > 0
    ? suppliedRunId
    : createOperationId()
  return {
    port,
    resource,
    scope,
    runId,
    capture(name, phase, correlation, data): void {
      try {
        const event: ObservationEvent = deepFreeze({
          schemaVersion: 1,
          eventId: createOperationId(),
          sequence: scope.nextSequence(),
          name,
          phase,
          occurredAt: new Date().toISOString(),
          monotonicMs: scope.monotonicMs(),
          priority: 'critical',
          resource,
          correlation,
          data,
        })
        port.capture(event)
      } catch {
        // Observation delivery is best-effort. The receipt is not inspected here
        // because an embedding call publishes no delivery summary to reconcile it
        // against, unlike a `ModelCallReport`.
      }
    },
  }
}


function validParentSpan(value: Partial<CorrelationContext>): CorrelationContext['parentSpanId'] {
  return value.parentSpanId === null || isSpanId(value.parentSpanId) ? value.parentSpanId : null
}

function channelResource(dependencies: EmbeddingObservationDependencies): ObservationResource {
  return dependencies.context?.resource ?? dependencies.resource ?? ANONYMOUS_RESOURCE
}
