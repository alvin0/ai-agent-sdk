import { EmbeddingBatchRetryDriver } from './retry-dispatch.ts'
import { cancellableDelay } from './retry-support.ts'
/**
 * The ONE retry layer for embedding.
 *
 * `Embedding_Runtime` owns retry; an `Embedding_Adapter` performs exactly one
 * `Provider_Attempt` per `embedBatch()` call and never retries inside
 * (Requirement 4.3). Keeping retry here is what makes a `Provider_Attempt`
 * countable: the number of attempts a caller is billed for equals the number of
 * times this file called the adapter.
 *
 * Four facts drive every branch below:
 *
 * 1. **Only unsuccessful batches are retried.** A batch that reached
 *    `succeeded` is removed from every later retry pass of the same
 *    `Logical_Call` — its vectors already exist, and re-sending it would be a
 *    second charge for a result we hold (Requirement 4.7). The ledger enforces
 *    this structurally: a terminal state is never re-entered.
 * 2. **Dispatch state comes from the transport, it is not re-derived.**
 *    `Http_Transport` sets `dispatchState = 'unknown'` immediately before
 *    `fetch` and only raises it to `'sent'` once a response exists, so this file
 *    reads the value the transport reported through `attempt.end` instead of
 *    guessing from the shape of the error. When nothing reported a state, the
 *    record stays `'unknown'`: only the transport is in a position to claim
 *    `'not-sent'`, and a timeout in particular is never that (Requirement 4.8).
 * 3. **No fallback model.** A failure of the primary model propagates to the
 *    caller. Fallback is only ever configured within a group sharing one
 *    `compatibilityIdentity`, and that condition is checked when the handle is
 *    built, not after a failure has happened (Requirements 6.6, 6.7).
 * 4. **Order is not this file's business.** Vectors are handed back per batch and
 *    the caller writes them at `item.index`, so retries and out-of-order
 *    settlement cannot disturb output order (Requirement 4.6).
 *
 * Concurrency lives in `limiter.ts`; this file drives one batch at a time and is
 * composed underneath it.
 *
 * @module ai-agent-sdk/core/composition/embedding/retry
 */

import {
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
} from '../../contract/retry-policy.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../embedding/request.ts'
import type { EmbeddingBatchResult, EmbeddingVector, EmbeddingWarning } from '../../embedding/result.ts'
import type {
  ModelInvocationContext,
} from '../../observation/report.ts'
import type { DispatchState } from '../../observation/usage.ts'

/**
 * Lifecycle of one `Physical_Batch` inside a single `Logical_Call`.
 *
 * `succeeded` and `failed` are terminal. That is the whole mechanism behind
 * Requirement 4.7: retry only ever considers a batch that is not yet terminal.
 */
export type BatchState =
  | { readonly phase: 'pending' }
  | { readonly phase: 'in-flight'; readonly attempt: number }
  | { readonly phase: 'succeeded'; readonly vectors: readonly EmbeddingVector[] }
  | {
    readonly phase: 'failed'
    readonly error: EmbeddingError
    readonly retryable: boolean
    /** As reported by the transport; `'unknown'` whenever nothing reported. */
    readonly dispatch: DispatchState
  }

/** One retry that is about to be waited out, for logging and metrics. */
export interface EmbeddingRetryAttempt {
  readonly provider: string
  readonly model: string
  /** Plan coordinate of the batch being retried. */
  readonly batchIndex: number
  /** 1-based retry number. */
  readonly attempt: number
  /** Retry ceiling, or `undefined` under an `always` policy. */
  readonly maxRetries: number | undefined
  /** Stable code of the failure being recovered from. */
  readonly failureCode: string
  /** Dispatch state the transport reported for the failed attempt. */
  readonly dispatch: DispatchState
  readonly delayMs: number
}

/** What one `Provider_Attempt` on a batch left behind. */
export interface EmbeddingAttemptRecord {
  /** 1-based attempt number within this batch. */
  readonly attempt: number
  readonly outcome: 'success' | 'failure'
  /** From the transport, never re-derived (Requirement 4.8). */
  readonly dispatch: DispatchState
  /** Stable failure code, absent on success. */
  readonly failureCode?: string
}

/** Everything a `Logical_Call` needs to know about one settled batch. */
export interface EmbeddingBatchOutcome {
  readonly batchIndex: number
  /** Input indexes this batch carried, in `Logical_Call` numbering. */
  readonly itemIndexes: readonly number[]
  /** Terminal state: `succeeded` or `failed`. */
  readonly state: BatchState
  /** `Provider_Attempt`s spent, retries included (Requirement 16.6). */
  readonly attempts: number
  /** One record per adapter call, in order. */
  readonly attemptRecords: readonly EmbeddingAttemptRecord[]
  /**
   * Raw provider usage evidence from the attempt that settled the batch.
   *
   * `unknown` on purpose: proving it is a usage shape belongs to
   * `validateEmbeddingUsage`, and absence must never become a zero.
   */
  readonly usage?: unknown
  readonly providerRequestId?: string
  readonly warnings: readonly EmbeddingWarning[]
}

/** Dispatch surface of a `Prepared_Embedding_Call`; the ledger needs nothing else. */
export interface EmbeddingBatchDispatcher {
  embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult>
}

/** Knobs for {@link createEmbeddingRetryLedger}. */
export interface EmbeddingRetryOptions {
  /** Route policy; omission takes the shared SDK defaults. */
  readonly policy?: ResolvedRetryPolicy
  /** Sample in `[0, 1)` for jitter; injectable so tests can be deterministic. */
  readonly random?: () => number
  /** Caller signal or runtime `close()`; an abort is never a transient fault. */
  readonly signal?: AbortSignal
  /** Invocation context; wrapped so transport-reported dispatch states are observed. */
  readonly context?: ModelInvocationContext
  /** Observe each scheduled retry. Failures in the observer are swallowed. */
  readonly onRetry?: (attempt: EmbeddingRetryAttempt) => void
  /** Sleep hook; resolves `false` when the signal fired first. Injectable for tests. */
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>
}

/**
 * Per-`Logical_Call` retry driver and state ledger.
 *
 * One ledger per `Logical_Call`, shared across every batch of that call, which
 * is what lets it guarantee that a `succeeded` batch is never dispatched again.
 */
export interface EmbeddingRetryLedger {
  /**
   * Dispatch one `Physical_Batch` and retry it until it settles.
   *
   * Resolves with a terminal outcome instead of throwing, because only the
   * caller knows whether a failed batch should abandon the whole call or leave
   * the batches that already succeeded intact. There is no fallback model: a
   * failure here is the failure the caller sees.
   *
   * @param context - overrides the ledger's context for this batch only. One
   * ledger spans the whole `Logical_Call` while observation is per-batch, so this
   * is how an attempt gets parented under the batch that provoked it. The
   * override is wrapped for dispatch-state observation exactly like the
   * ledger-wide context, so nothing about Requirement 4.8 changes.
   */
  dispatch(
    batchIndex: number,
    request: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchOutcome>
  /** Current state of one batch; `pending` for a batch never dispatched. */
  stateOf(batchIndex: number): BatchState
  /** Immutable view of every batch state seen so far. */
  states(): ReadonlyMap<number, BatchState>
}

const PENDING: BatchState = Object.freeze({ phase: 'pending' as const })

/**
 * Create the retry ledger for one `Logical_Call`.
 *
 * An `always` policy without a signal is rejected here rather than at the first
 * failure: unbounded retry is bounded only by cancellation, so a call that
 * cannot be cancelled would never terminate.
 */
export function createEmbeddingRetryLedger(
  dispatcher: EmbeddingBatchDispatcher,
  options: EmbeddingRetryOptions = {},
): EmbeddingRetryLedger {
  const policy = options.policy ?? resolveRetryPolicy(undefined, 'embedding.retryPolicy')
  if (policy.mode === 'always' && options.signal === undefined) {
    throw new EmbeddingError(
      'an always retry policy requires an AbortSignal',
      EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
    )
  }
  const random = options.random ?? Math.random
  const sleep = options.sleep ?? cancellableDelay
  const states = new Map<number, BatchState>()

  /**
   * Whether either signal has fired.
   *
   * A function rather than an inline check so the answer is re-read after every
   * `await`: a signal that aborts while a request is in flight is precisely the
   * case that matters.
   */
  const cancelled = (request: EmbeddingBatchRequest): boolean =>
    options.signal?.aborted === true || request.signal?.aborted === true

  const abortedOutcome = (
    batchIndex: number,
    request: EmbeddingBatchRequest,
    records: readonly EmbeddingAttemptRecord[],
    details: { error: EmbeddingError; dispatch: DispatchState },
  ): EmbeddingBatchOutcome => {
    const { error, dispatch } = details
    const state: BatchState = Object.freeze({
      phase: 'failed' as const,
      error,
      // An abort is the caller's decision, so it is terminal by definition.
      retryable: false,
      dispatch,
    })
    states.set(batchIndex, state)
    return Object.freeze({
      batchIndex,
      itemIndexes: Object.freeze(request.items.map(item => item.index)),
      state,
      attempts: records.length,
      attemptRecords: Object.freeze([...records]),
      warnings: Object.freeze([]),
    })
  }

  const driver = new EmbeddingBatchRetryDriver({ dispatcher, options, policy, random, sleep, states,
    cancelled, abortedOutcome })

  return {
    stateOf(batchIndex: number): BatchState {
      return states.get(batchIndex) ?? PENDING
    },

    states(): ReadonlyMap<number, BatchState> {
      return new Map(states)
    },

    dispatch: (batchIndex, request, context) => driver.dispatch(batchIndex, request, context),
  }
}
