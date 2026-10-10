import {
  type ModelInvocationContext,
  type SdkLogger,
} from '@alvin0/ai-agent-sdk-core'
import {
  EMBEDDING_ERROR_CODES,
  EmbeddingError,
  validateBatchResult,
  type EmbeddingBatchRequest,
  type EmbeddingBatchResult,
  type EmbeddingPostProcessing,
  type EmbeddingProfile,
  type EmbeddingPurpose,
  type EmbeddingVector,
  type ResolvedEmbeddingModelInfo,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  type CredentialInput,
  type ModelTarget,
} from '@alvin0/ai-agent-sdk-core/provider'

import type { GeminiEmbeddingProviderOptions } from './embedding-types.ts'

/** Revision of the `l2-renormalize` step this adapter performs. */
const POST_PROCESSING_REVISION = '1'

/** Applied when neither the caller nor the catalog says otherwise. */
export const DEFAULT_RECIPE_REVISION = '1'

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

/** Resolve a literal key or a credential source, without caching the secret. */
export async function resolveCredential(
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
export function bareModelId(model: string): string {
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
export function embedRequest(
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
export function postProcessingFor(
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
export function decodeBatch(
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
export function defaultModelTarget(
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

export function profileNormalization(model: ResolvedEmbeddingModelInfo,
  postProcessing: EmbeddingPostProcessing | undefined) {
  if (postProcessing !== undefined) return 'unit-l2'
  return model.normalization.state === 'supported' ? model.normalization.value : 'unknown'
}

export function embeddingTransportOptions(options: GeminiEmbeddingProviderOptions) {
  return {
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
  }
}
