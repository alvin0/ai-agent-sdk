import {
  EMBEDDING_ERROR_CODES,
  EmbeddingError,
  validateBatchResult,
  type EmbeddingBatchRequest,
  type EmbeddingBatchResult,
  type EmbeddingItem,
  type EmbeddingVector,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  type ProviderRequestId,
} from '@alvin0/ai-agent-sdk-core/provider'

const DISPLAY_NAME = 'OpenAI'

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
export function itemInput(item: EmbeddingItem): string {
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
export function decodeEmbeddingResponse(
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

