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
  resolveRetryPolicy,
  retryDelayMs,
  type ResolvedRetryPolicy,
  type RetryPolicyConfig,
} from '../contract/retry-policy.ts'
import { normalizeModelFailure, type ModelFailure } from '../errors/failure.ts'
import { MODEL_ERROR_CODES, ModelError } from '../errors/model-error.ts'
import type { StreamChunk } from '../stream/chunk.ts'
import type { ModelInvocationContext } from '../observation/report.ts'
import { waitForSettlement } from '../async/settlement.ts'

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
      stream: (options, invocation = context) => this.retryStream(options, request => prepared.stream(request, invocation), policy, invocation),
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
      const attempt = yield* this.runAttempt(options, dispatch)
      if (attempt.kind === 'forward') {
        yield* attempt.chunks
        return
      }

      const failure = attempt.failure
      // An abort is the caller's decision, never a transient fault.
      if (options.signal?.aborted === true || failure.code === MODEL_ERROR_CODES.ABORTED) {
        yield { type: 'finish', reason: { kind: 'aborted', failure } }
        return
      }

      const eligible = policy.mode === 'always'
        || (policy.retryableCodes.includes(failure.code) && retries < policy.maxRetries)
      if (!eligible) {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }

      const delayMs = retryDelayMs(policy, failure, retries + 1, random)
      if (delayMs === 'give-up') {
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }

      retries += 1
      context?.recordProviderRetry?.({
        nextAttemptNumber: retries + 1,
        delayMs,
        failureCode: failure.code,
      })
      try {
        this.options.onRetry?.({
          provider: options.provider,
          attempt: retries,
          maxRetries: policy.mode === 'normal' ? policy.maxRetries : undefined,
          failure,
          delayMs,
        })
      } catch {
        // Metrics/logging observers do not own request availability.
      }
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

  /**
   * Run one attempt, forwarding only provisional usage before committing content.
   *
   * Buffering is what makes retry safe: until the attempt either produces its
   * first non-progress chunk or fails, no content has been committed. Once that
   * chunk exists the attempt is no longer retryable, so it switches to
   * `forward` and streams the rest through untouched.
   */
  private async *runAttempt(
    options: GenerateOptions,
    dispatch: (request: GenerateOptions) => AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk,
    | { kind: 'forward'; chunks: AsyncIterable<StreamChunk> }
    | { kind: 'retryable'; failure: ModelFailure }
  > {
    const cap = reasoningBufferCap(this.options.bufferReasoningPrefix)
    let iterator: AsyncIterator<StreamChunk>
    try {
      iterator = dispatch(options)[Symbol.asyncIterator]()
    } catch (error: unknown) {
      return { kind: 'retryable', failure: normalizeModelFailure(error) }
    }

    let first: IteratorResult<StreamChunk>
    try {
      first = await iterator.next()
      // Provisional accounting is not response content: preserve pre-content
      // retries while allowing the caller to observe usage as it arrives.
      while (!first.done && first.value.type === 'usage-progress') {
        let resumed = false
        try {
          yield first.value
          resumed = true
        } finally {
          if (!resumed) await closeIterator(iterator, this.options.teardownTimeoutMs ?? 30_000)
        }
        first = await iterator.next()
      }
    } catch (error: unknown) {
      await closeIterator(iterator, this.options.teardownTimeoutMs ?? 30_000)
      return { kind: 'retryable', failure: normalizeModelFailure(error) }
    }

    // A stream that ends with no chunks at all told us nothing; treat it as the
    // degenerate empty response rather than a silently successful turn.
    if (first.done === true) {
      return {
        kind: 'retryable',
        failure: {
          message: 'the adapter produced no chunks',
          code: MODEL_ERROR_CODES.UNKNOWN,
        },
      }
    }

    // An adapter behind the registry's funnel reports failure as a terminal
    // error finish rather than a throw. As the FIRST chunk, that is still a
    // clean nothing-emitted failure and remains retryable.
    let chunk = first.value
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
      await closeIterator(iterator, this.options.teardownTimeoutMs ?? 30_000)
      return { kind: 'retryable', failure: chunk.reason.failure }
    }

    const held: StreamChunk[] = []
    if (cap > 0) {
      const reasoningBlocks = new Set<number>()
      let ended = false
      try {
        while (isReasoningChunk(chunk, reasoningBlocks) && held.length < cap) {
          held.push(chunk)
          let next = await iterator.next()
          while (!next.done && next.value.type === 'usage-progress') {
            let resumed = false
            try {
              yield next.value
              resumed = true
            } finally {
              if (!resumed) await closeIterator(iterator, this.options.teardownTimeoutMs ?? 30_000)
            }
            next = await iterator.next()
          }
          if (next.done === true) { ended = true; break }
          chunk = next.value
          // Still only thinking when it failed: nothing was shown, so retry.
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            await closeIterator(iterator, this.options.teardownTimeoutMs ?? 30_000)
            return { kind: 'retryable', failure: chunk.reason.failure }
          }
        }
      } catch (error: unknown) {
        await closeIterator(iterator, this.options.teardownTimeoutMs ?? 30_000)
        return { kind: 'retryable', failure: normalizeModelFailure(error) }
      }
      // A stream that only reasoned and then ended releases what it held.
      if (ended) {
        return { kind: 'forward', chunks: resume(held, undefined, iterator, this.options.teardownTimeoutMs ?? 30_000) }
      }
    }

    return {
      kind: 'forward',
      chunks: resume(held, chunk, iterator, this.options.teardownTimeoutMs ?? 30_000),
    }
  }
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`)
  return value
}

function reasoningBufferCap(option: WithRetryOptions['bufferReasoningPrefix']): number {
  if (option === undefined || option === false) return 0
  if (option === true) return 4096
  if (!Number.isSafeInteger(option.maxChunks) || option.maxChunks < 1) {
    throw new RangeError('bufferReasoningPrefix.maxChunks must be a positive safe integer')
  }
  return option.maxChunks
}

/** Whether a chunk only carries reasoning, tracking which block indexes are reasoning. */
function isReasoningChunk(chunk: StreamChunk, reasoningBlocks: Set<number>): boolean {
  if (chunk.type === 'reasoning-delta') return true
  if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
    reasoningBlocks.add(chunk.index)
    return true
  }
  return chunk.type === 'block-end' && (chunk.block.type === 'reasoning' || reasoningBlocks.has(chunk.index))
}

/** Re-attach already-read chunks to the front of their iterator. */
async function* resume(
  held: readonly StreamChunk[],
  first: StreamChunk | undefined,
  iterator: AsyncIterator<StreamChunk>,
  teardownTimeoutMs: number,
): AsyncGenerator<StreamChunk> {
  let exhausted = false
  try {
    for (const chunk of held) yield chunk
    if (first !== undefined) yield first
    while (true) {
      const next = await iterator.next()
      if (next.done === true) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    if (!exhausted) await closeIterator(iterator, teardownTimeoutMs)
  }
}

async function closeIterator(iterator: AsyncIterator<StreamChunk>, timeoutMs: number): Promise<void> {
  const closing = iterator.return?.()
  if (closing === undefined) return
  const settled = await waitForSettlement(
    Promise.resolve(closing),
    positiveFinite(timeoutMs, 'withRetry teardownTimeoutMs'),
  )
  if (!settled) {
    throw new ModelError(
      `retry attempt teardown exceeded ${timeoutMs}ms`,
      MODEL_ERROR_CODES.TEARDOWN_TIMEOUT,
    )
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
