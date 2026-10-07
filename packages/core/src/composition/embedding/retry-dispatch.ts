import type { ResolvedRetryPolicy } from '../../contract/retry-policy.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../embedding/request.ts'
import type { EmbeddingBatchResult } from '../../embedding/result.ts'
import { normalizeModelFailure, type ModelFailure } from '../../errors/failure.ts'
import type { ModelInvocationContext } from '../../observation/report.ts'
import type { DispatchState } from '../../observation/usage.ts'
import type { BatchState, EmbeddingAttemptRecord, EmbeddingBatchDispatcher,
  EmbeddingBatchOutcome, EmbeddingRetryOptions } from './retry.ts'
import { asEmbeddingError, delayFor, isAbortCode, observeDispatchState } from './retry-support.ts'

interface DriverInput {
  dispatcher: EmbeddingBatchDispatcher
  options: EmbeddingRetryOptions
  policy: ResolvedRetryPolicy
  random: () => number
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<boolean>
  states: Map<number, BatchState>
  cancelled: (request: EmbeddingBatchRequest) => boolean
  abortedOutcome: (
    batchIndex: number, request: EmbeddingBatchRequest, records: readonly EmbeddingAttemptRecord[],
    details: { error: EmbeddingError; dispatch: DispatchState },
  ) => EmbeddingBatchOutcome
}
interface FailureInput {
  batchIndex: number
  request: EmbeddingBatchRequest
  records: EmbeddingAttemptRecord[]
  itemIndexes: readonly number[]
  invocationContext: ModelInvocationContext | undefined
  attemptNumber: number
  reportedDispatch: DispatchState | undefined
  error: unknown
  retry: { count: number }
}

export class EmbeddingBatchRetryDriver {
  private readonly input: DriverInput
  constructor(input: DriverInput) { this.input = input }

  async dispatch(
    batchIndex: number,
    request: EmbeddingBatchRequest,
    batchContext?: ModelInvocationContext,
  ): Promise<EmbeddingBatchOutcome> {
    const { dispatcher, options, states, cancelled, abortedOutcome } = this.input
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
    const retry = { count: 0 }

    for (;;) {
      const attemptNumber = records.length + 1
      // Report the abort before spending an attempt on a call already cancelled.
      if (cancelled(request)) {
        return abortedOutcome(
          batchIndex,
          request,
          records,
          {
            error: new EmbeddingError(
              'embedding call aborted before dispatch',
              EMBEDDING_ERROR_CODES.ABORTED,
              { provider: request.provider, model: request.model, itemIndexes: [...itemIndexes] },
            ),
            // Before any attempt, no adapter call was made. Afterwards, an
            // unreported transport state stays unknown.
            dispatch: records.length === 0 ? 'not-sent' : 'unknown',
          },
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
        const outcome = await this.handleFailure({
          batchIndex, request, records, itemIndexes, invocationContext, attemptNumber,
          reportedDispatch, error, retry,
        })
        if (outcome !== undefined) return outcome
        continue
      }

      return successfulOutcome(states, { batchIndex, itemIndexes, records, attemptNumber, reportedDispatch, result })
    }
  }

  private async handleFailure(input: FailureInput): Promise<EmbeddingBatchOutcome | undefined> {
    const { options, policy, random, sleep, states, cancelled, abortedOutcome } = this.input
    const { batchIndex, request, records, itemIndexes, invocationContext, attemptNumber,
      reportedDispatch, error, retry } = input
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
      return abortedOutcome(batchIndex, request, records, { error: embeddingError, dispatch })
    }

    const delayMs = retryDelay(policy, failure, retry.count, random)
    if (delayMs === 'give-up') {
      return terminalFailure(states, { batchIndex, itemIndexes, records, embeddingError, dispatch, policy, failure })
    }

    retry.count += 1
    this.notifyRetry({ invocationContext, request, batchIndex, attempt: retry.count, failure, dispatch, delayMs })

    if (!await sleep(delayMs, options.signal ?? request.signal)) {
      return abortedOutcome(
        batchIndex,
        request,
        records,
        { error: new EmbeddingError(
          'embedding call aborted while waiting to retry',
          EMBEDDING_ERROR_CODES.ABORTED,
          { provider: request.provider, model: request.model, itemIndexes: [...itemIndexes], cause: error },
        ),
        dispatch },
      )
    }
    return undefined
  }

  private notifyRetry(input: {
    invocationContext: ModelInvocationContext | undefined
    request: EmbeddingBatchRequest
    batchIndex: number
    attempt: number
    failure: ModelFailure
    dispatch: DispatchState
    delayMs: number
  }): void {
    const { invocationContext, request, batchIndex, attempt, failure, dispatch, delayMs } = input
    const { options, policy } = this.input
    invocationContext?.recordProviderRetry?.({
      nextAttemptNumber: attempt + 1,
      delayMs,
      failureCode: failure.code,
    })
    try {
      options.onRetry?.({
        provider: request.provider,
        model: request.model,
        batchIndex,
        attempt,
        maxRetries: policy.mode === 'normal' ? policy.maxRetries : undefined,
        failureCode: failure.code,
        dispatch,
        delayMs,
      })
    } catch {
      // Metrics and logging observers do not own request availability.
    }
  }
}

function retryDelay(policy: ResolvedRetryPolicy, failure: ModelFailure, retries: number, random: () => number) {
  const eligible = policy.mode === 'always'
    || (policy.retryableCodes.includes(failure.code) && retries < policy.maxRetries)
  const delayMs = eligible ? delayFor(policy, failure, retries + 1, random) : 'give-up'
  return delayMs
}

function terminalFailure(states: Map<number, BatchState>, input: {
  batchIndex: number
  itemIndexes: readonly number[]
  records: readonly EmbeddingAttemptRecord[]
  embeddingError: EmbeddingError
  dispatch: DispatchState
  policy: ResolvedRetryPolicy
  failure: ModelFailure
}): EmbeddingBatchOutcome {
  const { batchIndex, itemIndexes, records, embeddingError, dispatch, policy, failure } = input
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

function successfulOutcome(states: Map<number, BatchState>, input: {
  batchIndex: number
  itemIndexes: readonly number[]
  records: EmbeddingAttemptRecord[]
  attemptNumber: number
  reportedDispatch: DispatchState | undefined
  result: EmbeddingBatchResult
}): EmbeddingBatchOutcome {
  const { batchIndex, itemIndexes, records, attemptNumber, reportedDispatch, result } = input
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
