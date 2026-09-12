/**
 * The contract an embedding provider backend implements.
 *
 * Shape worth noting: ONE abstract method, deliberately mirroring `ModelAdapter`.
 * Everything else has a working default, so a minimal embedding adapter is a
 * single `embedBatch()` implementation, while a mature one overrides metadata,
 * catalog, profile, and call binding. `embeddingProfile()` in particular is NOT
 * abstract — it delegates to {@link defaultEmbeddingProfile} so that a route with
 * no catalog knowledge still produces a usable profile (DD-13).
 *
 * This class does NOT extend `ModelAdapter`. Generation and embedding share no
 * request vocabulary, and inheriting `stream()` would force every embedding
 * backend to implement a method it cannot honour.
 *
 * As with `ModelAdapter`, every metadata method takes the route key as its first
 * argument rather than reading instance state, so one instance can serve many
 * routes with different endpoints and credentials.
 *
 * @module ai-agent-sdk/core/embedding/adapter
 */

import type { ModelInvocationContext } from '../observation/report.ts'
import type { ProviderInfo } from '../contract/model-info.ts'
import type { ResolvedRetryPolicy } from '../contract/retry-policy.ts'
import type { EmbeddingModelInfo, ResolvedEmbeddingModelInfo } from './catalog.ts'
import { unknownEmbeddingModel } from './catalog.ts'
import type { ResolvedEmbeddingBatchLimits } from './limits.ts'
import { resolveBatchLimits } from './limits.ts'
import type { EmbeddingProfile, EmbeddingProfileInput, EmbeddingSpaceId } from './profile.ts'
import { defaultEmbeddingProfile, deriveSpaceId } from './profile.ts'
import type { EmbeddingBatchRequest } from './request.ts'
import type { EmbeddingBatchResult } from './result.ts'

/** Call configuration handed to {@link EmbeddingAdapter.prepareEmbeddingCall}. */
export interface PrepareEmbeddingOptions extends EmbeddingProfileInput {
  /** Caller overrides on the catalog's declared batch bounds. */
  readonly limits?: Partial<ResolvedEmbeddingBatchLimits>
}

/**
 * One adapter-owned embedding-resolution generation, bound to its dispatch call.
 *
 * The embedding counterpart of `PreparedAdapterCall`. Metadata, profile,
 * `spaceId`, and batch limits all come from the SAME capture as
 * {@link PreparedEmbeddingCall.embedBatch}, so dimensions can never be checked
 * against one configuration while the request goes out through another.
 */
export interface PreparedEmbeddingCall {
  /** Exact model metadata from the SAME generation as {@link embedBatch}. */
  readonly model: ResolvedEmbeddingModelInfo
  /** The `Embedding_Profile` this generation will actually produce vectors in. */
  readonly profile: EmbeddingProfile
  /** Canonical space identity derived from {@link profile}. */
  readonly spaceId: EmbeddingSpaceId
  /** From `embedding/limits.ts`, never from `composition/`. */
  readonly limits: ResolvedEmbeddingBatchLimits
  /** Dispatch through that generation, without re-reading dynamic connection facts. */
  embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult>
}

/**
 * Provider-wire adapter for this SDK's embedding vocabulary.
 *
 * Contract obligations on implementations:
 * - exactly one `Provider_Attempt` per `embedBatch()` call; retry is the runtime's;
 * - honour `batch.signal` promptly;
 * - carry the original input index onto every returned vector;
 * - raise a protocol error when a response breaks the contract, never infer;
 * - include the SDK's attribution headers on every provider request.
 */
export abstract class EmbeddingAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route this instance was registered under.
   * @returns detached display metadata whose `id` MUST equal `provider`.
   */
  providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * The retry policy this route owns.
   * @param _provider - a route this instance was registered under.
   * @returns a resolved policy, or `undefined` to accept the runtime defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * List embedding models this adapter can currently advertise for one route.
   *
   * ADVISORY only: absence from this list must never become a reason to reject a
   * request, because an adapter may accept ids it does not list.
   * @param _provider - one route owned by this adapter.
   * @returns discoverable models, in adapter-preferred order.
   */
  listEmbeddingModels(
    _provider: string,
    _signal?: AbortSignal,
  ): Promise<readonly EmbeddingModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Resolve all metadata available for one exact embedding model.
   *
   * NOT request validation — an unknown id resolves to a minimal all-`unknown`
   * descriptor rather than an error.
   * @param provider - one route owned by this adapter.
   * @param model - exact model id.
   * @param _signal - cancellation; async implementations must settle promptly after abort.
   */
  resolveEmbeddingModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<ResolvedEmbeddingModelInfo> {
    return Promise.resolve(unknownEmbeddingModel(provider, model))
  }

  /**
   * Declare the `Embedding_Profile` for one concrete call configuration.
   *
   * NOT abstract: the default derives a compatibility identity from
   * `${route}:${modelId}` when the catalog declares none, marks normalization
   * `'unknown'`, and applies no post-processing. That is what keeps this class at
   * exactly ONE abstract method. An adapter that owns the provider's real
   * statement about its embedding space MUST override.
   */
  embeddingProfile(
    model: ResolvedEmbeddingModelInfo,
    request: EmbeddingProfileInput,
  ): EmbeddingProfile {
    return defaultEmbeddingProfile(model, request)
  }

  /**
   * Bind resolved metadata to the exact configuration generation that will dispatch.
   *
   * Adapters whose connection facts come from mutable configuration MUST override
   * and snapshot those facts here.
   * @returns a frozen single-generation embedding entry point.
   */
  async prepareEmbeddingCall(
    provider: string,
    model: string,
    options: PrepareEmbeddingOptions,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedEmbeddingCall> {
    const resolved = await this.resolveEmbeddingModel(provider, model, signal)
    const profile = this.embeddingProfile(resolved, options)
    return Object.freeze({
      model: resolved,
      profile,
      // deriveSpaceId is synchronous: a canonical string, not a digest (DD-11).
      spaceId: deriveSpaceId(profile),
      limits: resolveBatchLimits(resolved, options.limits),
      embedBatch: (batch: EmbeddingBatchRequest, invocation = context) =>
        this.embedBatch(batch, invocation),
    })
  }

  /**
   * Perform EXACTLY ONE physical embedding request. The only required method.
   * @param batch - one `Physical_Batch`, already within the resolved limits.
   * @returns one vector per request item, each carrying its original index.
   */
  abstract embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult>
}
