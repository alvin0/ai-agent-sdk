/**
 * A controllable `EmbeddingAdapter` for embedding unit and contract tests.
 *
 * PLACEMENT NOTE (deviation from the task-named path). Task 6.6 names
 * `packages/core/tests/fixtures/embedding/fake-adapter.ts`, but that directory
 * does not exist and no vitest project collects `packages/*&#47;tests/`. Requirement
 * 17.11 states the layout that is actually in force: fixtures live at
 * `tests/fixtures/` and negative fixtures at `tests/negative-fixtures/`, beside
 * `tests/fixtures/generation-oracle.ts` and `tests/fixtures/model-adapters.ts`.
 * So this fixture sits at `tests/fixtures/embedding/fake-adapter.ts`, where the
 * consumers in `tests/unit/` and `tests/contract/` can import it directly.
 *
 * Imports reach into `packages/core/src/embedding/*.ts` by relative path rather
 * than through `@alvin0/ai-agent-sdk-core/embedding`, matching how the existing
 * specs import package internals: the fixture must typecheck and run against the
 * sources under change, not against a `dist/` that may not have been built.
 *
 * What is controllable here, and why each control exists:
 * - **the vectors "the provider" returned** — recorded in {@link FakeEmbeddingAdapter.providerVectors}
 *   BEFORE any post-processing, so Property 22 (task 6.7) can compare what came
 *   out of the SDK against what the provider actually produced, instead of
 *   comparing the SDK against itself;
 * - **errors** — per `Provider_Attempt`, so retry, cost and "protocol error rather
 *   than inference" behaviour can be scripted;
 * - **delays** — abort-aware, so `batch.signal` handling is observable;
 * - **vector-order permutation** — the adapter may return vectors in any order
 *   while carrying the original item index, which is exactly the condition order
 *   restoration must survive;
 * - **absent / malformed usage** — usage honesty needs a provider that reports
 *   nothing, and one that reports nonsense.
 *
 * The adapter performs EXACTLY ONE `Provider_Attempt` per `embedBatch()` call and
 * never retries internally, because that is the contract obligation the fixture
 * exists to hold the runtime to.
 *
 * @module tests/fixtures/embedding/fake-adapter
 */

import { EmbeddingAdapter } from '../../../packages/core/src/embedding/adapter.ts'
import type { EmbeddingCapability, ResolvedEmbeddingModelInfo } from '../../../packages/core/src/embedding/catalog.ts'
import { unknownEmbeddingModel } from '../../../packages/core/src/embedding/catalog.ts'
import { EMBEDDING_ERROR_CODES, EmbeddingError } from '../../../packages/core/src/embedding/errors.ts'
import type {
  EmbeddingProfile, EmbeddingProfileInput,
} from '../../../packages/core/src/embedding/profile.ts'
import { defaultEmbeddingProfile } from '../../../packages/core/src/embedding/profile.ts'
import type {
  EmbeddingBatchRequest, EmbeddingItem,
} from '../../../packages/core/src/embedding/request.ts'
import type {
  EmbeddingBatchResult, EmbeddingVector, EmbeddingWarning,
} from '../../../packages/core/src/embedding/result.ts'
import type { ModelInvocationContext } from '../../../packages/core/src/observation/report.ts'
import type { UsageCounters } from '../../../packages/core/src/observation/usage.ts'

/** A declared capability, for building catalog descriptors in one expression. */
export function supported<T>(value: T): EmbeddingCapability<T> {
  return { state: 'supported', value }
}

/** The positive negative claim: the route states it does NOT have the thing. */
export const UNSUPPORTED: EmbeddingCapability<never> = Object.freeze({ state: 'unsupported' })

/** The route states nothing at all. Never a reason to reject a request. */
export const UNKNOWN: EmbeddingCapability<never> = Object.freeze({ state: 'unknown' })

/**
 * A resolved descriptor built on top of the all-`unknown` one.
 *
 * Overrides are applied by spread, so a test declares only the capabilities its
 * scenario depends on and everything else stays honestly `unknown`.
 */
export function fakeEmbeddingModel(
  provider: string,
  model: string,
  overrides: Partial<ResolvedEmbeddingModelInfo> = {},
): ResolvedEmbeddingModelInfo {
  const base = unknownEmbeddingModel(provider, model)
  const declared = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<ResolvedEmbeddingModelInfo>
  return { ...base, ...declared }
}

/** How the fake provider reports usage for one attempt. */
export type FakeUsageMode =
  /** A well-formed embedding-shaped report: `inputTokens` and `totalTokens`. */
  | 'reported'
  /** No `usage` key at all. The runtime must NOT substitute a `0`. */
  | 'absent'
  /** Present but unreadable: wrong types, negative counters, `NaN`. */
  | 'malformed'
  /** Numerically past safe-integer precision: authority lost, not a bad field. */
  | 'overflow'
  /** A total below the only disjoint bucket: cannot describe the same call. */
  | 'inconsistent'

/** How the fake provider orders the vectors it returns. */
export type FakeVectorOrder =
  | 'input'
  | 'reversed'
  | 'rotated'
  | ((vectors: readonly EmbeddingVector[]) => readonly EmbeddingVector[])

/** Everything a scenario can script about the fake provider. */
export interface FakeEmbeddingBehaviour {
  /** Width of generated vectors when the request names none. Default `4`. */
  readonly dimensions?: number
  /**
   * The vector "the provider" produces for one item. Default is a deterministic
   * function of the item's text, so the same input always yields the same vector
   * and a fidelity comparison is reproducible.
   */
  readonly vectorFor?: (item: EmbeddingItem, attempt: number) => readonly number[]
  /**
   * Post-processing the adapter applies on top of the provider's values.
   *
   * A scenario that sets this SHOULD also declare the matching
   * `profile.postProcessing`, because Property 22 asserts the transform the
   * profile records is exactly the transform that happened.
   */
  readonly postProcess?: (values: readonly number[]) => readonly number[]
  /** Response order. Indexes are preserved regardless, per the contract. */
  readonly order?: FakeVectorOrder
  /** Abort-aware delay before the response is produced. */
  readonly delayMs?: number
  /**
   * Failure for a given attempt number (1-based), or `undefined` to succeed.
   * Thrown as-is, so a scenario can script transport faults and protocol errors.
   */
  readonly errorFor?: (attempt: number, batch: EmbeddingBatchRequest) => unknown
  /** Usage reporting mode, or an exact counter payload. Default `'reported'`. */
  readonly usage?: FakeUsageMode | UsageCounters
  /** Item indexes the provider claims it cut. Legal only under `truncation: 'allow'`. */
  readonly truncatedIndexes?: readonly number[]
  readonly providerRequestId?: string
  readonly warnings?: readonly EmbeddingWarning[]
  /** Catalog metadata this route resolves for any model id. */
  readonly model?: ResolvedEmbeddingModelInfo
  /** Profile override; absent means {@link defaultEmbeddingProfile}. */
  readonly profileFor?: (
    model: ResolvedEmbeddingModelInfo,
    request: EmbeddingProfileInput,
  ) => EmbeddingProfile
}

/** One recorded `Provider_Attempt`. */
export interface FakeEmbeddingAttempt {
  readonly attempt: number
  readonly batch: EmbeddingBatchRequest
  readonly context?: ModelInvocationContext
  /** Item indexes of the batch, in the order they were dispatched. */
  readonly itemIndexes: readonly number[]
}

const DEFAULT_DIMENSIONS = 4

/** Deterministic 32-bit hash; a fixture needs reproducibility, not cryptography. */
function hash(text: string): number {
  let value = 2_166_136_261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16_777_619)
  }
  return value >>> 0
}

/** Concatenated effective text of one item, in content-part order. */
export function itemText(item: EmbeddingItem): string {
  let text = ''
  for (const part of item.contentParts) {
    if (part.type === 'text') text += part.text
  }
  return text
}

/**
 * A stable pseudo-vector for one text, with values in `[-1, 1)`.
 *
 * Same text and width ⇒ same values, in this process and the next, so a test can
 * assert element-wise fidelity without capturing a golden file.
 */
export function deterministicVector(text: string, dimensions: number): readonly number[] {
  const values: number[] = []
  let state = hash(text) || 1
  for (let index = 0; index < dimensions; index += 1) {
    state = Math.imul(state ^ (state >>> 15), 2_246_822_519) >>> 0
    values.push((state / 2_147_483_648) - 1)
  }
  return Object.freeze(values)
}

/** L2 renormalization, the one post-processing kind the profile can record. */
export function l2Renormalize(values: readonly number[]): readonly number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0))
  if (norm === 0) return Object.freeze([...values])
  return Object.freeze(values.map(value => value / norm))
}

/** The usage payload for one attempt, or `undefined` when the provider reports none. */
function usageFor(
  mode: FakeUsageMode | UsageCounters,
  batch: EmbeddingBatchRequest,
): UsageCounters | undefined {
  if (typeof mode !== 'string') return mode
  const inputTokens = batch.items.reduce(
    (sum, item) => sum + Math.max(1, Math.ceil(itemText(item).length / 4)),
    0,
  )
  switch (mode) {
    case 'absent':
      return undefined
    case 'reported':
      return { inputTokens, totalTokens: inputTokens }
    case 'inconsistent':
      return { inputTokens, totalTokens: Math.max(0, inputTokens - 1) }
    case 'overflow':
      return { inputTokens: Number.MAX_SAFE_INTEGER + 2, totalTokens: Number.MAX_SAFE_INTEGER + 2 }
    case 'malformed':
      // Deliberately off-contract: only a cast can express what a hostile or
      // broken provider actually puts on the wire.
      return { inputTokens: '17', totalTokens: Number.NaN } as unknown as UsageCounters
  }
}

/** Applies the scripted response order. Indexes travel with the vectors. */
function reorder(
  vectors: readonly EmbeddingVector[],
  order: FakeVectorOrder,
): readonly EmbeddingVector[] {
  if (typeof order === 'function') return order(vectors)
  switch (order) {
    case 'input':
      return vectors
    case 'reversed':
      return [...vectors].reverse()
    case 'rotated':
      return vectors.length < 2 ? vectors : [...vectors.slice(1), ...vectors.slice(0, 1)]
  }
}

/** Rejects with the caller's abort reason, or the embedding `ABORTED` code. */
function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason
    ?? new EmbeddingError('fake embedding adapter aborted', EMBEDDING_ERROR_CODES.ABORTED)
}

/**
 * Throws the abort reason when `signal` is already aborted.
 *
 * A function rather than an inline check: TypeScript's control-flow narrowing
 * keeps `aborted` as `false` across an `await`, so an inline re-check after the
 * delay would be flagged as impossible even though that is exactly the moment
 * abort matters.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw abortError(signal)
}

/** Waits `ms`, settling promptly when `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (error?: unknown): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onAbort = (): void => settle(abortError(signal))
    const timer = setTimeout(settle, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * A scriptable `Embedding_Adapter`.
 *
 * Every scenario knob lives in {@link FakeEmbeddingBehaviour}; the instance state
 * is the evidence a test asserts on — the attempts made, the batches received,
 * and the vectors the provider produced before post-processing.
 */
export class FakeEmbeddingAdapter extends EmbeddingAdapter {
  /** One entry per `Provider_Attempt`, in dispatch order. */
  readonly attempts: FakeEmbeddingAttempt[] = []
  /**
   * What "the provider" returned for each item index, BEFORE post-processing.
   *
   * This is the honest reference for Property 22: with no post-processing the
   * published vector must equal this element-wise, and with post-processing it
   * must equal exactly the recorded transform of this.
   */
  readonly providerVectors = new Map<number, readonly number[]>()

  private readonly behaviour: FakeEmbeddingBehaviour

  constructor(behaviour: FakeEmbeddingBehaviour = {}) {
    super()
    this.behaviour = behaviour
  }

  /** The catalog metadata this route declares, identical for every model id. */
  override resolveEmbeddingModel(
    provider: string,
    model: string,
  ): Promise<ResolvedEmbeddingModelInfo> {
    return Promise.resolve(this.behaviour.model ?? fakeEmbeddingModel(provider, model))
  }

  override embeddingProfile(
    model: ResolvedEmbeddingModelInfo,
    request: EmbeddingProfileInput,
  ): EmbeddingProfile {
    return this.behaviour.profileFor?.(model, request) ?? defaultEmbeddingProfile(model, request)
  }

  /** EXACTLY ONE `Provider_Attempt`. No internal retry, ever. */
  override async embedBatch(
    batch: EmbeddingBatchRequest,
    context?: ModelInvocationContext,
  ): Promise<EmbeddingBatchResult> {
    const attempt = this.attempts.length + 1
    this.attempts.push({
      attempt,
      batch,
      ...(context === undefined ? {} : { context }),
      itemIndexes: Object.freeze(batch.items.map(item => item.index)),
    })

    throwIfAborted(batch.signal)

    const scripted = this.behaviour.errorFor?.(attempt, batch)
    if (scripted !== undefined) throw scripted

    const { delayMs } = this.behaviour
    if (delayMs !== undefined && delayMs > 0) await delay(delayMs, batch.signal)
    throwIfAborted(batch.signal)

    const width = batch.dimensions ?? this.behaviour.dimensions ?? DEFAULT_DIMENSIONS
    const truncated = new Set(this.behaviour.truncatedIndexes ?? [])
    const vectors: EmbeddingVector[] = batch.items.map((item) => {
      const raw = this.behaviour.vectorFor?.(item, attempt)
        ?? deterministicVector(itemText(item), width)
      this.providerVectors.set(item.index, Object.freeze([...raw]))
      const values = this.behaviour.postProcess?.(raw) ?? raw
      return {
        index: item.index,
        values: Object.freeze([...values]),
        ...(truncated.has(item.index) ? { truncated: true } : {}),
      }
    })

    const usage = usageFor(this.behaviour.usage ?? 'reported', batch)
    const { providerRequestId, warnings } = this.behaviour
    return {
      vectors: Object.freeze(reorder(vectors, this.behaviour.order ?? 'input')),
      ...(usage === undefined ? {} : { usage }),
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      ...(warnings === undefined ? {} : { warnings }),
    }
  }
}
