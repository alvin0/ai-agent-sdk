import { backoffDelayMs, type ResolvedRetryPolicy } from '../../contract/retry-policy.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type { EmbeddingBatchRequest } from '../../embedding/request.ts'
import type { ModelFailure } from '../../errors/failure.ts'
import { MODEL_ERROR_CODES } from '../../errors/model-error.ts'
import type {
  EndProviderAttemptInput, ModelInvocationContext, ProviderAttemptHandle,
} from '../../observation/report.ts'
import type { AttemptUsageReport, DispatchState } from '../../observation/usage.ts'

/** Codes that mean "the caller stopped this", never "the provider wobbled". */
export function isAbortCode(code: string): boolean {
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
export function asEmbeddingError(
  value: unknown,
  failure: ModelFailure,
  request: EmbeddingBatchRequest,
): EmbeddingError {
  if (value instanceof EmbeddingError) return value
  return new EmbeddingError(failure.message, failure.code, {
    cause: value,
    ...failure.status === undefined ? {} : { status: failure.status },
    ...failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs },
    ...failure.requestId === undefined ? {} : { requestId: failure.requestId },
    provider: request.provider,
    model: request.model,
    itemIndexes: request.items.map(item => item.index),
  })
}

/** Sleep, resolving early and reporting `false` if the signal aborts first. */
export function cancellableDelay(delayMs: number, signal?: AbortSignal): Promise<boolean> {
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
export function delayFor(
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
export function observeDispatchState(
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

