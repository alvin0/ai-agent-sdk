/**
 * Three-level observation for one embedding `Logical_Call`.
 *
 * The three levels of the conceptual model each get their own record, because a
 * cost question ("why did this call cost that much?") cannot be answered from a
 * single flat number (Requirement 16.1):
 *
 * ```text
 * sdk.embedding.call     route, model, purpose, itemCount, spaceId,
 *                        cacheHits, providerAttempts
 *   └─ sdk.embedding.batch   itemCount, byteCount, estimatedTokens, dimensions
 *        └─ sdk.provider.attempt   dispatchState, httpStatus,
 *                                  providerRequestId, reported usage
 * ```
 *
 * The attempt level is NOT new machinery. It is the same
 * `context.startProviderAttempt` / `attempt.end` pair the generation path uses,
 * so an embedding retry shows up in the same ledger, with the same fields, as a
 * generation retry (Requirement 16.6). This module only supplies that pair when
 * the caller's context does not already have one, and parents the attempt under
 * the `Physical_Batch` that provoked it. A context that already performs attempt
 * accounting is forwarded untouched — two ledgers counting the same dispatch
 * would double-count the cost.
 *
 * What deliberately never reaches a record:
 *
 * - **Raw input content.** A batch is described by `itemCount`, `byteCount`,
 *   `estimatedTokens` and `dimensions`. There is no field carrying text, and no
 *   code path that could put one there (Requirement 16.4).
 * - **Raw vector values.** A vector is a lossy but real reconstruction of the
 *   input, so it is treated as content too. The call record carries the
 *   `Space_Id` the vectors live in, never an element of one.
 * - **Credentials and provider prose.** Every failure is reduced by
 *   {@link safeEmbeddingFailure} to a stable code and an HTTP status, mirroring
 *   `safeProviderFailure` in the transport. Headers never enter `packages/core`
 *   at all: `Http_Transport` applies `redactHeaders` before anything it reports
 *   crosses into `attempt.end` (Requirement 16.5).
 *
 * Observation is best-effort throughout. A backend that throws, returns a
 * mismatched span, or rejects an event degrades the trace and never the call:
 * an embedding request does not fail because a tracer did.
 *
 * @module ai-agent-sdk/core/composition/embedding/observation
 */

import type { EmbeddingSpaceId } from '../../embedding/profile.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import { normalizeModelFailure } from '../../errors/failure.ts'
import {
  createObservationRunScope,
  createOperationId,
  isSpanId,
  isTraceId,
  type CorrelationContext,
  type ObservationRunScope,
} from '../../observation/context.ts'
import type {
  ObservationEvent,
  ObservationEventName,
  ObservationResource,
  OperationStatus,
  SafeErrorRecord,
} from '../../observation/event.ts'
import {
  createCoreSpan,
  NOOP_OBSERVATION_PORT,
  snapshotObservationSpan,
  type ObservationPort,
  type ObservationSpan,
  type OpenObservationSpanInput,
} from '../../observation/port.ts'
import type {
  EndProviderAttemptInput,
  ModelInvocationContext,
  ProviderAttemptHandle,
  StartProviderAttemptInput,
} from '../../observation/report.ts'
import {
  validateUsageCounters,
  type AttemptUsageReport,
  type UsageCoverage,
} from '../../observation/usage.ts'
import { deepFreeze } from '../../primitives/freeze.ts'
import type { JsonObject } from '../../primitives/json.ts'
import { SDK_VERSION } from '../../primitives/version.ts'

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

/** Safe facts known about one `Logical_Call` before it is dispatched. */
export interface EmbeddingCallObservationFacts {
  /** Route the handle was created for. */
  readonly route: string
  readonly model: string
  readonly purpose: EmbeddingPurpose
  /** Inputs of the `Logical_Call`, cache hits included. */
  readonly itemCount: number
}

/** Safe facts describing one `Physical_Batch`; none of them is content. */
export interface EmbeddingBatchObservationFacts {
  /** Plan coordinate of the batch, in input order. */
  readonly batchIndex: number
  readonly itemCount: number
  /** UTF-8 size of the batch's text, as measured by the planner. */
  readonly byteCount: number
  readonly estimatedTokens: number
  /** Requested output dimensions, when the caller asked for a specific width. */
  readonly dimensions?: number
}

/** How one `Logical_Call` ended, in numbers only. */
export interface EmbeddingCallObservationTerminal {
  readonly status: OperationStatus
  /** Space the produced vectors live in; absent when the call never got that far. */
  readonly spaceId?: EmbeddingSpaceId
  /** Inputs served from cache, so a cache-shaped cost drop is visible. */
  readonly cacheHits: number
  /** `Provider_Attempt`s spent, retries included (Requirement 16.6). */
  readonly providerAttempts: number
  readonly error?: unknown
}

/** One `Physical_Batch` record, open until {@link end} is called. */
export interface EmbeddingBatchObservation {
  /**
   * Context to dispatch this batch with.
   *
   * Attempts started through it are parented under this batch, so retries of one
   * batch stay distinguishable from attempts on its siblings.
   */
  readonly context: ModelInvocationContext | undefined
  /** Closes the batch record. Repeat calls are ignored. */
  end(status: OperationStatus, error?: unknown): void
}

/** One `Logical_Call` record and the factory for its batch records. */
export interface EmbeddingCallObservation {
  /** Context for the call-level work: snapshot capture and cache lookup. */
  readonly context: ModelInvocationContext | undefined
  beginBatch(facts: EmbeddingBatchObservationFacts): EmbeddingBatchObservation
  /** Closes the call record. Repeat calls are ignored. */
  end(terminal: EmbeddingCallObservationTerminal): void
}

/** Where the records go, when anything is listening. */
export interface EmbeddingObservationDependencies {
  /** Caller context; its port, resource, correlation and scope win when present. */
  readonly context?: ModelInvocationContext
  /** Runtime default port, used when the context does not carry one. */
  readonly observation?: ObservationPort
  /** Runtime resource identity, used when the context does not carry one. */
  readonly resource?: ObservationResource
}

/** A caller correlation usable as a span parent, or nothing. */
function validParent(value: Partial<CorrelationContext> | undefined): CorrelationContext | undefined {
  if (value === undefined || !isTraceId(value.traceId) || !isSpanId(value.spanId)
    || typeof value.runId !== 'string' || value.runId.length === 0) return undefined
  return Object.freeze({
    traceId: value.traceId,
    spanId: value.spanId,
    parentSpanId: value.parentSpanId === null || isSpanId(value.parentSpanId) ? value.parentSpanId : null,
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
function openSpanSafely(port: ObservationPort, input: OpenObservationSpanInput): ObservationSpan {
  try {
    const span = snapshotObservationSpan(port.openSpan(input))
    if (span !== undefined && span.correlation.runId === input.runId) return span
  } catch {
    // A tracer that throws is a degraded trace, never a failed embedding call.
  }
  return createCoreSpan(input)
}

/** Everything the three record levels share for the lifetime of one call. */
interface ObservationChannel {
  readonly port: ObservationPort
  readonly resource: ObservationResource
  readonly scope: ObservationRunScope
  readonly runId: string
  capture(name: ObservationEventName, phase: 'start' | 'end', correlation: CorrelationContext, data: JsonObject): void
}

function createChannel(dependencies: EmbeddingObservationDependencies): ObservationChannel {
  const port = dependencies.context?.observation ?? dependencies.observation ?? NOOP_OBSERVATION_PORT
  const resource = dependencies.context?.resource ?? dependencies.resource ?? ANONYMOUS_RESOURCE
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

/**
 * Attempt accounting for one `Physical_Batch`.
 *
 * Produces the same `sdk.provider.attempt` start/end pair the generation ledger
 * produces, so an embedding retry is countable with the same tooling. Usage is
 * passed through `validateUsageCounters` rather than trusted: a malformed
 * provider report becomes a coverage downgrade, never a zero.
 */
function createAttemptStarter(
  channel: ObservationChannel,
  parent: CorrelationContext,
  nextAttemptNumber: () => number,
): (input: StartProviderAttemptInput, signal?: AbortSignal) => Promise<ProviderAttemptHandle> {
  return async (input: StartProviderAttemptInput): Promise<ProviderAttemptHandle> => {
    const attemptNumber = nextAttemptNumber()
    const attemptId = createOperationId()
    const startedAt = new Date().toISOString()
    const startedMonotonic = channel.scope.monotonicMs()
    const span = openSpanSafely(channel.port, {
      name: 'sdk.provider.attempt',
      runId: channel.runId,
      parent,
      correlation: {
        attemptId,
        ...(parent.modelCallId === undefined ? {} : { modelCallId: parent.modelCallId }),
      },
      startedAt,
      monotonicMs: startedMonotonic,
    })
    channel.capture('sdk.provider.attempt', 'start', span.correlation, {
      provider: input.provider,
      model: input.model,
      attemptNumber,
      method: input.method,
      // Origin only: a path or query string can carry identifiers the caller
      // considers content, and `StartProviderAttemptInput` already forbids them.
      origin: input.origin,
      dispatchState: 'not-sent',
    })

    let report: AttemptUsageReport | undefined
    const end = (terminal: EndProviderAttemptInput): AttemptUsageReport => {
      // Idempotent: `attempt.end` is called exactly once per attempt on every
      // exit path of the transport, and a second call must not invent a record.
      if (report !== undefined) return report
      const endedAt = new Date().toISOString()
      const endedMonotonic = channel.scope.monotonicMs()
      const validated = validateUsageCounters(terminal.reported, true)
      const coverage: UsageCoverage = terminal.dispatchState === 'not-sent'
        ? 'not-applicable'
        : validated.complete
          ? 'complete'
          : Object.keys(validated.reported).length > 0 ? 'partial' : 'missing'
      const durationMs = Math.max(0, endedMonotonic - startedMonotonic)
      span.end(terminal.status, endedAt, endedMonotonic)
      const correlation = terminal.providerRequestId === undefined
        ? span.correlation
        : deepFreeze({ ...span.correlation, providerRequestId: terminal.providerRequestId })
      channel.capture('sdk.provider.attempt', 'end', correlation, {
        status: terminal.status,
        durationMs,
        origin: input.origin,
        // Reported by the transport, never re-derived here (Requirement 4.8).
        dispatchState: terminal.dispatchState,
        coverage,
        reported: { ...validated.reported },
        ...(terminal.httpStatus === undefined ? {} : { httpStatus: terminal.httpStatus }),
        ...(terminal.providerRequestId === undefined ? {} : { providerRequestId: terminal.providerRequestId }),
        ...(terminal.error === undefined ? {} : { error: { ...terminal.error } }),
      })
      report = deepFreeze({
        attemptId,
        spanId: span.correlation.spanId,
        attemptNumber,
        status: terminal.status,
        startedAt,
        endedAt,
        durationMs,
        dispatchState: terminal.dispatchState,
        coverage,
        reported: validated.reported,
        origin: input.origin,
        ...(terminal.httpStatus === undefined ? {} : { httpStatus: terminal.httpStatus }),
        ...(terminal.providerRequestId === undefined ? {} : { providerRequestId: terminal.providerRequestId }),
        ...(terminal.error === undefined ? {} : { error: terminal.error }),
      })
      return report
    }
    return Object.freeze({ attemptId, attemptNumber, traceparent: span.traceparent, end })
  }
}

/**
 * Open the `Logical_Call` record and hand back the factory for its batches.
 *
 * Called once per `embed()` / `embedMany()`, before the configuration snapshot is
 * taken, so a call that is rejected pre-dispatch still produces one record
 * showing zero attempts — the cheapest possible answer to "did this cost
 * anything?".
 */
export function beginEmbeddingCallObservation(
  facts: EmbeddingCallObservationFacts,
  dependencies: EmbeddingObservationDependencies = {},
): EmbeddingCallObservation {
  const channel = createChannel(dependencies)
  const callId = createOperationId()
  const parent = validParent(dependencies.context?.correlation)
  const startedAt = new Date().toISOString()
  const startedMonotonic = channel.scope.monotonicMs()
  const span = openSpanSafely(channel.port, {
    name: 'sdk.embedding.call',
    runId: channel.runId,
    ...(parent === undefined ? {} : { parent }),
    correlation: {
      // Reuses the `modelCallId` slot: an embedding call IS the provider-facing
      // logical operation of this trace, and reusing the slot keeps existing
      // correlation tooling working without widening `CorrelationContext`.
      modelCallId: callId,
      ...(parent?.conversationId === undefined ? {} : { conversationId: parent.conversationId }),
      ...(parent?.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
    },
    startedAt,
    monotonicMs: startedMonotonic,
  })
  channel.capture('sdk.embedding.call', 'start', span.correlation, {
    route: facts.route,
    model: facts.model,
    purpose: facts.purpose,
    itemCount: facts.itemCount,
  })

  // Numbered across the whole `Logical_Call`, not per batch, so the attempt
  // numbers line up with the `providerAttempts` total the result reports.
  let attemptCounter = 0
  const nextAttemptNumber = (): number => ++attemptCounter

  /**
   * Build the context handed to one dispatch level.
   *
   * A caller that already accounts for attempts keeps its own accounting: this
   * module supplies `startProviderAttempt` only when nothing else does.
   */
  const contextFor = (correlation: CorrelationContext): ModelInvocationContext => {
    const supplied = dependencies.context
    const base: ModelInvocationContext = {
      observation: channel.port,
      resource: channel.resource,
      correlation,
      scope: channel.scope,
      ...(supplied?.logger === undefined ? {} : { logger: supplied.logger }),
      ...(supplied?.declareProviderAttemptAccounting === undefined
        ? {}
        : { declareProviderAttemptAccounting: supplied.declareProviderAttemptAccounting }),
      ...(supplied?.recordProviderRetry === undefined
        ? {}
        : { recordProviderRetry: supplied.recordProviderRetry }),
    }
    return Object.freeze(supplied?.startProviderAttempt === undefined
      ? { ...base, startProviderAttempt: createAttemptStarter(channel, correlation, nextAttemptNumber) }
      : { ...base, startProviderAttempt: supplied.startProviderAttempt })
  }

  const callContext = contextFor(span.correlation)
  let ended = false

  return Object.freeze<EmbeddingCallObservation>({
    context: callContext,

    beginBatch(batch: EmbeddingBatchObservationFacts): EmbeddingBatchObservation {
      const batchStartedAt = new Date().toISOString()
      const batchStartedMonotonic = channel.scope.monotonicMs()
      const batchSpan = openSpanSafely(channel.port, {
        name: 'sdk.embedding.batch',
        runId: channel.runId,
        parent: span.correlation,
        correlation: { modelCallId: callId },
        startedAt: batchStartedAt,
        monotonicMs: batchStartedMonotonic,
      })
      // Size, not substance: four numbers that answer every cost and batching
      // question without carrying a byte of the caller's text (Requirement 16.4).
      channel.capture('sdk.embedding.batch', 'start', batchSpan.correlation, {
        batchIndex: batch.batchIndex,
        itemCount: batch.itemCount,
        byteCount: batch.byteCount,
        estimatedTokens: batch.estimatedTokens,
        ...(batch.dimensions === undefined ? {} : { dimensions: batch.dimensions }),
      })
      const batchContext = contextFor(batchSpan.correlation)
      let batchEnded = false
      return Object.freeze<EmbeddingBatchObservation>({
        context: batchContext,
        end(status: OperationStatus, error?: unknown): void {
          if (batchEnded) return
          batchEnded = true
          const endedMonotonic = channel.scope.monotonicMs()
          const endedAt = new Date().toISOString()
          batchSpan.end(status, endedAt, endedMonotonic)
          channel.capture('sdk.embedding.batch', 'end', batchSpan.correlation, {
            batchIndex: batch.batchIndex,
            status,
            durationMs: Math.max(0, endedMonotonic - batchStartedMonotonic),
            itemCount: batch.itemCount,
            ...(error === undefined ? {} : { error: { ...safeEmbeddingFailure(error) } }),
          })
        },
      })
    },

    end(terminal: EmbeddingCallObservationTerminal): void {
      if (ended) return
      ended = true
      const endedMonotonic = channel.scope.monotonicMs()
      const endedAt = new Date().toISOString()
      span.end(terminal.status, endedAt, endedMonotonic)
      channel.capture('sdk.embedding.call', 'end', span.correlation, {
        status: terminal.status,
        durationMs: Math.max(0, endedMonotonic - startedMonotonic),
        route: facts.route,
        model: facts.model,
        purpose: facts.purpose,
        itemCount: facts.itemCount,
        // The space the vectors live in, never a vector element.
        ...(terminal.spaceId === undefined ? {} : { spaceId: terminal.spaceId }),
        cacheHits: terminal.cacheHits,
        providerAttempts: terminal.providerAttempts,
        ...(terminal.error === undefined ? {} : { error: { ...safeEmbeddingFailure(terminal.error) } }),
      })
    },
  })
}
