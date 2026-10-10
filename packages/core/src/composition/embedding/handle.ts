/**
 * `embed()` and `embedMany()`: the composition root of one `Logical_Call`.
 *
 * This module owns nothing new. Every mechanism it needs already exists and has
 * exactly one owner — `prepareEmbeddingCall()` for the configuration snapshot,
 * `validatePreDispatch()` for pre-dispatch rejection, `embeddingCacheKey()` for
 * the optional cache, `planEmbeddingBatches()` for splitting,
 * `runBatchesWithConcurrency()` for the in-flight bound,
 * `createEmbeddingRetryLedger()` for retry, `aggregateEmbeddingUsage()` for
 * honest usage. What is left here is the ORDER those pieces run in, and the four
 * decisions that only a `Logical_Call` is in a position to make:
 *
 * 1. **One snapshot per logical call.** `prepareEmbeddingCall()` is called ONCE,
 *    and every `Physical_Batch` — first attempt or fifth retry — dispatches
 *    through that same generation. Validation reads its metadata and the result
 *    reports its `Space_Id`, so a provider reconfiguration mid-call cannot make
 *    the call report a space it did not produce vectors in (Requirements 2.2,
 *    2.3, 2.4).
 * 2. **Order comes from `item.index`, never from settlement time.** Vectors are
 *    written into a pre-allocated array at `results[item.index]`. Batches may
 *    settle in any order, retries may reorder them further, and a provider may
 *    return the vectors of one batch permuted; none of that is observable in the
 *    output (Requirement 4.6).
 * 3. **`expectedSpace` is a rejection, not a warning.** An incompatible expected
 *    space fails with `EMBEDDING_SPACE_INCOMPATIBLE` before the first attempt,
 *    which `validatePreDispatch()` performs against the prepared call
 *    (Requirements 6.2, 6.5).
 * 4. **A fallback group is checked when it is configured, not after a failure.**
 *    A declared fallback outside the group sharing one `compatibilityIdentity`
 *    is `EMBEDDING_CONFIGURATION_INVALID`. There is no fallback DISPATCH here at
 *    all: a failure of the primary model propagates (Requirements 6.6, 6.7).
 *
 * Memory: nothing per-batch survives the batch. The run callback writes vectors,
 * records a few numbers of evidence, and drops the request — so peak payload
 * memory stays `concurrency × maxBytes` rather than scaling with the corpus.
 *
 * Observation is opened here because this is the only scope that knows all three
 * levels at once: `observation.ts` owns the record shapes, and this file owns
 * WHEN each level opens and closes. One `sdk.embedding.call` per logical call,
 * one `sdk.embedding.batch` per `Physical_Batch`, and provider attempts through
 * the existing `context.startProviderAttempt` / `attempt.end` pair, so embedding
 * retries land in the same ledger as generation retries (Requirements 16.1,
 * 16.4, 16.5).
 *
 * @module ai-agent-sdk/core/composition/embedding/handle
 */

import type { EmbedManyInput, EmbedOneInput, EmbeddingModelHandle } from '../../embedding/handle.ts'
import type { EmbeddingSpaceId } from '../../embedding/profile.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import type { EmbeddingContentPart } from '../../embedding/request.ts'
import { DEFAULT_EMBEDDING_TRUNCATION } from '../../embedding/request.ts'
import type { EmbeddingManyResult, EmbeddingResult } from '../../embedding/result.ts'
import type { ModelInvocationContext } from '../../observation/report.ts'
import { beginEmbeddingCallObservation } from './observation.ts'
import { resolveEmbeddingCache } from './cache.ts'
import { resolveEmbeddingConcurrency } from './limiter.ts'
import { requireIdentifier, resolveFallbackIdentity, terminalStatus, toItems } from './handle-support.ts'
import { EmbeddingHandleDriver } from './handle-driver.ts'
import type { EmbeddingHandleDependencies, EmbeddingHandleOptions, LogicalCallOutcome } from './handle-types.ts'
export type { EmbeddingOperationScheduler, EmbeddingFallbackDeclaration,
  EmbeddingHandleOptions, EmbeddingHandleDependencies } from './handle-types.ts'

class EmbeddingHandleRuntime {
  private readonly provider: string
  private readonly model: string
  private readonly context: ModelInvocationContext | undefined
  private readonly options: EmbeddingHandleOptions
  private readonly driver: EmbeddingHandleDriver

  constructor(private readonly dependencies: EmbeddingHandleDependencies) {
    const { adapter, context, operations, options, retryPolicy } = dependencies
    this.context = context
    this.options = options
    const provider = requireIdentifier(options.provider, 'provider')
    const model = requireIdentifier(options.model, 'model')
    this.provider = provider
    this.model = model
    const truncation = options.truncation ?? DEFAULT_EMBEDDING_TRUNCATION
    const concurrency = resolveEmbeddingConcurrency(options.concurrency)
    const cache = resolveEmbeddingCache(options.cache)
    const groupIdentity = resolveFallbackIdentity(options)
    this.driver = new EmbeddingHandleDriver({
      adapter, operations, options, retryPolicy, provider, model, truncation, concurrency, cache, groupIdentity,
    })
  }

  async runLogicalCall(
    purpose: EmbeddingPurpose,
    values: readonly (string | readonly EmbeddingContentPart[])[],
    signal: AbortSignal | undefined,
    expectedSpace: EmbeddingSpaceId | undefined,
  ): Promise<LogicalCallOutcome> {
    const items = toItems(values)

    // Opened before admission, so even a call rejected by a closing runtime or by
    // pre-dispatch validation leaves one record showing zero provider attempts.
    const observation = beginEmbeddingCallObservation({
      route: this.provider,
      model: this.model,
      purpose,
      itemCount: items.length,
    }, {
      ...(this.context === undefined ? {} : { context: this.context }),
      ...(this.dependencies.observation === undefined ? {} : { observation: this.dependencies.observation }),
      ...(this.dependencies.resource === undefined ? {} : { resource: this.dependencies.resource }),
    })
    // Filled in as the call learns them; whatever is known when the call ends is
    // what the terminal record carries, and nothing is defaulted to a lie.
    let cacheHits = 0
    let providerAttempts = 0
    let space: EmbeddingSpaceId | undefined

    try {
      const outcome = await this.driver.run(
        observation, purpose, items, {
          signal, expectedSpace,
          report: (evidence) => {
            cacheHits = evidence.cacheHits ?? cacheHits
            providerAttempts = evidence.providerAttempts ?? providerAttempts
            space = evidence.space ?? space
          },
        },
      )
      observation.end({
        status: 'success',
        spaceId: outcome.space,
        cacheHits,
        providerAttempts: outcome.usage.providerAttempts,
      })
      return outcome
    } catch (error: unknown) {
      observation.end({
        status: terminalStatus(error),
        ...(space === undefined ? {} : { spaceId: space }),
        cacheHits,
        providerAttempts,
        error,
      })
      throw error
    }
  }

  async embed(input: EmbedOneInput): Promise<EmbeddingResult> {
    // One item is a `Logical_Call` like any other; nothing about batching,
    // cache or usage aggregation is special-cased for it.
    const outcome = await this.runLogicalCall(
      input.purpose,
      [input.value],
      input.signal,
      input.expectedSpace ?? this.options.expectedSpace,
    )
    return Object.freeze<EmbeddingResult>({
      embedding: outcome.vectors[0]!,
      space: outcome.space,
      profile: outcome.prepared.profile,
      usage: outcome.usage,
      warnings: outcome.warnings,
    })
  }

  async embedMany(input: EmbedManyInput): Promise<EmbeddingManyResult> {
    const outcome = await this.runLogicalCall(
      input.purpose,
      input.values,
      input.signal,
      input.expectedSpace ?? this.options.expectedSpace,
    )
    return Object.freeze<EmbeddingManyResult>({
      embeddings: Object.freeze(outcome.vectors),
      space: outcome.space,
      profile: outcome.prepared.profile,
      usage: outcome.usage,
      warnings: outcome.warnings,
    })
  }
}

export function createEmbeddingModelHandle(dependencies: EmbeddingHandleDependencies): EmbeddingModelHandle {
  const runtime = new EmbeddingHandleRuntime(dependencies)
  return Object.freeze<EmbeddingModelHandle>({
    embed: input => runtime.embed(input),
    embedMany: input => runtime.embedMany(input),
  })
}
