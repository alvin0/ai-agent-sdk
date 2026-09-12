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
  type RetryPolicyConfig,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core'
import {
  EMBEDDING_ERROR_CODES,
  EmbeddingAdapter,
  EmbeddingError,
  defaultEmbeddingProfile,
  deriveSpaceId,
  resolveBatchLimits,
  validateBatchResult,
  type EmbeddingBatchRequest,
  type EmbeddingBatchResult,
  type EmbeddingModelInfo,
  type EmbeddingPostProcessing,
  type EmbeddingProfile,
  type EmbeddingProfileInput,
  type EmbeddingPurpose,
  type EmbeddingVector,
  type PrepareEmbeddingOptions,
  type PreparedEmbeddingCall,
  type ResolvedEmbeddingModelInfo,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  defineEmbeddingProviderPlugin,
  type ComposableEmbeddingProviderPlugin,
  type CredentialInput,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  captureTransportConnection,
  embeddingCatalogModelInfo,
  resolvedEmbeddingCatalogModelInfo,
  transportJson,
  type EmbeddingCatalogModel,
  type EmbeddingHttpConnection,
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

/** Revision of the `l2-renormalize` step this adapter performs. */
const POST_PROCESSING_REVISION = '1'

/** Applied when neither the caller nor the catalog says otherwise. */
const DEFAULT_RECIPE_REVISION = '1'

/** The one mapping from this SDK's purpose vocabulary to Gemini's `taskType`. */
const TASK_TYPES: Readonly<Record<EmbeddingPurpose, string>> = Object.freeze({
  'retrieval-query': 'RETRIEVAL_QUERY',
  'retrieval-document': 'RETRIEVAL_DOCUMENT',
})

const NEVER_ABORTED_SIGNAL = new AbortController().signal

const NULL_LOGGER: SdkLogger = Object.freeze({
  child: () => NULL_LOGGER,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
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

/** Configuration for {@link geminiEmbeddingAdapter} and {@link geminiEmbeddingPlugin}. */
export interface GeminiEmbeddingProviderOptions {
  /** Injected key or credential source; universal packages never read the environment. */
  readonly apiKey: CredentialInput
  /** Endpoint base; defaults to {@link GEMINI_EMBEDDING_BASE_URL}. */
  readonly baseUrl?: string
  /** Plugin id; defaults to `'gemini-embedding'`. */
  readonly id?: string
  /** Routes the plugin claims; defaults to `[id]`. */
  readonly routes?: readonly string[]
  /** Default model for the claimed route. */
  readonly defaultModel?: string | ModelTarget
  /** Declared embedding catalog; defaults to {@link GEMINI_EMBEDDING_MODELS}. */
  readonly models?: readonly EmbeddingCatalogModel[]
  /** Permit cleartext HTTP explicitly, for a trusted local endpoint only. */
  readonly allowInsecureHttp?: boolean
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxResponseChunks?: number
  readonly maxErrorBodyBytes?: number
  readonly requestLoggerTimeoutMs?: number
  readonly retryPolicy?: RetryPolicyConfig
  readonly fetch?: typeof globalThis.fetch
}

/** What the JSON pipeline hands back: the parsed body plus its correlation id. */
interface GeminiEmbedResponse {
  readonly payload: unknown
  readonly providerRequestId?: string
}

/** One request element of Gemini's `batchEmbedContents` body. */
interface GeminiEmbedRequest {
  readonly model: string
  readonly content: { readonly parts: readonly { readonly text: string }[] }
  readonly outputDimensionality?: number
  readonly [parameter: string]: unknown
}

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
  readonly #models: readonly EmbeddingCatalogModel[]
  readonly #retryPolicy: ResolvedRetryPolicy

  constructor(options: GeminiEmbeddingProviderOptions) {
    super()
    this.#options = Object.freeze({ ...options })
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
      normalization: postProcessing !== undefined
        ? 'unit-l2'
        : model.normalization.state === 'supported'
          ? model.normalization.value
          : 'unknown',
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
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedEmbeddingCall> {
    const resolved = await this.resolveEmbeddingModel(provider, model, signal)
    const profile = this.embeddingProfile(resolved, options)
    const connection = await this.#connect(signal, context)
    return Object.freeze({
      model: resolved,
      profile,
      spaceId: deriveSpaceId(profile),
      limits: resolveBatchLimits(resolved, options.limits),
      embedBatch: (batch: EmbeddingBatchRequest, invocation = context) =>
        this.#dispatch(connection, resolved, profile, batch, invocation),
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
    const connection = await this.#connect(batch.signal, context)
    return await this.#dispatch(connection, resolved, profile, batch, context)
  }

  /** Resolve the credential and bounds into one frozen snapshot. */
  async #connect(
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingHttpConnection> {
    const options = this.#options
    const apiKey = assertUsableApiKey(
      await resolveCredential(options.apiKey, signal, context),
      DISPLAY_NAME,
      'the `apiKey` option',
    )
    // Attribution headers are merged by the transport, so no embedding adapter
    // can forget them (Requirement 14.7).
    return captureTransportConnection<EmbeddingHttpConnection>({
      baseUrl: options.baseUrl ?? GEMINI_EMBEDDING_BASE_URL,
      headers: Object.freeze({ 'x-goog-api-key': apiKey }),
      models: this.#models,
      retryPolicy: this.#retryPolicy,
      ...(options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: options.allowInsecureHttp }),
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes }),
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
      ...(options.maxResponseChunks === undefined
        ? {}
        : { maxResponseChunks: options.maxResponseChunks }),
      ...(options.maxErrorBodyBytes === undefined
        ? {}
        : { maxErrorBodyBytes: options.maxErrorBodyBytes }),
      ...(options.requestLoggerTimeoutMs === undefined
        ? {}
        : { requestLoggerTimeoutMs: options.requestLoggerTimeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }, TRANSPORT_HEADERS)
  }

  /** One `Provider_Attempt`: build the body, send it, decode the response. */
  async #dispatch(
    connection: EmbeddingHttpConnection,
    model: ResolvedEmbeddingModelInfo,
    profile: EmbeddingProfile,
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
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

/** Resolve a literal key or a credential source, without caching the secret. */
async function resolveCredential(
  apiKey: CredentialInput,
  signal?: AbortSignal,
  context?: ModelInvocationContext,
): Promise<string> {
  if (typeof apiKey === 'string') return apiKey
  return await apiKey.resolve({
    signal: signal ?? NEVER_ABORTED_SIGNAL,
    logger: context?.logger ?? NULL_LOGGER,
  })
}

/** Accept both `gemini-embedding-001` and the `models/`-prefixed resource name. */
function bareModelId(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model
}

/**
 * Build one request element.
 *
 * `taskType` appears only when the route DECLARES a wire parameter for purpose,
 * and it is spelled with the declared parameter name. A route that declares
 * nothing gets the text verbatim — an undeclared parameter would be this adapter
 * inventing a mechanism (Requirement 7.3).
 */
function embedRequest(
  item: EmbeddingBatchRequest['items'][number],
  model: ResolvedEmbeddingModelInfo,
  batch: EmbeddingBatchRequest,
  modelId: string,
): GeminiEmbedRequest {
  const purposeHandling = model.purposeHandling
  const wireParameter = purposeHandling.state === 'supported'
    && purposeHandling.value.kind === 'wire-parameter'
    ? purposeHandling.value.parameter
    : undefined
  const width = outputDimensionality(model, batch)
  return {
    model: `models/${modelId}`,
    content: {
      parts: item.contentParts.map(part => ({ text: part.text })),
    },
    ...(wireParameter === undefined ? {} : { [wireParameter]: TASK_TYPES[batch.purpose] }),
    ...(width === undefined ? {} : { outputDimensionality: width }),
  }
}

/**
 * `outputDimensionality` travels only when the route declares selectable widths.
 *
 * With an `unknown` declaration there is nothing saying the parameter exists, and
 * sending it anyway would make a capability claim on the route's behalf
 * (Requirement 14.4).
 */
function outputDimensionality(
  model: ResolvedEmbeddingModelInfo,
  batch: EmbeddingBatchRequest,
): number | undefined {
  if (batch.dimensions === undefined) return undefined
  return model.dimensions.state === 'supported' ? batch.dimensions : undefined
}

/**
 * The recorded step a narrower-than-native vector needs.
 *
 * Gemini documents that only the native width comes back unit-length, so a
 * narrower request declares `l2-renormalize` in the profile and this adapter
 * performs exactly that. It is NOT a slice or a pad: the model produced the
 * narrower vector itself (Requirement 9.8).
 */
function postProcessingFor(
  model: ResolvedEmbeddingModelInfo,
  dimensions: number,
): EmbeddingPostProcessing | undefined {
  if (model.defaultDimensions.state !== 'supported') return undefined
  const native = model.defaultDimensions.value
  if (dimensions <= 0 || dimensions >= native) return undefined
  return Object.freeze({ kind: 'l2-renormalize' as const, revision: POST_PROCESSING_REVISION })
}

/**
 * Turn one response into vectors, positionally, with the count checked.
 *
 * Order: structural shape, then count, then the SHARED
 * {@link validateBatchResult} — so the same malformed response yields the same
 * code here as it does for any other provider — and only then the recorded
 * post-processing step.
 */
function decodeBatch(
  batch: EmbeddingBatchRequest,
  profile: EmbeddingProfile,
  received: GeminiEmbedResponse,
): EmbeddingBatchResult {
  const embeddings = readEmbeddings(batch, received.payload)
  if (embeddings.length !== batch.items.length) {
    throw new EmbeddingError(
      `Gemini returned ${embeddings.length} embeddings for ${batch.items.length} inputs`,
      EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
      { provider: batch.provider, model: batch.model },
    )
  }
  // Positional mapping: the response carries no index, so the index comes from
  // request order — which is only sound because the length was just checked.
  const vectors = embeddings.map((embedding, position) => Object.freeze<EmbeddingVector>({
    index: batch.items[position]!.index,
    values: readValues(batch, embedding, batch.items[position]!.index),
  }))
  const raw: EmbeddingBatchResult = Object.freeze({
    vectors: Object.freeze(vectors),
    ...(received.providerRequestId === undefined
      ? {}
      : { providerRequestId: received.providerRequestId }),
  })
  validateBatchResult(batch, raw)
  // `batchEmbedContents` reports no usage at all, so no `usage` field is set on
  // the result — not an empty object and not a zero. The absence is what the
  // runtime aggregator reads to report `status: 'missing'` plus a
  // `usage-unreported` warning, and stating it here as well would double the
  // warning for one batch (Requirement 16.2).
  return applyPostProcessing(raw, profile)
}

/** Read `embeddings[]`, refusing any other shape rather than guessing at it. */
function readEmbeddings(batch: EmbeddingBatchRequest, payload: unknown): readonly unknown[] {
  if (typeof payload !== 'object' || payload === null) {
    throw malformed(batch, 'Gemini response is not a JSON object')
  }
  const embeddings = Reflect.get(payload, 'embeddings')
  if (!Array.isArray(embeddings)) {
    throw malformed(batch, 'Gemini response carries no embeddings array')
  }
  return embeddings as readonly unknown[]
}

/** Read one `values[]`, leaving every number exactly as the provider sent it. */
function readValues(
  batch: EmbeddingBatchRequest,
  embedding: unknown,
  index: number,
): readonly number[] {
  if (typeof embedding !== 'object' || embedding === null) {
    throw malformed(batch, 'Gemini embedding entry is not an object', index)
  }
  const values = Reflect.get(embedding, 'values')
  if (!Array.isArray(values)) {
    throw malformed(batch, 'Gemini embedding entry carries no values array', index)
  }
  return Object.freeze([...values as readonly number[]])
}

/** One place the structural-failure code is spelled. */
function malformed(
  batch: EmbeddingBatchRequest,
  message: string,
  index?: number,
): EmbeddingError {
  return new EmbeddingError(message, EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED, {
    provider: batch.provider,
    model: batch.model,
    ...(index === undefined ? {} : { itemIndexes: [index] }),
  })
}

/**
 * Perform the step the profile declares, and nothing else.
 *
 * A profile with no `postProcessing` returns the provider's values untouched, so
 * the vectors a caller receives are faithful to what came back (Property 22). A
 * zero vector has no direction to preserve, so it is passed through rather than
 * turned into `NaN`.
 */
function applyPostProcessing(
  result: EmbeddingBatchResult,
  profile: EmbeddingProfile,
): EmbeddingBatchResult {
  if (profile.postProcessing?.kind !== 'l2-renormalize') return result
  return Object.freeze({
    ...result,
    vectors: Object.freeze(result.vectors.map(vector => Object.freeze<EmbeddingVector>({
      ...vector,
      values: l2Renormalize(vector.values),
    }))),
  })
}

/** Scale a vector to unit L2 length. */
function l2Renormalize(values: readonly number[]): readonly number[] {
  let sum = 0
  for (const value of values) sum += value * value
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return values
  return Object.freeze(values.map(value => value / norm))
}

/** A string default model needs exactly one route to belong to. */
function defaultModelTarget(
  value: string | ModelTarget | undefined,
  routes: readonly string[],
): { readonly defaultModel?: ModelTarget } {
  if (value === undefined) return {}
  if (typeof value !== 'string') return { defaultModel: value }
  if (routes.length !== 1) {
    throw new TypeError('A string defaultModel requires exactly one Gemini embedding route')
  }
  return { defaultModel: Object.freeze({ provider: routes[0]!, id: value }) }
}
