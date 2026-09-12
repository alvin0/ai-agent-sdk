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

import { resolveRetryPolicy, type RetryPolicyConfig } from '@alvin0/ai-agent-sdk-core'
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
  type EmbeddingItem,
  type EmbeddingModelInfo,
  type EmbeddingProfile,
  type EmbeddingProfileInput,
  type EmbeddingVector,
  type PrepareEmbeddingOptions,
  type PreparedEmbeddingCall,
  type ResolvedEmbeddingModelInfo,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  defineEmbeddingProviderPlugin,
  type ComposableEmbeddingProviderPlugin,
  type CredentialInput,
  type ModelInvocationContext,
  type ProviderInfo,
  type ProviderRequestId,
  type ResolvedRetryPolicy,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core/provider'
import {
  captureTransportConnection,
  embeddingCatalogModelInfo,
  resolvedEmbeddingCatalogModelInfo,
  transportJson,
  type EmbeddingCatalogModel,
  type EmbeddingHttpConnection,
} from '@alvin0/ai-agent-sdk-provider-http'
import { OPENAI_BASE_URL } from './adapter.ts'

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

/** Options for {@link openAiEmbeddingAdapter} and {@link openAiEmbeddingPlugin}. */
export interface OpenAiEmbeddingProviderOptions {
  /** Injected API key or credential source; universal packages never read the environment. */
  readonly apiKey: CredentialInput
  /**
   * Endpoint base; defaults to {@link OPENAI_BASE_URL}.
   *
   * Point this at a self-hosted OpenAI-compatible endpoint. Declare that
   * endpoint's models through {@link models}: the compatibility claim is the
   * configuration's, not this adapter's (Requirement 15.3).
   */
  readonly baseUrl?: string
  /** Organization to bill, when the key belongs to several. */
  readonly organization?: string
  /** Project to attribute usage to. */
  readonly project?: string
  /** Plugin id; also the default route. Defaults to `'openai'`. */
  readonly id?: string
  /** Registry routes the plugin claims. Defaults to `[id]`. */
  readonly routes?: readonly string[]
  /**
   * Advisory embedding catalog.
   *
   * Empty by default, for the same reason the generation adapter ships no model
   * list: a stale built-in catalog would name retired models. A declared entry is
   * what makes `dimensions` reachable on the wire and what states the embedding
   * space, so a route that cares about either declares its models.
   */
  readonly models?: readonly EmbeddingCatalogModel[]
  /** Permit cleartext HTTP explicitly, for trusted local endpoints only. */
  readonly allowInsecureHttp?: boolean
  readonly requestTimeoutMs?: number
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly maxResponseChunks?: number
  readonly maxErrorBodyBytes?: number
  readonly requestLoggerTimeoutMs?: number
  /** Retry policy this route owns. */
  readonly retryPolicy?: RetryPolicyConfig
  readonly fetch?: typeof globalThis.fetch
}

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

  constructor(private readonly options: OpenAiEmbeddingProviderOptions) {
    super()
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
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<PreparedEmbeddingCall> {
    const connection = await this.connect(signal, context)
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
    const connection = await this.connect(batch.signal, context)
    const model = resolvedEmbeddingCatalogModelInfo(
      batch.provider,
      batch.model,
      connection.models,
    )
    return this.dispatch(connection, model, batch, context)
  }

  /** Everything one embedding request needs, read together, once per operation. */
  private async connect(
    signal?: AbortSignal,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingHttpConnection> {
    const token = await resolveApiKey(this.options.apiKey, signal, context)
    // The credential and the endpoint-scoped account headers travel together as
    // the auth layer; the transport merges its own layer and attribution on top,
    // which is what makes attribution unforgettable (Requirement 14.7).
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (this.options.organization !== undefined) {
      headers['openai-organization'] = this.options.organization
    }
    if (this.options.project !== undefined) {
      headers['openai-project'] = this.options.project
    }
    return Object.freeze({
      baseUrl: this.baseUrl,
      headers: Object.freeze(headers),
      sensitiveHeaderNames: Object.freeze(Object.keys(headers)),
      models: this.models,
      retryPolicy: this.retry,
      ...(this.options.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: this.options.allowInsecureHttp }),
      ...(this.options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.options.requestTimeoutMs }),
      ...(this.options.maxRequestBytes === undefined
        ? {}
        : { maxRequestBytes: this.options.maxRequestBytes }),
      ...(this.options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: this.options.maxResponseBytes }),
      ...(this.options.maxResponseChunks === undefined
        ? {}
        : { maxResponseChunks: this.options.maxResponseChunks }),
      ...(this.options.maxErrorBodyBytes === undefined
        ? {}
        : { maxErrorBodyBytes: this.options.maxErrorBodyBytes }),
      ...(this.options.requestLoggerTimeoutMs === undefined
        ? {}
        : { requestLoggerTimeoutMs: this.options.requestLoggerTimeoutMs }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
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

/** A response body that cleared every transport guard, plus its correlation id. */
interface ReceivedEmbeddingResponse {
  readonly payload: unknown
  readonly providerRequestId?: ProviderRequestId
}

/**
 * Concatenates one item's content parts into a single wire input.
 *
 * The rule is recorded as `documentRecipeRevision` on the profile, and revision
 * `'1'` is exactly this: the text of each part, in order, with no separator and no
 * added markup. It matches the effective text the contract's own length check and
 * cache key derive, so a batch split, a rejection and a wire body can never
 * disagree about what an item's text is. One item produces one element, so the
 * provider returns exactly one vector for it (Requirement 8.7).
 */
function itemInput(item: EmbeddingItem): string {
  let text = ''
  for (const part of item.contentParts) {
    if (part.type === 'text') text += part.text
  }
  return text
}

/**
 * Maps one parsed response body onto the batch that produced it, in ONE fixed
 * order.
 *
 * The order is the contract, not an implementation detail — the same malformed
 * response has to produce the same code here as it does for every other provider,
 * which is what lets a single conformance suite judge all of them:
 *
 * 1. a shape this contract does not recognise ⇒ `RESPONSE_MALFORMED`
 * 2. `data.length !== items.length` ⇒ `VECTOR_COUNT_MISMATCH`
 * 3. `{ data[i].index }` is not a permutation of `0..N-1` ⇒ `VECTOR_INDEX_INVALID`
 * 4. a non-finite element ⇒ `VECTOR_VALUE_INVALID`
 * 5. a width other than the one requested ⇒ `VECTOR_DIMENSIONS_MISMATCH`
 *
 * Steps 4 and 5 are delegated to the shared {@link validateBatchResult}, which
 * already runs them in exactly this order; re-deriving them here would be a second
 * place for the ordering to drift.
 *
 * The count check comes FIRST on purpose. Reading the entries one at a time and
 * refusing the first bad index would report a mapping failure for a response whose
 * real fault is that it answered a different number of inputs — two different
 * repairs for a caller, told apart by which check ran first.
 *
 * Nothing here slices, pads, sorts or repairs a value. The `index` a vector carries
 * out is the item's index in the `Logical_Call`, taken from `items[data[i].index]`,
 * never its position in this batch (Requirement 8.4).
 */
function decodeEmbeddingResponse(
  batch: EmbeddingBatchRequest,
  received: ReceivedEmbeddingResponse,
): EmbeddingBatchResult {
  const entries = readEntries(batch, received.payload)
  checkEntryCount(batch, entries)
  const positions = readPositions(batch, entries)
  const vectors: EmbeddingVector[] = entries.map((entry, at) => Object.freeze({
    // The item's index in the `Logical_Call`, not its position in this batch.
    index: batch.items[positions[at]!]!.index,
    values: readValues(batch, entry),
  }))
  const usage = readUsage(received.payload)
  const result: EmbeddingBatchResult = Object.freeze({
    vectors: Object.freeze(vectors),
    ...(usage === undefined ? {} : { usage }),
    ...(received.providerRequestId === undefined
      ? {}
      : { providerRequestId: received.providerRequestId }),
  })
  // Steps 4 and 5, plus the count and logical-index invariants restated against
  // the `Logical_Call` indexes this result now carries.
  validateBatchResult(batch, result)
  return result
}

/** A `data` array of objects, or a structural refusal naming the batch it belongs to. */
function readEntries(
  batch: EmbeddingBatchRequest,
  payload: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const data = record(payload)?.['data']
  if (!Array.isArray(data)) throw malformed(batch, 'response carries no `data` array')
  return data.map(entry => {
    const source = record(entry)
    if (source === undefined) throw malformed(batch, 'response `data` entry is not an object')
    return source
  })
}

/** Step 2: one vector per input sent, counted before anything is interpreted. */
function checkEntryCount(
  batch: EmbeddingBatchRequest,
  entries: readonly unknown[],
): void {
  if (entries.length === batch.items.length) return
  throw new EmbeddingError(
    `${DISPLAY_NAME} returned ${entries.length} vectors for ${batch.items.length} inputs`,
    EMBEDDING_ERROR_CODES.VECTOR_COUNT_MISMATCH,
    { provider: batch.provider, model: batch.model },
  )
}

/**
 * Step 3: the reported positions, once they are known to be a permutation of
 * `0..N-1`.
 *
 * A duplicate, a gap, a non-integer and an out-of-range value all land in the same
 * refusal, because they all break the same thing: without a bijection between
 * response entries and batch items, restoring input order would be guesswork, and
 * a position to "fall back on" would silently attach one input's vector to another
 * (Requirement 8.2).
 */
function readPositions(
  batch: EmbeddingBatchRequest,
  entries: readonly Readonly<Record<string, unknown>>[],
): readonly number[] {
  const positions: number[] = []
  const seen = new Set<number>()
  for (const entry of entries) {
    const position = entry['index']
    if (typeof position !== 'number' || !Number.isInteger(position)
      || position < 0 || position >= batch.items.length || seen.has(position)) {
      throw new EmbeddingError(
        `${DISPLAY_NAME} returned a duplicate, missing or out-of-range vector index`,
        EMBEDDING_ERROR_CODES.VECTOR_INDEX_INVALID,
        { provider: batch.provider, model: batch.model },
      )
    }
    seen.add(position)
    positions.push(position)
  }
  return positions
}

/**
 * Reads one `embedding` array with every number exactly as it arrived.
 *
 * Only the SHAPE is judged here: a non-finite or non-numeric element is step 4's
 * business, so it travels through untouched and is refused by
 * {@link validateBatchResult} under `VECTOR_VALUE_INVALID` rather than being
 * repaired, dropped, or relabelled as a malformed shape.
 */
function readValues(
  batch: EmbeddingBatchRequest,
  entry: Readonly<Record<string, unknown>>,
): readonly number[] {
  const values = entry['embedding']
  if (!Array.isArray(values)) {
    throw malformed(batch, 'response vector is not an array')
  }
  return Object.freeze([...values as readonly number[]])
}

/**
 * Maps `prompt_tokens` and `total_tokens` onto the two embedding counters.
 *
 * There is no `outputTokens`, which is why embedding reports
 * `EmbeddingTokenUsage` rather than generation's `TokenUsage`. A counter that is
 * absent or unreadable stays ABSENT: a zero here would be indistinguishable from
 * a provider that reported no cost at all.
 */
function readUsage(payload: unknown): { inputTokens?: number; totalTokens?: number } | undefined {
  const usage = record(record(payload)?.['usage'])
  if (usage === undefined) return undefined
  const inputTokens = usage['prompt_tokens']
  const totalTokens = usage['total_tokens']
  const counters = {
    ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
    ...(typeof totalTokens === 'number' ? { totalTokens } : {}),
  }
  return Reflect.ownKeys(counters).length === 0 ? undefined : counters
}

/** A plain-record view of an unknown value, or `undefined`. */
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

/** A structural refusal: the response is not a shape this contract recognises. */
function malformed(batch: EmbeddingBatchRequest, detail: string): EmbeddingError {
  return new EmbeddingError(
    `${DISPLAY_NAME} embeddings ${detail}`,
    EMBEDDING_ERROR_CODES.RESPONSE_MALFORMED,
    { provider: batch.provider, model: batch.model },
  )
}

/** Resolves a literal key or a credential source, once per operation. */
async function resolveApiKey(
  apiKey: CredentialInput,
  signal?: AbortSignal,
  context?: ModelInvocationContext,
): Promise<string> {
  const value = typeof apiKey === 'string'
    ? apiKey
    : await apiKey.resolve({
      signal: signal ?? NEVER_ABORTED_SIGNAL,
      logger: context?.logger ?? NULL_LOGGER,
    })
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmbeddingError(
      `${DISPLAY_NAME} embeddings requires a non-empty \`apiKey\``,
      EMBEDDING_ERROR_CODES.CONFIGURATION_INVALID,
    )
  }
  return value
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
