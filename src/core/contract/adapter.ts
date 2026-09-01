/**
 * The contract a provider backend implements.
 *
 * Shape worth noting: ONE abstract method. Everything else has a working default,
 * so a minimal adapter is a single `stream()` implementation, while a fully
 * featured one overrides metadata, catalog, and generation binding. That keeps the
 * barrier to a new provider low without capping what a mature one can express.
 *
 * Also note that every metadata method takes the route key as its first argument
 * rather than reading instance state. One adapter instance can therefore serve
 * many routes  Ethe same Anthropic adapter can back both a first-party route and
 * a proxy route with different endpoints and credentials.
 *
 * @module ai-agent-sdk/core/contract/adapter
 */

import type { StreamChunk } from '../stream/chunk.ts'
import type { GenerateOptions } from './generate-options.ts'
import type { ModelInfo, ProviderInfo, ResolvedModelInfo } from './model-info.ts'
import type { ResolvedRetryPolicy } from './retry-policy.ts'

/**
 * One adapter-owned model-resolution generation, bound to its eventual stream call.
 *
 * This exists to close a real gap. Between "what can this model do?" and "send
 * the request", configuration can change. Without binding, a caller could resolve
 * capabilities against one endpoint and dispatch to another  Ecombining one
 * generation's answers with another's connection. The pair travels together here
 * so that cannot happen.
 */
export interface PreparedAdapterCall {
  /** Exact model metadata from the SAME generation as {@link stream}. */
  readonly model: ResolvedModelInfo
  /** Dispatch through that generation, without re-reading dynamic connection facts. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Provider-wire adapter for this SDK's message and stream vocabulary.
 *
 * Register implementations with `registry.registerAdapter(routes, adapter)`.
 *
 * Contract obligations on implementations:
 * - honour `options.signal` promptly;
 * - emit chunks per the protocol documented on {@link StreamChunk};
 * - include `attributionHeaders()` on every provider HTTP request.
 */
export abstract class ModelAdapter {
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
   * @returns a resolved policy, or `undefined` to accept the defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * List models this adapter can currently advertise for one route.
   *
   * ADVISORY only: an adapter may accept unlisted ids, and consumers must not
   * turn absence from this list into a request rejection.
   * @param _provider - one route owned by this adapter.
   * @returns discoverable models, in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly ModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Resolve all metadata available for one exact model.
   *
   * Independent of the advisory catalog, and NOT request validation  Ean unknown
   * id resolves to a minimal descriptor rather than an error.
   * @param provider - one route owned by this adapter.
   * @param model - exact model id.
   * @param _signal - cancellation; async implementations must settle promptly after abort.
   * @returns identity plus any context, default, and reasoning metadata.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<ResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Bind exact model metadata and the eventual dispatch to one generation.
   *
   * Adapters whose connection facts come from mutable configuration override this
   * and snapshot those facts here; the default is sufficient for a static one.
   * @param provider - registered route.
   * @param model - exact model id.
   * @param signal - cancellation for model resolution.
   * @returns metadata plus a one-generation stream entry point.
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * Stream one model call as raw chunks. The only required method.
   *
   * There is deliberately no non-streaming counterpart. A single code path cannot
   * drift from itself, and a caller wanting one value awaits the assembled
   * message instead.
   * @param options - the fully assembled request.
   * @returns the chunk stream, obeying the {@link StreamChunk} protocol.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
