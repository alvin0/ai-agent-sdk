/**
 * Retry as an adapter DECORATOR.
 *
 * In deepseek-harness this was a plugin on the agent loop's failed-step hook,
 * which let it restart a whole step and recover its attempt count from a durable
 * session log. A standalone SDK has neither, so retry moves down to the adapter
 * and holds its attempt count in the call's own closure.
 *
 * That relocation brings one hard constraint, and it is the thing to understand
 * about this module: a retry may only happen before response content is yielded.
 * Provisional usage snapshots are the only exception. Once a text delta has reached the consumer, re-running the
 * request would replay those tokens and the consumer would render them twice.
 * So a failure that arrives mid-stream is forwarded, not retried  Erecovering
 * from it requires re-running the whole turn, which only the caller can decide.
 *
 * @module ai-agent-sdk/core/runtime/with-retry
 */

import { ModelAdapter, type PreparedAdapterCall } from '../contract/adapter.ts'
import type { GenerateOptions } from '../contract/generate-options.ts'
import type { ModelInfo, ResolvedModelInfo } from '../contract/model-info.ts'
import {
  backoffDelayMs,
  resolveRetryPolicy,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
} from '../contract/retry-policy.ts'
import type { ModelFailure } from '../errors/failure.ts'
import { MODEL_ERROR_CODES } from '../errors/model-error.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import type { ModelInvocationContext } from '../observation/report.ts'
import { RetryAttemptRunner } from './retry-attempt.ts'

/** One retry that is about to be waited out. */
export interface RetryAttempt {
  /** The route whose call failed. */
  readonly provider: string
  /** 1-based retry number. */
  readonly attempt: number
  /** Retry ceiling, or `undefined` under an `always` policy. */
  readonly maxRetries: number | undefined
  /** The failure being recovered from. */
  readonly failure: ModelFailure
  /** How long the decorator will wait before re-dispatching. */
  readonly delayMs: number
}

/** Options for {@link withRetry}. */
export interface WithRetryOptions {
  /**
   * Policy to apply. Omission uses the wrapped adapter's own per-route policy,
   * falling back to the shared defaults.
   */
  policy?: RetryPolicyConfig
  /** Sample in `[0, 1)` for jitter; injectable so tests can be deterministic. */
  random?: () => number
  /** Observe each scheduled retry  Ethe hook for logging and metrics. */
  onRetry?: (attempt: RetryAttempt) => void
  /** Maximum wait while closing an unsuccessful attempt. Defaults to 30s. */
  teardownTimeoutMs?: number
  /**
   * Keep an attempt retryable while it has only streamed reasoning.
   *
   * Reasoning models open a reasoning block before any answer, so by default
   * the retry window closes there and a provider failure while the model is
   * still thinking cannot be retried. With this on, reasoning chunks are held
   * back until the first answer or tool chunk (or the end), then released in
   * order; a failure before that discards them and retries cleanly, so the
   * consumer never sees a failed attempt's reasoning twice. The cost is that
   * reasoning is not shown live. `true` holds up to 4096 chunks; past the cap
   * the attempt is forwarded as usual and retry stops applying.
   */
  bufferReasoningPrefix?: boolean | { readonly maxChunks: number }
}

/** Resolve a delay that honours a provider-requested `retry-after` when sane. */
function delayFor(
  policy: ResolvedRetryPolicy,
  failure: ModelFailure,
  attempt: number,
  random: () => number,
): number | 'give-up' {
  const requested = failure.providerRetryAfterMs
  if (requested !== undefined && Number.isFinite(requested) && requested > 0) {
    if (requested <= policy.maxDelayMs) return requested
    // The provider asked for longer than this policy is willing to wait. Under a
    // bounded policy that is a refusal: sleeping less than asked would just earn
    // another rate-limit response. An `always` policy has nowhere to give up to,
    // so it falls back to local backoff and keeps trying.
    return policy.mode === 'always' ? backoffDelayMs(policy, attempt, random) : 'give-up'
  }
  return backoffDelayMs(policy, attempt, random)
}

/** Sleep, resolving early and reporting false if the signal aborts first. */
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

function retryDecision(input: {
  policy: ResolvedRetryPolicy
  options: GenerateOptions
  failure: ModelFailure
  retries: number
  random: () => number
}): Extract<StreamChunk, { type: 'finish' }> | { type: 'retry'; delayMs: number } {
  const { policy, options, failure, retries, random } = input
  if (options.signal?.aborted === true || failure.code === MODEL_ERROR_CODES.ABORTED) {
    return { type: 'finish', reason: { kind: 'aborted', failure } }
  }
  const eligible = policy.mode === 'always'
    || (policy.retryableCodes.includes(failure.code) && retries < policy.maxRetries)
  if (!eligible) return { type: 'finish', reason: { kind: 'error', failure } }
  const delayMs = delayFor(policy, failure, retries + 1, random)
  if (delayMs === 'give-up') return { type: 'finish', reason: { kind: 'error', failure } }
  return { type: 'retry', delayMs }
}

class RetryingAdapter extends ModelAdapter {
  private readonly inner: ModelAdapter
  private readonly options: WithRetryOptions

  // Explicit fields rather than constructor parameter properties: Node's
  // strip-only TypeScript mode rejects those, and this package is meant to run
  // under `node file.ts` without a build step.
  constructor(inner: ModelAdapter, options: WithRetryOptions) {
    super()
    this.inner = inner
    this.options = options
  }

  override providerInfo(provider: string): ReturnType<ModelAdapter['providerInfo']> {
    return this.inner.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.inner.providerRetryPolicy(provider)
  }

  override listModels(provider: string): Promise<readonly ModelInfo[]> {
    return this.inner.listModels(provider)
  }

  override resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    return this.inner.resolveModel(provider, model, signal)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall> {
    const prepared = await this.inner.prepareCall(provider, model, signal, context)
    const policy = this.policyFor(provider)
    return {
      model: prepared.model,
      // Retries reuse the SAME prepared generation. Re-preparing mid-retry could
      // pair a fresh endpoint with capabilities resolved against the old one,
      // which is exactly what the prepare/dispatch binding exists to prevent.
      stream: (options, invocation = context) => this.retryStream(options, request => prepared.stream(request,
        invocation), policy, invocation),
    }
  }

  stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    return this.retryStream(
      options,
      request => this.inner.stream(request, context),
      this.policyFor(options.provider),
      context,
    )
  }

  private policyFor(provider: string): ResolvedRetryPolicy {
    if (this.options.policy !== undefined) {
      return resolveRetryPolicy(this.options.policy, `withRetry("${provider}").policy`)
    }
    return this.inner.providerRetryPolicy(provider)
      ?? resolveRetryPolicy(undefined, `withRetry("${provider}").policy`)
  }

  private async * retryStream(
    options: GenerateOptions,
    dispatch: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
    policy: ResolvedRetryPolicy,
    context?: ModelInvocationContext,
  ): AsyncGenerator<StreamChunk> {
    if (policy.mode === 'always' && options.signal === undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'an always retry policy requires an AbortSignal or deadline',
            code: MODEL_ERROR_CODES.INVALID_REQUEST,
          },
        },
      }
      return
    }
    const random = this.options.random ?? Math.random
    let retries = 0

    while (true) {
      const attempt = yield* new RetryAttemptRunner(this.options).runAttempt(options, dispatch)
      if (attempt.kind === 'forward') {
        yield* attempt.chunks
        return
      }

      const failure = attempt.failure
      const decision = retryDecision({ policy, options, failure, retries, random })
      if (decision.type === 'finish') {
        yield decision
        return
      }
      const delayMs = decision.delayMs

      retries += 1
      this.observeRetry({ options, context, policy, attempt: retries, failure, delayMs })
      if (!await cancellableDelay(delayMs, options.signal)) {
        yield {
          type: 'finish',
          reason: {
            kind: 'aborted',
            failure: {
              message: 'model call aborted while waiting to retry',
              code: MODEL_ERROR_CODES.ABORTED,
            },
          },
        }
        return
      }
    }
  }

  private observeRetry(input: {
    options: GenerateOptions
    context: ModelInvocationContext | undefined
    policy: ResolvedRetryPolicy
    attempt: number
    failure: ModelFailure
    delayMs: number
  }): void {
    const { options, context, policy, attempt, failure, delayMs } = input
    context?.recordProviderRetry?.({
      nextAttemptNumber: attempt + 1,
      delayMs,
      failureCode: failure.code,
    })
    try {
      this.options.onRetry?.({
        provider: options.provider,
        attempt,
        maxRetries: policy.mode === 'normal' ? policy.maxRetries : undefined,
        failure,
        delayMs,
      })
    } catch {
      // Metrics/logging observers do not own request availability.
    }
  }
}

/**
 * Wrap an adapter so eligible transient failures are retried with bounded
 * exponential backoff and jitter.
 *
 * Only failures that occur BEFORE the first chunk reaches the consumer are
 * retried; see the module note for why.
 * @param adapter - the adapter to wrap; its metadata methods are delegated unchanged.
 * @param options - policy, jitter source, and retry observer.
 * @returns a new adapter with retry behaviour; the original is unmodified.
 */
export function withRetry(adapter: ModelAdapter, options: WithRetryOptions = {}): ModelAdapter {
  return new RetryingAdapter(adapter, options)
}
