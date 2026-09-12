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

import type { ResolvedRetryPolicy } from '../../contract/retry-policy.ts'
import type { EmbeddingAdapter, PreparedEmbeddingCall } from '../../embedding/adapter.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../embedding/errors.ts'
import type {
  EmbedManyInput,
  EmbedOneInput,
  EmbeddingCacheOptions,
  EmbeddingModelHandle,
  EmbeddingModelOptions,
} from '../../embedding/handle.ts'
import type { EmbeddingSpaceId } from '../../embedding/profile.ts'
import type { EmbeddingPurpose } from '../../embedding/purpose.ts'
import type {
  EmbeddingBatchRequest,
  EmbeddingContentPart,
  EmbeddingItem,
  EmbeddingTruncation,
} from '../../embedding/request.ts'
import { DEFAULT_EMBEDDING_TRUNCATION } from '../../embedding/request.ts'
import type {
  EmbeddingManyResult,
  EmbeddingResult,
  EmbeddingWarning,
} from '../../embedding/result.ts'
import type { EmbeddingUsageReport } from '../../embedding/usage.ts'
import { validateBatchResult, validatePreDispatch } from '../../embedding/validation.ts'
import { normalizeModelFailure } from '../../errors/failure.ts'
import { MODEL_ERROR_CODES } from '../../errors/model-error.ts'
import type { ObservationResource, OperationStatus } from '../../observation/event.ts'
import type { ObservationPort } from '../../observation/port.ts'
import type { ModelInvocationContext } from '../../observation/report.ts'
import type { OperationLease, OperationOptions } from '../lifecycle/types.ts'
import {
  beginEmbeddingCallObservation,
  type EmbeddingCallObservation,
} from './observation.ts'
import {
  embeddingCacheKey,
  readEmbeddingCacheEntry,
  resolveEmbeddingCache,
  writeEmbeddingCacheEntry,
} from './cache.ts'
import { resolveEmbeddingConcurrency, runBatchesWithConcurrency } from './limiter.ts'
import { planEmbeddingBatches } from './planner.ts'
import { createEmbeddingRetryLedger } from './retry.ts'
import {
  aggregateEmbeddingUsage,
  type EmbeddingBatchUsageEvidence,
} from './usage.ts'

/**
 * The admission surface this handle needs from `RuntimeOperations`.
 *
 * Structural on purpose: the handle needs a lease whose signal already fuses the
 * runtime root controller with the caller's signal, and nothing else. Declaring
 * the dependency this narrowly is what lets a test drive one `Logical_Call`
 * without standing up a whole runtime.
 */
export interface EmbeddingOperationScheduler {
  execute<T>(
    kind: 'embedding-call',
    options: OperationOptions,
    work: (lease: OperationLease) => Promise<T>,
  ): Promise<T>
}

/**
 * One member of a declared fallback group.
 *
 * `compatibilityIdentity` is REQUIRED, and that is the whole point: a fallback is
 * only legitimate when the provider has declared that the two models share an
 * embedding space. Naming a model id alone would ask the runtime to infer
 * compatibility from a name, which is exactly what Requirement 6.3 forbids.
 */
export interface EmbeddingFallbackDeclaration {
  readonly model: string
  /** The provider's declaration that this model shares the primary's space. */
  readonly compatibilityIdentity: string
}

/**
 * Handle configuration: the public {@link EmbeddingModelOptions} plus the two
 * fields that only exist to make a fallback group checkable.
 *
 * These live here rather than on `EmbeddingModelOptions` because they are
 * runtime configuration of one handle, not part of the type-only public surface
 * that `embedding/handle.ts` owns.
 */
export interface EmbeddingHandleOptions extends EmbeddingModelOptions {
  /**
   * The `compatibilityIdentity` the caller believes this route resolves to.
   *
   * When present it is enforced against the prepared call, so a route whose
   * declared identity has changed fails loudly instead of quietly producing
   * vectors in another space.
   */
  readonly compatibilityIdentity?: string
  /** Models declared to share this call's embedding space. */
  readonly fallback?: readonly EmbeddingFallbackDeclaration[]
}

/** Everything {@link createEmbeddingModelHandle} needs, resolved by the manager. */
export interface EmbeddingHandleDependencies {
  /** Runtime admission; supplies the lease whose signal covers `close()`. */
  readonly operations: EmbeddingOperationScheduler
  /** The adapter the registry resolved for this route + model. */
  readonly adapter: Pick<EmbeddingAdapter, 'prepareEmbeddingCall'>
  readonly options: EmbeddingHandleOptions
  /** Route policy captured at registration; omission takes the SDK defaults. */
  readonly retryPolicy?: ResolvedRetryPolicy
  /**
   * Caller invocation context.
   *
   * Its port, resource, correlation and scope are adopted so an embedding call
   * nested in a larger trace joins that trace. When it already performs attempt
   * accounting, that accounting is kept and this handle adds none of its own.
   */
  readonly context?: ModelInvocationContext
  /** Runtime default observation port, used when the context carries none. */
  readonly observation?: ObservationPort
  /** Runtime resource identity, used when the context carries none. */
  readonly resource?: ObservationResource
}

/** One settled batch's small, order-independent residue. */
interface BatchResidue {
  readonly evidence: EmbeddingBatchUsageEvidence
  readonly warnings: readonly EmbeddingWarning[]
}

/**
 * Facts a `Logical_Call` learns as it progresses, reported outward so the
 * terminal observation record is accurate even when the call fails.
 *
 * Every field is optional because each becomes known at a different point, and a
 * field that is not yet known must stay absent rather than be reported as zero.
 */
interface LogicalCallEvidence {
  readonly space?: EmbeddingSpaceId
  readonly cacheHits?: number
  readonly providerAttempts?: number
}

/** What one `Logical_Call` produces, before it is shaped into one of two results. */
interface LogicalCallOutcome {
  readonly vectors: readonly (readonly number[])[]
  readonly space: EmbeddingSpaceId
  readonly prepared: PreparedEmbeddingCall
  readonly usage: EmbeddingUsageReport
  readonly warnings: readonly EmbeddingWarning[]
}

function configurationError(message: string): EmbeddingError {
  return new EmbeddingError(message, EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID)
}

/** Codes that mean the caller or the runtime stopped this, not that it broke. */
const ABORT_CODES: ReadonlySet<string> = new Set([
  EMBEDDING_ERROR_CODES.ABORTED,
  MODEL_ERROR_CODES.ABORTED,
  'RUNTIME_OPERATION_ABORTED',
  'RUNTIME_CLOSING',
  'RUNTIME_CLOSED',
])

/**
 * Terminal status of one failed span.
 *
 * A cancellation is reported as `aborted` rather than `error` so an operator
 * reading a trace can tell a broken provider from a caller that changed its mind
 * — the two have very different follow-ups.
 */
function terminalStatus(error: unknown): OperationStatus {
  return ABORT_CODES.has(normalizeModelFailure(error).code) ? 'aborted' : 'error'
}

/** A non-empty string, or a configuration failure naming the field. */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw configurationError(`embedding handle requires a non-empty \`${field}\``)
  }
  return value
}

/**
 * Validates a declared fallback group and reduces it to the ONE identity every
 * member must share.
 *
 * Rejecting at construction rather than at failure time is deliberate: a group
 * that spans two embedding spaces is misconfigured whether or not the primary
 * model ever fails, and discovering it only during an incident is the worst
 * possible moment (Requirement 6.7).
 */
function resolveFallbackIdentity(options: EmbeddingHandleOptions): string | undefined {
  const declared = options.compatibilityIdentity === undefined
    ? undefined
    : requireIdentifier(options.compatibilityIdentity, 'compatibilityIdentity')
  const fallback = options.fallback
  if (fallback === undefined) return declared
  if (!Array.isArray(fallback) || fallback.length === 0) {
    throw configurationError('embedding fallback declaration must be a non-empty array')
  }

  let identity = declared
  for (const entry of fallback) {
    if (entry === null || typeof entry !== 'object') {
      throw configurationError('each embedding fallback entry must declare a model and an identity')
    }
    requireIdentifier(entry.model, 'fallback.model')
    const entryIdentity = requireIdentifier(entry.compatibilityIdentity, 'fallback.compatibilityIdentity')
    if (identity === undefined) identity = entryIdentity
    else if (identity !== entryIdentity) {
      // Two identities in one group means at least one member produces vectors
      // in a different space, so the group is not a fallback group at all.
      throw configurationError(
        'embedding fallback models must all declare the same compatibilityIdentity',
      )
    }
  }
  return identity
}

/** Normalises one caller value into the content parts of a single item. */
function toContentParts(
  value: string | readonly EmbeddingContentPart[],
  index: number,
): readonly EmbeddingContentPart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (Array.isArray(value)) {
    const parts: EmbeddingContentPart[] = []
    for (const part of value) {
      if (part === null || typeof part !== 'object' || part.type !== 'text' || typeof part.text !== 'string') {
        throw new EmbeddingError(
          'embedding content parts must have type "text" and a string text value',
          EMBEDDING_ERROR_CODES.REQUEST_INVALID,
          { itemIndexes: [index] },
        )
      }
      parts.push(Object.freeze({ type: 'text', text: part.text }))
    }
    return Object.freeze(parts)
  }
  throw new EmbeddingError(
    'embedding input must be a string or an array of content parts',
    EMBEDDING_ERROR_CODES.REQUEST_INVALID,
    { itemIndexes: [index] },
  )
}

/**
 * Builds the items of one `Logical_Call`.
 *
 * `index` is the caller's position and is the ONLY coordinate that matters
 * downstream: batching, retry and out-of-order settlement all preserve it, and
 * output order is restored from it.
 */
function toItems(
  values: readonly (string | readonly EmbeddingContentPart[])[],
): readonly EmbeddingItem[] {
  if (!Array.isArray(values)) {
    throw new EmbeddingError(
      'embedding input values must be an array',
      EMBEDDING_ERROR_CODES.REQUEST_INVALID,
    )
  }
  return Array.from(values, (value, index) => ({ index, contentParts: toContentParts(value, index) }))
}

/** The truncation warning of one batch, when the caller allowed truncation. */
function truncationWarnings(
  truncation: EmbeddingTruncation,
  indexes: readonly number[],
): readonly EmbeddingWarning[] {
  if (truncation !== 'allow' || indexes.length === 0) return []
  return [Object.freeze<EmbeddingWarning>({
    code: 'input-truncated',
    itemIndexes: Object.freeze([...indexes]),
    message: 'provider reported that it truncated the input before embedding it',
  })]
}

/**
 * Creates one `EmbeddingModelHandle`.
 *
 * Everything that can be decided without the provider IS decided here, at
 * construction: route identity, the concurrency bound, the cache configuration,
 * and the fallback group. `embeddingModel()` is synchronous, so a caller learns
 * about a misconfiguration at the call that made it rather than at the first
 * `embed()`.
 *
 * @throws {EmbeddingError} `EMBEDDING_CONFIGURATION_INVALID` for an unusable
 * route, concurrency, cache, or fallback declaration.
 */
export function createEmbeddingModelHandle(
  dependencies: EmbeddingHandleDependencies,
): EmbeddingModelHandle {
  const { adapter, context, operations, options, retryPolicy } = dependencies
  const provider = requireIdentifier(options.provider, 'provider')
  const model = requireIdentifier(options.model, 'model')
  const truncation = options.truncation ?? DEFAULT_EMBEDDING_TRUNCATION
  // Both throw EMBEDDING_CONFIGURATION_INVALID; both belong at construction.
  const concurrency = resolveEmbeddingConcurrency(options.concurrency)
  const cache = resolveEmbeddingCache(options.cache)
  const groupIdentity = resolveFallbackIdentity(options)

  /**
   * Enforces the declared group against what the route actually resolved to.
   *
   * The declaration is checked at construction; this is the second half of the
   * same check, and it is the earliest point at which the route's real identity
   * is known.
   */
  const assertDeclaredIdentity = (prepared: PreparedEmbeddingCall): void => {
    if (groupIdentity === undefined) return
    if (prepared.profile.compatibilityIdentity === groupIdentity) return
    throw configurationError(
      `embedding fallback group declares compatibility identity "${groupIdentity}" `
      + `but route "${provider}" resolved "${prepared.profile.compatibilityIdentity}"`,
    )
  }

  /**
   * Reads the cache for every item, returning the misses in input order.
   *
   * A hit is written straight into `results`, so a fully cached call plans zero
   * batches and spends zero `Provider_Attempt`s. Two gates apply: the key covers
   * the five components of Requirement 5.2, and `readEmbeddingCacheEntry`
   * discards an entry from another `Space_Id` (Requirement 5.3).
   */
  const partitionByCache = async (
    active: EmbeddingCacheOptions,
    items: readonly EmbeddingItem[],
    prepared: PreparedEmbeddingCall,
    purpose: EmbeddingPurpose,
    results: (readonly number[] | undefined)[],
    keys: Map<number, string>,
  ): Promise<readonly EmbeddingItem[]> => {
    const misses: EmbeddingItem[] = []
    for (const item of items) {
      const key = await embeddingCacheKey({
        scope: active.scope,
        profile: prepared.profile,
        purpose,
        contentParts: item.contentParts,
      })
      const entry = await readEmbeddingCacheEntry(active, key, prepared.spaceId, prepared.profile.dimensions)
      if (entry === undefined) {
        keys.set(item.index, key)
        misses.push(item)
        continue
      }
      results[item.index] = entry.values
    }
    return misses
  }

  /** One `Logical_Call`, from admission to a fully ordered vector array. */
  const runLogicalCall = async (
    purpose: EmbeddingPurpose,
    values: readonly (string | readonly EmbeddingContentPart[])[],
    signal: AbortSignal | undefined,
    expectedSpace: EmbeddingSpaceId | undefined,
  ): Promise<LogicalCallOutcome> => {
    const items = toItems(values)

    // Opened before admission, so even a call rejected by a closing runtime or by
    // pre-dispatch validation leaves one record showing zero provider attempts.
    const observation = beginEmbeddingCallObservation({
      route: provider,
      model,
      purpose,
      itemCount: items.length,
    }, {
      ...(context === undefined ? {} : { context }),
      ...(dependencies.observation === undefined ? {} : { observation: dependencies.observation }),
      ...(dependencies.resource === undefined ? {} : { resource: dependencies.resource }),
    })
    // Filled in as the call learns them; whatever is known when the call ends is
    // what the terminal record carries, and nothing is defaulted to a lie.
    let cacheHits = 0
    let providerAttempts = 0
    let space: EmbeddingSpaceId | undefined

    try {
      const outcome = await runAdmitted(
        observation,
        purpose,
        items,
        signal,
        expectedSpace,
        (evidence) => {
          cacheHits = evidence.cacheHits ?? cacheHits
          providerAttempts = evidence.providerAttempts ?? providerAttempts
          space = evidence.space ?? space
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

  /** The admitted body of one `Logical_Call`; see {@link runLogicalCall}. */
  const runAdmitted = async (
    observation: EmbeddingCallObservation,
    purpose: EmbeddingPurpose,
    items: readonly EmbeddingItem[],
    signal: AbortSignal | undefined,
    expectedSpace: EmbeddingSpaceId | undefined,
    report: (evidence: LogicalCallEvidence) => void,
  ): Promise<LogicalCallOutcome> => {
    return operations.execute(
      'embedding-call',
      signal === undefined ? {} : { signal },
      async (lease): Promise<LogicalCallOutcome> => {
        // ONE snapshot for the whole logical call: validation below and every
        // dispatch further down read this same generation (Requirements 2.2-2.4).
        const prepared = await adapter.prepareEmbeddingCall(
          provider,
          model,
          {
            ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
            ...(options.batchLimits === undefined ? {} : { limits: options.batchLimits }),
          },
          lease.signal,
          observation.context,
        )
        assertDeclaredIdentity(prepared)
        // Known from here on, so a later failure still reports the space the call
        // would have produced vectors in.
        report({ space: prepared.spaceId })

        // Rejects purpose, empty inputs, dimensions, truncation, expectedSpace and
        // over-long inputs with 0 `Provider_Attempt` spent.
        validatePreDispatch({
          purpose,
          items,
          ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
          truncation,
          ...(expectedSpace === undefined ? {} : { expectedSpace }),
        }, prepared)

        // Pre-allocated to the INPUT length: the one mechanism behind order
        // restoration, independent of batch settlement order (Requirement 4.6).
        const results: (readonly number[] | undefined)[] = new Array<readonly number[] | undefined>(items.length)
        const cacheKeys = new Map<number, string>()
        const pending = cache === undefined
          ? items
          : await partitionByCache(cache, items, prepared, purpose, results, cacheKeys)
        report({ cacheHits: items.length - pending.length })

        const ledger = createEmbeddingRetryLedger(prepared, {
          ...(retryPolicy === undefined ? {} : { policy: retryPolicy }),
          signal: lease.signal,
          ...(observation.context === undefined ? {} : { context: observation.context }),
        })
        // Running total, so a call that fails mid-flight still reports the cost of
        // the attempts it already spent (Requirement 16.6).
        let attemptsSpent = 0
        // Keyed by `batchIndex` so warnings and usage evidence are reported in
        // plan order no matter which batch settled first.
        const residues = new Map<number, BatchResidue>()

        const outcome = await runBatchesWithConcurrency(
          planEmbeddingBatches(pending, prepared.limits),
          async (plan): Promise<void> => {
            const request: EmbeddingBatchRequest = {
              provider,
              model,
              purpose,
              items: plan.items,
              ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
              truncation,
              signal: lease.signal,
            }
            // Size only: the planner already measured this batch, so describing it
            // costs nothing and reveals nothing (Requirement 16.4).
            const batchObservation = observation.beginBatch({
              batchIndex: plan.batchIndex,
              itemCount: plan.items.length,
              byteCount: plan.bytes,
              estimatedTokens: plan.estimatedTokens,
              ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
            })
            try {
              // The batch context is what parents each `Provider_Attempt` under
              // the batch that provoked it; retry accounting is unchanged.
              const settled = await ledger.dispatch(
                plan.batchIndex,
                request,
                batchObservation.context,
              )
              attemptsSpent += settled.attempts
              report({ providerAttempts: attemptsSpent })
              const state = settled.state
              if (state.phase === 'failed') {
                // No fallback model: the primary's failure IS the call's failure
                // (Requirement 6.6).
                throw state.error
              }
              if (state.phase !== 'succeeded') {
                // The ledger only ever returns a terminal state. A non-terminal one
                // means the ledger contract was violated, and guessing which half of
                // the batch exists would be worse than saying so.
                throw new EmbeddingError(
                  `embedding batch ${plan.batchIndex} settled in a non-terminal state`,
                  EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
                  { provider, model, itemIndexes: [...settled.itemIndexes] },
                )
              }

              const vectors = state.vectors
              // Guards the write below. A permuted order is fine — indexes carry
              // the mapping — but a duplicate or foreign index is a protocol fault,
              // never something to reconcile by position.
              validateBatchResult(request, { vectors })

              const truncated: number[] = []
              for (const vector of vectors) {
                results[vector.index] = vector.values
                if (vector.truncated === true) truncated.push(vector.index)
              }

              residues.set(plan.batchIndex, {
                evidence: {
                  itemIndexes: settled.itemIndexes,
                  attempts: settled.attempts,
                  ...(settled.usage === undefined ? {} : { usage: settled.usage }),
                },
                warnings: [...settled.warnings, ...truncationWarnings(truncation, truncated)],
              })

              if (cache !== undefined) {
                for (const vector of vectors) {
                  const key = cacheKeys.get(vector.index)
                  if (key === undefined) continue
                  await writeEmbeddingCacheEntry(cache, key, {
                    values: vector.values,
                    space: prepared.spaceId,
                  })
                }
              }
              batchObservation.end('success')
            } catch (error: unknown) {
              batchObservation.end(terminalStatus(error), error)
              throw error
            }
          },
          { concurrency, signal: lease.signal },
        )

        if (outcome.aborted) {
          throw new EmbeddingError(
            'embedding call aborted before every batch was dispatched',
            EMBEDDING_ERROR_CODES.ABORTED,
            { provider, model, space: prepared.spaceId },
          )
        }

        const ordered = [...residues.keys()].sort((left, right) => left - right)
        const usage = aggregateEmbeddingUsage({
          inputCount: items.length,
          batches: ordered.map(index => residues.get(index)!.evidence),
        })
        const warnings = [
          ...ordered.flatMap(index => residues.get(index)!.warnings),
          ...usage.warnings,
        ]

        const vectors = results.map((values, index) => {
          if (values !== undefined) return values
          // Unreachable through the paths above: a settled plan covers every
          // pending item and the cache covers the rest. Kept as a hard failure
          // rather than a hole in the output, because a silently missing vector
          // would be indistinguishable from a zero vector downstream.
          throw new EmbeddingError(
            'embedding call produced no vector for an input',
            EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
            { provider, model, itemIndexes: [index] },
          )
        })

        return {
          vectors,
          space: prepared.spaceId,
          prepared,
          usage: usage.report,
          warnings: Object.freeze(warnings),
        }
      },
    )
  }

  return Object.freeze<EmbeddingModelHandle>({
    async embed(input: EmbedOneInput): Promise<EmbeddingResult> {
      // One item is a `Logical_Call` like any other; nothing about batching,
      // cache or usage aggregation is special-cased for it.
      const outcome = await runLogicalCall(
        input.purpose,
        [input.value],
        input.signal,
        input.expectedSpace ?? options.expectedSpace,
      )
      return Object.freeze<EmbeddingResult>({
        embedding: outcome.vectors[0]!,
        space: outcome.space,
        profile: outcome.prepared.profile,
        usage: outcome.usage,
        warnings: outcome.warnings,
      })
    },

    async embedMany(input: EmbedManyInput): Promise<EmbeddingManyResult> {
      const outcome = await runLogicalCall(
        input.purpose,
        input.values,
        input.signal,
        input.expectedSpace ?? options.expectedSpace,
      )
      return Object.freeze<EmbeddingManyResult>({
        embeddings: Object.freeze(outcome.vectors),
        space: outcome.space,
        profile: outcome.prepared.profile,
        usage: outcome.usage,
        warnings: outcome.warnings,
      })
    },
  })
}
