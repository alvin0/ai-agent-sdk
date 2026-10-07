import { resolveApiKey, embeddingTransportOptions  } from './embedding-connection.ts'
import { decodeEmbeddingResponse, itemInput } from './embedding-response.ts'
import type { OpenAiEmbeddingProviderOptions   } from './embedding-types.ts'
export type { OpenAiEmbeddingProviderOptions } from './embedding-types.ts'
/**
 * The OpenAI embeddings endpoint: `POST {baseUrl}/embeddings`.
 *
 * Deliberately a separate module from {@link ./adapter.ts}: it shares no protocol,
 * no dialect and no request vocabulary with `openAiResponsesProtocol`, and wiring
 * embedding through the generation pipeline would mean one of the two shapes
 * standing in for the other (Requirement 14.1). What the two DO share is the
 * transport — the fused signal, the redirect guard, the attempt ledger, the
 * attribution headers — because that chain is where a missing step is expensive.
 *
 * Three facts about this endpoint decide most of what is here, and each has a
 * plausible-looking wrong answer:
 *
 * - **There is no purpose parameter.** A route declares
 *   `purposeHandling: 'unsupported'` and this adapter sends the caller's text
 *   verbatim. Inventing a `"query: "` prefix would change every vector the caller
 *   gets while looking like a helpful default (Requirement 7.5).
 * - **There is no truncation parameter.** `truncation: 'allow'` is therefore
 *   refused with `EMBEDDING_TRUNCATION_UNSUPPORTED` rather than accepted and
 *   quietly not honoured (Requirement 9.7).
 * - **`dimensions` is a model-line capability, not an endpoint one.** It goes on
 *   the wire only when the route DECLARES the widths it supports; an `unknown`
 *   catalog is not a licence to send a parameter an endpoint may reject
 *   (Requirement 14.4).
 *
 * `baseUrl` is configurable because a self-hosted OpenAI-compatible endpoint is
 * the only mechanism this needs (Requirement 15.1). What it is NOT is an
 * inference: compatibility is a profile someone declared through
 * `EmbeddingCatalogModel`, never something read off the path, and a cleartext
 * `http://` base still requires `allowInsecureHttp` (Requirements 15.3, 15.5).
 *
 * @module ai-agent-sdk/providers/openai/embedding
 */

import { resolveRetryPolicy  } from '@alvin0/ai-agent-sdk-core'
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
  type ModelInvocationContext,
  type ProviderInfo,
  type ResolvedRetryPolicy,
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
import { OPENAI_BASE_URL   } from './adapter.ts'

/** Display name used in every diagnostic this module raises. */
const DISPLAY_NAME = 'OpenAI'

/** Path appended to the configured base. */
const EMBEDDINGS_PATH = '/embeddings'

/** Media type this endpoint answers with, and the only one accepted back. */
const JSON_MEDIA_TYPE = 'application/json'

/**
 * The one encoding this adapter asks for.
 *
 * Base64 would halve the bytes on the wire and cost a decode step that could
 * silently reorder or requantise values; float arrays are what the contract's
 * fidelity rule (Requirement 14.8) is cheapest to keep.
 */
const ENCODING_FORMAT = 'float'

/**
 * Compatibility identity prefix for an OpenAI embedding model line.
 *
 * Route-independent on purpose: two routes pointing at the same model line — the
 * public API and a mirror of it — produce vectors in the SAME space, so keying
 * the identity on the route name would make them look incompatible.
 */
const IDENTITY_PREFIX = 'openai'

/**
 * `POST /embeddings` as an {@link EmbeddingAdapter}.
 *
 * Private: the exported surface is {@link openAiEmbeddingAdapter}, so this class
 * can change shape without a caller having come to depend on it.
 */
class OpenAiEmbeddingAdapter extends EmbeddingAdapter {
  private readonly baseUrl: string
  private readonly models: readonly EmbeddingCatalogModel[]
  private readonly retry: ResolvedRetryPolicy
  private readonly headers: (ctx: HeaderContext) => Readonly<Record<string, string>>

  constructor(private readonly options: OpenAiEmbeddingProviderOptions) {
    super()
    this.headers = endpointHeaders(options.headers, {
      ...(options.organization === undefined ? {} : { 'openai-organization': options.organization }),
      ...(options.project === undefined ? {} : { 'openai-project': options.project }),
    })
    this.baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '')
    this.models = Object.freeze([...(options.models ?? [])])
    this.retry = resolveRetryPolicy(options.retryPolicy, 'openAiEmbedding.retryPolicy')
  }

  override providerInfo(provider: string): ProviderInfo {
    return { id: provider, name: DISPLAY_NAME }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retry
  }

  override listEmbeddingModels(
    provider: string,
    signal?: AbortSignal,
  ): Promise<readonly EmbeddingModelInfo[]> {
    signal?.throwIfAborted()
    return Promise.resolve(Object.freeze(
      this.models.map(model => embeddingCatalogModelInfo(provider, model)),
    ))
  }

  override resolveEmbeddingModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ResolvedEmbeddingModelInfo> {
    signal?.throwIfAborted()
    return Promise.resolve(resolvedEmbeddingCatalogModelInfo(provider, model, this.models))
  }

  /**
   * States what this model line declares about its embedding space.
   *
   * Overridden rather than inherited because the default answer is derived from
   * `${route}:${modelId}`, which makes one model line look like two spaces when
   * it is reachable through two routes. Two things differ here: the identity is
   * the model line's (see {@link IDENTITY_PREFIX}), and normalization is reported
   * only when the ROUTE declared it — never inferred from OpenAI's reputation for
   * returning unit vectors (Requirements 6.1, 6.3).
   */
  override embeddingProfile(
    model: ResolvedEmbeddingModelInfo,
    request: EmbeddingProfileInput,
  ): EmbeddingProfile {
    const base = defaultEmbeddingProfile(model, request)
    return Object.freeze({
      ...base,
      compatibilityIdentity: model.compatibilityIdentity.state === 'supported'
        ? model.compatibilityIdentity.value
        : `${IDENTITY_PREFIX}:${model.id}`,
      normalization: model.normalization.state === 'supported'
        ? model.normalization.value
        : base.normalization,
    })
  }

  /**
   * Captures endpoint, credential and bounds ONCE, then binds dispatch to that
   * capture.
   *
   * Overridden because this adapter's connection facts come from configuration
   * and a credential resolved per operation: reading them again inside
   * `embedBatch()` would let a rotating secret pair with another generation's URL,
   * and would let dimensions be validated against one catalog while the request
   * went out under another (Requirements 2.2, 2.3, 2.4).
   */
  override async prepareEmbeddingCall(
    provider: string,
    model: string,
    options: PrepareEmbeddingOptions,
    ...invocation: [signal?: AbortSignal, context?: ModelInvocationContext]
  ): Promise<PreparedEmbeddingCall> {
    const [signal, context] = invocation
    const connection = await this.connect(provider, signal, context)
    const resolved = resolvedEmbeddingCatalogModelInfo(provider, model, connection.models)
    const profile = this.embeddingProfile(resolved, options)
    return Object.freeze({
      model: resolved,
      profile,
      spaceId: deriveSpaceId(profile),
      limits: resolveBatchLimits(resolved, options.limits),
      embedBatch: (batch: EmbeddingBatchRequest, invocation = context) =>
        this.dispatch(connection, resolved, batch, invocation),
    })
  }

  /**
   * One `Physical_Batch`, one `Provider_Attempt`.
   *
   * Reachable directly for an adapter used without a prepared call; the shared
   * path is {@link dispatch}, so both routes send the same body under the same
   * guards.
   */
  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    const connection = await this.connect(batch.provider, batch.signal, context)
    const model = resolvedEmbeddingCatalogModelInfo(
      batch.provider,
      batch.model,
      connection.models,
    )
    return this.dispatch(connection, model, batch, context)
  }

  /** Everything one embedding request needs, read together, once per operation. */
  private async connect(
    provider: string,
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingHttpConnection> {
    const extraHeaders = this.headers({
      provider,
      ...(context?.agentId === undefined ? {} : { agentId: context.agentId }),
      ...(signal === undefined ? {} : { signal }),
    })
    const token = await resolveApiKey(this.options.apiKey, signal, context)
    // The credential and the endpoint-scoped account headers travel together as
    // the auth layer; the transport merges its own layer and attribution on top,
    // which is what makes attribution unforgettable (Requirement 14.7).
    const headers: Record<string, string> = { ...extraHeaders, authorization: `Bearer ${token}` }
    return Object.freeze({
      baseUrl: this.baseUrl,
      headers: Object.freeze(headers),
      sensitiveHeaderNames: Object.freeze(Object.keys(headers)),
      models: this.models,
      retryPolicy: this.retry,
      ...embeddingTransportOptions(this.options),
    })
  }

  /** Serialize, send through the shared chain, and map the parsed body back. */
  private async dispatch(
    connection: EmbeddingHttpConnection,
    model: ResolvedEmbeddingModelInfo,
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    if (batch.truncation === 'allow') {
      // Accepting this would promise a behaviour nothing on this wire can express.
      throw new EmbeddingError(
        `${DISPLAY_NAME} embeddings exposes no truncation parameter`,
        EMBEDDING_ERROR_CODES.TRUNCATION_UNSUPPORTED,
        { provider: batch.provider, model: batch.model },
      )
    }

    const body: Record<string, unknown> = {
      model: batch.model,
      // One element per item, in item order. The purpose does NOT appear here:
      // this endpoint has no parameter for it and no prefix is invented.
      input: batch.items.map(itemInput),
      encoding_format: ENCODING_FORMAT,
    }
    // Declared widths only. An `unknown` capability states nothing, and sending a
    // parameter on the strength of nothing is how a compatible endpoint 400s.
    if (batch.dimensions !== undefined && model.dimensions.state === 'supported') {
      body['dimensions'] = batch.dimensions
    }

    const encoded = JSON.stringify(body)
    // `decode` extracts the payload and NOTHING else. The shared chain normalizes
    // anything thrown inside `decode` through `normalizeHttpBoundaryError`, which
    // has no data twin to read off an `EmbeddingError` and would flatten every
    // stable embedding code into `ModelError{code:'UNKNOWN'}`. Validating after
    // `transportJson` returns is what lets `EMBEDDING_VECTOR_COUNT_MISMATCH` and
    // its siblings reach the caller as themselves (Requirement 9.3–9.5).
    const received = await transportJson({
      connection: captureTransportConnection(connection, {
        'content-type': JSON_MEDIA_TYPE,
        accept: JSON_MEDIA_TYPE,
      }),
      displayName: DISPLAY_NAME,
      provider: batch.provider,
      model: batch.model,
      path: EMBEDDINGS_PATH,
      accept: JSON_MEDIA_TYPE,
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
    return decodeEmbeddingResponse(batch, received)
  }
}

/**
 * Create an OpenAI embedding adapter.
 * @param options - credential, endpoint, catalog and transport bounds.
 * @returns the adapter, ready to register on an embedding route.
 */
export function openAiEmbeddingAdapter(
  options: OpenAiEmbeddingProviderOptions,
): EmbeddingAdapter {
  return new OpenAiEmbeddingAdapter(options)
}

/**
 * Preferred transactional plugin for installing OpenAI embeddings.
 *
 * Its `kind` is `'embedding-provider-plugin'`, so it installs beside
 * {@link openAiPlugin} on the same route without either standing in for the other.
 * @param options - credential, endpoint, catalog and transport bounds.
 * @returns an inert plugin; the adapter is constructed during activation.
 */
export function openAiEmbeddingPlugin(
  options: OpenAiEmbeddingProviderOptions,
): ComposableEmbeddingProviderPlugin & { readonly family: 'openai' } {
  const id = options.id ?? 'openai'
  const routes = Object.freeze([...(options.routes ?? [id])])
  return defineEmbeddingProviderPlugin({
    id,
    family: 'openai',
    displayName: DISPLAY_NAME,
    routes,
    setup(registrar) {
      const remove = registrar.registerEmbeddingAdapter(openAiEmbeddingAdapter(options))
      return () => {
        remove()
        return undefined
      }
    },
  }) as ComposableEmbeddingProviderPlugin & { readonly family: 'openai' }
}
