/**
 * Fall back to a build of the SAME adapter without an optional wire field,
 * permanently, the first time a dispatch is rejected in a way that names it.
 *
 * Exists for opportunistic fields this SDK adds when a caller opts in — a
 * caching hint, for instance — that the OFFICIAL vendor accepts but a
 * compatible gateway behind the same adapter option may not. Decision 7
 * (this workspace's redesign plan) rules out guessing which gateways support
 * such a field ahead of time; this is the alternative that costs nothing
 * when the field IS understood and self-heals, once, the one time it is
 * not — rather than failing every call to that gateway forever.
 *
 * @module ai-agent-sdk/providers/configurable/field-fallback
 */

import {
  ModelAdapter,
  type GenerateOptions,
  type ModelCatalogOptions,
  type ModelCatalogSnapshot,
  type ModelInfo,
  type ModelInvocationContext,
  type PreparedAdapterCall,
  type ProviderInfo,
  type ResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@alvin0/ai-agent-sdk-core'

export interface FieldFallbackOptions {
  /**
   * Tests one dispatch failure to decide whether the optional field caused
   * it. Consulted only up to the first `true`: once the fallback trips, this
   * adapter instance never tries the field again, so a persistently failing
   * route costs one extra round trip total, not one per call.
   */
  readonly isFieldRejection: (error: unknown) => boolean
}

/**
 * Delegates to `withField` until a dispatch fails in a way
 * `isFieldRejection` recognizes, then delegates to `withoutField` for the
 * rest of this instance's lifetime — including the call that just failed,
 * retried transparently so the caller never sees the rejection.
 *
 * Metadata methods (`resolveModel`, `listModels`, `modelCatalog`,
 * `providerInfo`, `providerRetryPolicy`) always read from `withField`: the
 * two builds differ only in the one wire field this wraps, never in what
 * models or capabilities the route reports.
 */
export class FieldFallbackAdapter extends ModelAdapter {
  readonly #withField: ModelAdapter
  readonly #withoutField: ModelAdapter
  readonly #isFieldRejection: (error: unknown) => boolean
  #disabled = false

  constructor(withField: ModelAdapter, withoutField: ModelAdapter, options: FieldFallbackOptions) {
    super()
    this.#withField = withField
    this.#withoutField = withoutField
    this.#isFieldRejection = options.isFieldRejection
  }

  override providerInfo(provider: string): ProviderInfo {
    return this.#withField.providerInfo(provider)
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.#withField.providerRetryPolicy(provider)
  }

  override listModels(provider: string, signal?: AbortSignal): Promise<readonly ModelInfo[]> {
    return this.#withField.listModels(provider, signal)
  }

  override modelCatalog(provider: string, options: ModelCatalogOptions = {}): Promise<ModelCatalogSnapshot> {
    return this.#withField.modelCatalog(provider, options)
  }

  override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return this.#withField.resolveModel(provider, model, signal)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedAdapterCall> {
    if (this.#disabled) return this.#withoutField.prepareCall(provider, model, signal, context)
    const prepared = await this.#withField.prepareCall(provider, model, signal, context)
    return {
      model: prepared.model,
      stream: (options, invocation) => this.#dispatch(
        (o, c) => prepared.stream(o, c),
        () => this.#withoutField.prepareCall(provider, model, signal, context)
          .then(fallback => (o: GenerateOptions, c?: ModelInvocationContext) => fallback.stream(o, c)),
        options, invocation,
      ),
    }
  }

  override stream(options: GenerateOptions, context?: ModelInvocationContext): AsyncIterable<StreamChunk> {
    if (this.#disabled) return this.#withoutField.stream(options, context)
    return this.#dispatch(
      (o, c) => this.#withField.stream(o, c),
      () => Promise.resolve((o: GenerateOptions, c?: ModelInvocationContext) => this.#withoutField.stream(o, c)),
      options, context,
    )
  }

  /**
   * Run one dispatch, and on a recognized field rejection, disable the field
   * permanently and re-dispatch through `fallback` — transparently, before
   * the caller has seen anything but the fallback's own output.
   *
   * Safe because a field rejection is always a non-2xx response the shared
   * HTTP chain throws BEFORE any chunk streams (`withTransportSession` in
   * `provider-http`'s transport layer): nothing from the failed attempt ever
   * reaches this generator's consumer, so retrying from scratch never
   * duplicates output.
   */
  async *#dispatch(
    primary: (options: GenerateOptions, context?: ModelInvocationContext) => AsyncIterable<StreamChunk>,
    prepareFallback: () => Promise<
      (options: GenerateOptions, context?: ModelInvocationContext) => AsyncIterable<StreamChunk>
    >,
    options: GenerateOptions,
    context?: ModelInvocationContext,
  ): AsyncGenerator<StreamChunk> {
    // A prepared call can outlive the moment at which another call disables
    // the field. Re-check here, when iteration actually starts, so that stale
    // prepared calls do not resurrect a field the route already rejected.
    if (this.#disabled) {
      const fallback = await prepareFallback()
      yield* fallback(options, context)
      return
    }
    try {
      yield* primary(options, context)
    } catch (error) {
      // More than one request may have been in flight when the gateway rejected
      // the field. Every recognized rejection still needs its own transparent
      // fallback, even if another request won the race to flip #disabled.
      if (!this.#isFieldRejection(error)) throw error
      this.#disabled = true
      const fallback = await prepareFallback()
      yield* fallback(options, context)
    }
  }
}
