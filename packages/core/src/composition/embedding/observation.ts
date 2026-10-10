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

import { createOperationId, type CorrelationContext } from '../../observation/context.ts'
import type { OperationStatus } from '../../observation/event.ts'
import type { ObservationSpan } from '../../observation/port.ts'
import type { ModelInvocationContext } from '../../observation/report.ts'
import { createChannel, openSpanSafely, safeEmbeddingFailure, validParent,
  type ObservationChannel } from './observation-channel.ts'
import { createAttemptStarter } from './observation-attempt.ts'
import type { EmbeddingCallObservation, EmbeddingCallObservationFacts, EmbeddingCallObservationTerminal,
  EmbeddingBatchObservation, EmbeddingBatchObservationFacts, EmbeddingObservationDependencies,
} from './observation-types.ts'
export type * from './observation-types.ts'
export { safeEmbeddingFailure } from './observation-channel.ts'

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
  const contextFor = createContextFactory(channel, dependencies, nextAttemptNumber)

  const callContext = contextFor(span.correlation)
  let ended = false

  return Object.freeze<EmbeddingCallObservation>({
    context: callContext,

    beginBatch: batch => beginBatchObservation(batch, channel, { span, callId }, contextFor),

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

function createContextFactory(
  channel: ObservationChannel, dependencies: EmbeddingObservationDependencies, nextAttemptNumber: () => number,
) {
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

  return contextFor
}

function beginBatchObservation(
  batch: EmbeddingBatchObservationFacts, channel: ObservationChannel,
  call: { span: ObservationSpan; callId: string },
  contextFor: (correlation: CorrelationContext) => ModelInvocationContext,
): EmbeddingBatchObservation {
  const { span, callId } = call
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
}
