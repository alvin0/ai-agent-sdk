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
  backoffDelayMs,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
} from '../../contract/retry-policy.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../embedding/request.ts'
import type { EmbeddingBatchResult, EmbeddingVector, EmbeddingWarning } from '../../embedding/result.ts'
import { normalizeModelFailure, type ModelFailure } from '../../errors/failure.ts'
import { MODEL_ERROR_CODES } from '../../errors/model-error.ts'
import type {
  EndProviderAttemptInput,
  ModelInvocationContext,
  ProviderAttemptHandle,
} from '../../observation/report.ts'
import type { AttemptUsageReport, DispatchState } from '../../observation/usage.ts'

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

/** Codes that mean "the caller stopped this", never "the provider wobbled". */
function isAbortCode(code: string): boolean {
  return code === MODEL_ERROR_CODES.ABORTED || code === EMBEDDING_ERROR_CODES.ABORTED
}

/**
 * Turn any thrown value into an {@link EmbeddingError} without losing its code.
 *
 * An `EmbeddingError` from the adapter passes through untouched: it already
 * carries `itemIndexes` and `limit`, and re-wrapping would drop exactly the
 * facts a caller needs to re-chunk the offending inputs. Anything else keeps its
 * normalized stable code — a rate limit stays `MODEL_RATE_LIMIT` so the retry
 * allow-list still recognises it.
 */
function asEmbeddingError(
  value: unknown,
  failure: ModelFailure,
  request: EmbeddingBatchRequest,
): EmbeddingError {
  if (value instanceof EmbeddingError) return value
  return new EmbeddingError(failure.message, failure.code, {
    cause: value,
    provider: request.provider,
    model: request.model,
    itemIndexes: request.items.map(item => item.index),
  })
}

/** Sleep, resolving early and reporting `false` if the signal aborts first. */
function cancellableDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Honour a sane provider-requested `retry-after`, else local bounded backoff. */
function delayFor(
  policy: ResolvedRetryPolicy,
  failure: ModelFailure,
  attempt: number,
  random: () => number,
): number | 'give-up' {
  const requested = failure.providerRetryAfterMs
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    if (requested <= policy.maxDelayMs) return requested
    // The provider asked for longer than this policy will wait. Under a bounded
    // policy that is a refusal: sleeping less than asked just earns another rate
    // limit. An `always` policy has nowhere to give up to.
    return policy.mode === 'always' ? backoffDelayMs(policy, attempt, random) : 'give-up'
  }
  return backoffDelayMs(policy, attempt, random)
}

/**
 * Wrap an invocation context so the dispatch state the TRANSPORT reports is
 * captured, rather than inferred from the error afterwards.
 *
 * The wrapper is transparent: it forwards `startProviderAttempt` untouched and
 * only tees the `dispatchState` passed to `attempt.end`. When a context has no
 * attempt accounting there is nothing to observe, and the record stays
 * `'unknown'` — that is the honest answer, and it is the answer Requirement 4.8
 * demands for a timeout.
 */
function observeDispatchState(
  context: ModelInvocationContext | undefined,
  sink: (state: DispatchState) => void,
): ModelInvocationContext | undefined {
  const start = context?.startProviderAttempt
  if (context === undefined || start === undefined) return context
  return {
    ...context,
    startProviderAttempt: async (input, signal): Promise<ProviderAttemptHandle> => {
      const handle = await start(input, signal)
      return {
        attemptId: handle.attemptId,
        attemptNumber: handle.attemptNumber,
        traceparent: handle.traceparent,
        end: (end: EndProviderAttemptInput): AttemptUsageReport => {
          sink(end.dispatchState)
          return handle.end(end)
        },
      }
    },
  }
}

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
    error: EmbeddingError,
    dispatch: DispatchState,
  ): EmbeddingBatchOutcome => {
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

  return {
    stateOf(batchIndex: number): BatchState {
      return states.get(batchIndex) ?? PENDING
    },

    states(): ReadonlyMap<number, BatchState> {
      return new Map(states)
    },

    async dispatch(
      batchIndex: number,
      request: EmbeddingBatchRequest,
      batchContext?: ModelInvocationContext,
    ): Promise<EmbeddingBatchOutcome> {
      const invocationContext = batchContext ?? options.context
      const existing = states.get(batchIndex)
      if (existing !== undefined && existing.phase === 'succeeded') {
        // Requirement 4.7 as an invariant rather than a convention: a batch whose
        // vectors are already held is never handed to the provider again.
        throw new EmbeddingError(
          `embedding batch ${batchIndex} already succeeded and must not be dispatched again`,
          EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
          { provider: request.provider, model: request.model },
        )
      }

      const itemIndexes = Object.freeze(request.items.map(item => item.index))
      const records: EmbeddingAttemptRecord[] = []
      let retries = 0

      for (;;) {
        const attemptNumber = records.length + 1
        // Report the abort before spending an attempt on a call already cancelled.
        if (cancelled(request)) {
          return abortedOutcome(
            batchIndex,
            request,
            records,
            new EmbeddingError(
              'embedding call aborted before dispatch',
              EMBEDDING_ERROR_CODES.ABORTED,
              { provider: request.provider, model: request.model, itemIndexes: [...itemIndexes] },
            ),
            // No adapter call was ever made on this pass, which the runtime knows
            // first-hand. Once an attempt HAS been made, the runtime stops
            // claiming anything and leaves the state `unknown`.
            records.length === 0 ? 'not-sent' : 'unknown',
          )
        }

        states.set(batchIndex, Object.freeze({ phase: 'in-flight' as const, attempt: attemptNumber }))

        // Reported by the transport through `attempt.end`; unreported stays unknown.
        let reportedDispatch: DispatchState | undefined
        const context = observeDispatchState(invocationContext, (state) => {
          reportedDispatch = state
        })

        let result: EmbeddingBatchResult
        try {
          result = await dispatcher.embedBatch(request, context)
        } catch (error: unknown) {
          const failure = normalizeModelFailure(error)
          const dispatch = reportedDispatch ?? 'unknown'
          records.push(Object.freeze({
            attempt: attemptNumber,
            outcome: 'failure' as const,
            dispatch,
            failureCode: failure.code,
          }))

          const embeddingError = asEmbeddingError(error, failure, request)
          if (cancelled(request) || isAbortCode(failure.code)) {
            return abortedOutcome(batchIndex, request, records, embeddingError, dispatch)
          }

          const eligible = policy.mode === 'always'
            || (policy.retryableCodes.includes(failure.code) && retries < policy.maxRetries)
          const delayMs = eligible ? delayFor(policy, failure, retries + 1, random) : 'give-up'
          if (!eligible || delayMs === 'give-up') {
            const state: BatchState = Object.freeze({
              phase: 'failed' as const,
              error: embeddingError,
              // `retryable` describes the failure, not the budget: a rate limit
              // that ran out of attempts is still a retryable KIND of failure,
              // and a caller deciding whether to re-run later needs that apart
              // from "this call gave up".
              retryable: policy.mode === 'always' || policy.retryableCodes.includes(failure.code),
              dispatch,
            })
            states.set(batchIndex, state)
            return Object.freeze({
              batchIndex,
              itemIndexes,
              state,
              attempts: records.length,
              attemptRecords: Object.freeze([...records]),
              warnings: Object.freeze([]),
            })
          }

          retries += 1
          invocationContext?.recordProviderRetry?.({
            nextAttemptNumber: retries + 1,
            delayMs,
            failureCode: failure.code,
          })
          try {
            options.onRetry?.({
              provider: request.provider,
              model: request.model,
              batchIndex,
              attempt: retries,
              maxRetries: policy.mode === 'normal' ? policy.maxRetries : undefined,
              failureCode: failure.code,
              dispatch,
              delayMs,
            })
          } catch {
            // Metrics and logging observers do not own request availability.
          }

          if (!await sleep(delayMs, options.signal ?? request.signal)) {
            return abortedOutcome(
              batchIndex,
              request,
              records,
              new EmbeddingError(
                'embedding call aborted while waiting to retry',
                EMBEDDING_ERROR_CODES.ABORTED,
                { provider: request.provider, model: request.model, itemIndexes: [...itemIndexes], cause: error },
              ),
              dispatch,
            )
          }
          continue
        }

        // A response exists, so the request reached the provider. The transport's
        // own report still wins when it made one.
        const dispatch = reportedDispatch ?? 'sent'
        records.push(Object.freeze({
          attempt: attemptNumber,
          outcome: 'success' as const,
          dispatch,
        }))
        const state: BatchState = Object.freeze({
          phase: 'succeeded' as const,
          vectors: result.vectors,
        })
        states.set(batchIndex, state)
        return Object.freeze({
          batchIndex,
          itemIndexes,
          state,
          attempts: records.length,
          attemptRecords: Object.freeze([...records]),
          // Absent usage is left absent: the aggregator downgrades coverage
          // rather than counting an unreported batch as zero tokens.
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(result.providerRequestId === undefined
            ? {}
            : { providerRequestId: result.providerRequestId }),
          warnings: Object.freeze([...(result.warnings ?? [])]),
        })
      }
    },
  }
}
