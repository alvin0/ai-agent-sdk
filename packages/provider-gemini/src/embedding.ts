import { DEFAULT_RECIPE_REVISION } from './embedding-support.ts'
import { resolveCredential, bareModelId, embedRequest, postProcessingFor, decodeBatch, defaultModelTarget,
  profileNormalization, embeddingTransportOptions ,
} from './embedding-support.ts'
import type { GeminiEmbeddingProviderOptions  } from './embedding-types.ts'
export type { GeminiEmbeddingProviderOptions } from './embedding-types.ts'
/**
 * `Gemini_Embedding_Adapter`: Gemini's `batchEmbedContents` endpoint expressed as
 * an `Embedding_Adapter`.
 *
 * Deliberately separate from `./adapter.ts`: nothing here imports
 * `geminiInteractionsProtocol`, and nothing there imports this module. Generation
 * and embedding share the same credential shape and the same HTTP transport, and
 * that is all they share — a request vocabulary in common would be the conflation
 * Requirement 14.2 rules out.
 *
 * Three Gemini specifics shape this file, and each one is stated rather than
 * inferred:
 *
 *  - **Purpose is a wire parameter.** `taskType` exists, so `purpose` translates
 *    into it — but only when the route DECLARES that mechanism. A route that
 *    declares nothing gets the text sent verbatim and no invented parameter
 *    (Requirement 7.3).
 *  - **A narrower vector is a model mechanism plus a recorded step.**
 *    `outputDimensionality` asks the model for a narrower vector; Gemini
 *    documents that a narrower vector is no longer unit-length, so the profile
 *    declares `postProcessing: { kind: 'l2-renormalize', revision: '1' }` and this
 *    adapter performs exactly that step. Nothing here slices or pads a vector
 *    (Requirement 9.8).
 *  - **Mapping is positional.** `batchEmbedContents` returns
 *    `{ embeddings: [{ values }] }` with no index, so the index is assigned by
 *    this adapter from request order, and the count is checked rather than
 *    assumed.
 *
 * @module ai-agent-sdk/providers/gemini/embedding
 */

import {
  assertUsableApiKey,
  resolveRetryPolicy,
  type ModelInvocationContext,
  type ProviderInfo,
  type ResolvedRetryPolicy,
} from '@alvin0/ai-agent-sdk-core'
import {
  EMBEDDING_ERROR_CODES,
  EmbeddingAdapter,
  EmbeddingError,
  defaultEmbeddingProfile,
  deriveSpaceId,
  resolveBatchLimits,
  type EmbeddingBatchRequest,
  type EmbeddingBatchResult,
  type EmbeddingModelInfo,
  type EmbeddingProfile,
  type EmbeddingProfileInput,
  type PrepareEmbeddingOptions,
  type PreparedEmbeddingCall,
  type ResolvedEmbeddingModelInfo,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  defineEmbeddingProviderPlugin,
  type ComposableEmbeddingProviderPlugin,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  captureTransportConnection,
  endpointHeaders,
  embeddingCatalogModelInfo,
  resolvedEmbeddingCatalogModelInfo,
  transportJson,
  type EmbeddingCatalogModel,
  type EmbeddingHttpConnection,
  type HeaderContext,
} from '@alvin0/ai-agent-sdk-provider-http'

/** Google Generative Language API v1beta base; the adapter appends the model path. */
export const GEMINI_EMBEDDING_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** Name used in every diagnostic this module raises. */
const DISPLAY_NAME = 'Gemini'

/** Header layer the JSON pipeline owns for this route. */
const TRANSPORT_HEADERS = Object.freeze({
  'content-type': 'application/json',
  accept: 'application/json',
})

/**
 * The Gemini embedding generations this package declares.
 *
 * Unlike the generation catalog, an embedding catalog entry cannot be omitted
 * entirely: `compatibilityIdentity` is a claim about an embedding space that only
 * the route can make, and Requirement 14.6 puts that claim on this adapter. The
 * identity names the GENERATION, so `gemini-embedding-001` and a future
 * `gemini-embedding-2` are detected as incompatible even at equal width. Pass
 * `models` to override or extend this list.
 */
export const GEMINI_EMBEDDING_MODELS: readonly EmbeddingCatalogModel[] = Object.freeze([
  Object.freeze({
    id: 'gemini-embedding-001',
    name: 'Gemini Embedding 001',
    description: 'Gemini text embedding with selectable output dimensionality.',
    dimensions: Object.freeze([3072, 1536, 768]),
    defaultDimensions: 3072,
    maxInputTokens: 2048,
    maxBatchItems: 100,
    purposeHandling: Object.freeze({ kind: 'wire-parameter' as const, parameter: 'taskType' }),
    compatibilityIdentity: 'google:gemini-embedding-001',
  }),
])

/**
 * The Gemini `batchEmbedContents` adapter.
 *
 * Every metadata method takes the route key, so one instance serves every route
 * the plugin claims. Connection facts are captured once per operation in
 * {@link prepareEmbeddingCall}, which is what keeps a credential from travelling
 * to a URL from a different configuration generation.
 */
class GeminiEmbeddingAdapter extends EmbeddingAdapter {
  readonly #options: GeminiEmbeddingProviderOptions
  readonly #headers: (ctx: HeaderContext) => Readonly<Record<string, string>>
  readonly #models: readonly EmbeddingCatalogModel[]
  readonly #retryPolicy: ResolvedRetryPolicy

  constructor(options: GeminiEmbeddingProviderOptions) {
    super()
    this.#options = Object.freeze({ ...options })
    this.#headers = endpointHeaders(options.headers)
    this.#models = Object.freeze([...(options.models ?? GEMINI_EMBEDDING_MODELS)])
    this.#retryPolicy = resolveRetryPolicy(options.retryPolicy, 'retryPolicy')
  }

  override providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: DISPLAY_NAME }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.#retryPolicy
  }

  override listEmbeddingModels(
    provider: string,
    _signal?: AbortSignal,
  ): Promise<readonly EmbeddingModelInfo[]> {
    return Promise.resolve(Object.freeze(
      this.#models.map(model => embeddingCatalogModelInfo(provider, model)),
    ))
  }

  override resolveEmbeddingModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<ResolvedEmbeddingModelInfo> {
    return Promise.resolve(resolvedEmbeddingCatalogModelInfo(provider, model, this.#models))
  }

  /**
   * Declare the real Gemini profile instead of accepting the generic default.
   *
   * Two statements the default cannot make: the compatibility identity is the
   * route's declaration about a GENERATION, and asking for a narrower vector adds
   * a recorded `l2-renormalize` step which this adapter then actually performs.
   */
  override embeddingProfile(
    model: ResolvedEmbeddingModelInfo,
    request: EmbeddingProfileInput,
  ): EmbeddingProfile {
    const base = defaultEmbeddingProfile(model, request)
    const postProcessing = postProcessingFor(model, base.dimensions)
    return Object.freeze({
      ...base,
      compatibilityIdentity: model.compatibilityIdentity.state === 'supported'
        ? model.compatibilityIdentity.value
        : `google:${model.id}`,
      // Truthful either way: `unit-l2` only where this adapter normalizes, and
      // otherwise whatever the route declared — never inferred from the width.
      normalization: profileNormalization(model, postProcessing),
      documentRecipeRevision: request.documentRecipeRevision ?? DEFAULT_RECIPE_REVISION,
      queryRecipeRevision: request.queryRecipeRevision ?? DEFAULT_RECIPE_REVISION,
      ...(postProcessing === undefined ? {} : { postProcessing }),
    })
  }

  /**
   * Capture the endpoint, the credential and the catalog together, once.
   *
   * The connection is read here and never re-read per batch, so every batch of
   * one `Logical_Call` goes out through the same generation of configuration
   * that its dimensions were checked against.
   */
  override async prepareEmbeddingCall(
    provider: string,
    model: string,
    options: PrepareEmbeddingOptions,
    ...invocation: [signal?: AbortSignal, context?: ModelInvocationContext]
  ): Promise<PreparedEmbeddingCall> {
    const [signal, context] = invocation
    const resolved = await this.resolveEmbeddingModel(provider, model, signal)
    const profile = this.embeddingProfile(resolved, options)
    const connection = await this.#connect(provider, signal, context)
    return Object.freeze({
      model: resolved,
      profile,
      spaceId: deriveSpaceId(profile),
      limits: resolveBatchLimits(resolved, options.limits),
      embedBatch: (batch: EmbeddingBatchRequest, invocation = context) =>
        this.#dispatch(connection, { model: resolved, profile }, batch, invocation),
    })
  }

  /**
   * Perform exactly one `batchEmbedContents` request.
   *
   * Usable directly, in which case the catalog and connection are resolved for
   * this batch alone; `prepareEmbeddingCall` is the path that binds one snapshot
   * to a whole logical call.
   */
  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    const resolved = await this.resolveEmbeddingModel(batch.provider, batch.model, batch.signal)
    const profile = this.embeddingProfile(resolved, {
      ...(batch.dimensions === undefined ? {} : { dimensions: batch.dimensions }),
    })
    const connection = await this.#connect(batch.provider, batch.signal, context)
    return await this.#dispatch(connection, { model: resolved, profile }, batch, context)
  }

  /** Resolve the credential and bounds into one frozen snapshot. */
  async #connect(
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingHttpConnection> {
    const options = this.#options
    const extraHeaders = this.#headers({
      provider,
      ...(context?.agentId === undefined ? {} : { agentId: context.agentId }),
      ...(signal === undefined ? {} : { signal }),
    })
    const apiKey = assertUsableApiKey(
      await resolveCredential(options.apiKey, signal, context),
      DISPLAY_NAME,
      'the `apiKey` option',
    )
    // Attribution headers are merged by the transport, so no embedding adapter
    // can forget them (Requirement 14.7).
    return captureTransportConnection<EmbeddingHttpConnection>({
      baseUrl: options.baseUrl ?? GEMINI_EMBEDDING_BASE_URL,
      headers: Object.freeze({ ...extraHeaders, 'x-goog-api-key': apiKey }),
      models: this.#models,
      retryPolicy: this.#retryPolicy,
      ...embeddingTransportOptions(options),
    }, TRANSPORT_HEADERS)
  }

  /** One `Provider_Attempt`: build the body, send it, decode the response. */
  async #dispatch(
    connection: EmbeddingHttpConnection,
    facts: { model: ResolvedEmbeddingModelInfo; profile: EmbeddingProfile },
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    const { model, profile } = facts
    if (batch.truncation === 'allow') {
      throw new EmbeddingError(
        'Gemini batchEmbedContents exposes no truncation parameter',
        EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED,
        { provider: batch.provider, model: batch.model },
      )
    }
    const modelId = bareModelId(batch.model)
    const body = { requests: batch.items.map(item => embedRequest(item, model, batch, modelId)) }
    const encoded = JSON.stringify(body)
    // The transport chain owns transport failures and normalizes anything thrown
    // inside `decode` into a ModelError, which would flatten this adapter's
    // embedding codes. So `decode` only extracts the payload, and contract
    // validation runs here, where an EmbeddingError reaches the caller intact.
    const received = await transportJson({
      connection,
      displayName: DISPLAY_NAME,
      provider: batch.provider,
      model: batch.model,
      path: `/models/${encodeURIComponent(modelId)}:batchEmbedContents`,
      accept: 'application/json',
      body: {
        value: body,
        encoded,
        bytes: new TextEncoder().encode(encoded).length,
      },
      ...(batch.signal === undefined ? {} : { signal: batch.signal }),
      ...(context === undefined ? {} : { context }),
    }, (session, payload) => Object.freeze({
      payload,
      ...(session.providerRequestId === undefined
        ? {}
        : { providerRequestId: session.providerRequestId }),
    }))
    return decodeBatch(batch, profile, received)
  }
}

/**
 * Create the Gemini embedding adapter.
 *
 * No I/O happens here: the credential is resolved per operation, not at
 * construction.
 * @param options - route configuration.
 * @returns an adapter registrable under any number of routes.
 */
export function geminiEmbeddingAdapter(
  options: GeminiEmbeddingProviderOptions,
): EmbeddingAdapter {
  return new GeminiEmbeddingAdapter(options)
}

/**
 * Create the Gemini `Embedding_Provider_Plugin`.
 *
 * Its `kind` is `'embedding-provider-plugin'`, so a generation host never
 * mistakes it for {@link geminiPlugin} and neither plugin needs a version bump
 * because of the other (Requirement 11.1).
 * @param options - route configuration.
 * @returns an inert plugin; registration happens during runtime activation.
 */
export function geminiEmbeddingPlugin(
  options: GeminiEmbeddingProviderOptions,
): ComposableEmbeddingProviderPlugin & { readonly family: 'gemini' } {
  const id = options.id ?? 'gemini-embedding'
  const routes = Object.freeze([...(options.routes ?? [id])])
  const adapter = geminiEmbeddingAdapter(options)
  return defineEmbeddingProviderPlugin({
    id,
    family: 'gemini',
    displayName: DISPLAY_NAME,
    routes,
    ...defaultModelTarget(options.defaultModel, routes),
    setup(registrar) {
      const remove = registrar.registerEmbeddingAdapter(adapter)
      return () => {
        remove()
        return undefined
      }
    },
  }) as ComposableEmbeddingProviderPlugin & { readonly family: 'gemini' }
}
