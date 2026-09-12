/**
 * What an embedding provider must hand the harness before its contract can be run.
 *
 * The split mirrors `../types.ts`: the runner is provider-agnostic and knows
 * nothing about any endpoint, while a FIXTURE knows one provider's wire shapes
 * and scripts them per scenario. Both `openAiEmbeddingPlugin` and
 * `geminiEmbeddingPlugin` are driven through this one interface, which is what
 * makes "the same set of error codes on both" a checkable claim rather than a
 * hope (Requirement 14.8).
 *
 * The two subset types are DERIVED from the unions in `../types.ts` rather than
 * restated, so the twelve scenarios and sixteen check ids exist in exactly one
 * place.
 *
 * @module ai-agent-sdk/testkit/provider/embedding/types
 */

import type { ComposableRuntimeProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import type {
  EmbeddingPurpose,
  EmbeddingSpaceId,
  ResolvedEmbeddingBatchLimits,
} from '@alvin0/ai-agent-sdk-core/embedding'
import type { ProviderConformanceCheckId, ProviderConformanceScenario } from '../types.ts'

/** The twelve embedding scenarios, derived from {@link ProviderConformanceScenario}. */
export type EmbeddingConformanceScenario = Extract<
  ProviderConformanceScenario,
  `embedding-${string}` | 'generation-only-plugin'
>

/** The sixteen embedding check ids, derived from {@link ProviderConformanceCheckId}. */
export type EmbeddingConformanceCheckId = Extract<ProviderConformanceCheckId, `embedding-${string}`>

/**
 * Every embedding scenario, as data.
 *
 * The runner does not iterate this list — each scenario is requested by the
 * check that needs it. It exists so a caller (or a meta-test) can assert the
 * harness really covers twelve scenarios without re-typing them.
 */
export const EMBEDDING_CONFORMANCE_SCENARIOS: readonly EmbeddingConformanceScenario[] = Object.freeze([
  'embedding-success',
  'embedding-reordered-response',
  'embedding-invalid-index',
  'embedding-invalid-vector',
  'embedding-batch-limits',
  'embedding-abort-in-flight',
  'embedding-retry-cost',
  'embedding-missing-usage',
  'embedding-cache-key',
  'embedding-space-mismatch',
  'embedding-only-runtime',
  'generation-only-plugin',
])

/** Every embedding check id, in the order the runner reports them. */
export const EMBEDDING_CONFORMANCE_CHECK_IDS: readonly EmbeddingConformanceCheckId[] = Object.freeze([
  'embedding-mapping-index-faithful',
  'embedding-mapping-invalid-rejected',
  'embedding-vector-validation',
  'embedding-batch-limits-respected',
  'embedding-batch-memory-bounded',
  'embedding-abort-stops-unsent',
  'embedding-close-covers-operation',
  'embedding-retry-no-resend',
  'embedding-timeout-dispatch-unknown',
  'embedding-cache-key-composition',
  'embedding-space-guard',
  'embedding-no-model-fallback',
  'embedding-plugin-generation-only',
  'embedding-plugin-embedding-only',
  'embedding-usage-honesty',
  'embedding-trace-privacy',
])

/** What the harness asks a fixture to build. */
export interface EmbeddingConformanceCaseInput {
  readonly scenario: EmbeddingConformanceScenario
  readonly id: string
  readonly route: string
  /** Raw value the scenario must place only in an internal cause/error. */
  readonly privateSentinel: string
  /**
   * The exact texts this case will embed, in `Logical_Call` order.
   *
   * Handed over so a fixture can script one response per input — the harness
   * will send these and nothing else, and index `i` of this array is item index
   * `i` of the call.
   */
  readonly inputs: readonly string[]
  /** The purpose the harness will declare for this case. */
  readonly purpose: EmbeddingPurpose
}

/** One `Provider_Attempt` the fixture actually served. */
export interface EmbeddingConformanceDispatch {
  /** Model id the request went out under; a fallback would show up as a different value. */
  readonly model: string
  /** Item indexes of the batch, in `Logical_Call` numbering. */
  readonly itemIndexes: readonly number[]
  /** Bytes of the request payload the fixture put on the wire. */
  readonly byteCount: number
  /** The attempt ended in a failure the fixture scripted. */
  readonly failed: boolean
}

export interface EmbeddingConformanceControlSnapshot {
  readonly setupCalls: number
  readonly cleanupCalls: number
  /** One entry per `Provider_Attempt`, in dispatch order. */
  readonly dispatches: readonly EmbeddingConformanceDispatch[]
  /** Highest number of attempts that were ever in flight at the same moment. */
  readonly peakInFlight: number
  /** Highest sum of in-flight request payload bytes; the memory bound (Requirement 17.4). */
  readonly peakInFlightBytes: number
}

export interface EmbeddingConformanceControl {
  snapshot(): EmbeddingConformanceControlSnapshot
  /**
   * Resolves once the fixture has entered its FIRST dispatch.
   *
   * Required by `embedding-abort-in-flight`: without it, "abort while a batch is
   * on the wire" is a race the harness hopes to win rather than a fact.
   */
  waitForDispatch?(): Promise<void>
  /**
   * The values the provider returned for each item index, BEFORE any
   * post-processing the profile records.
   *
   * This is the honest reference for index fidelity: comparing the published
   * vector against the provider's own output is the only way to catch a
   * permutation, since comparing the SDK against itself always agrees.
   */
  providerVectors(): ReadonlyMap<number, readonly number[]>
}

/** One embedding scenario, ready to run. */
export interface EmbeddingConformanceCase {
  /**
   * Normally an `embedding-provider-plugin`. For `generation-only-plugin` it is
   * deliberately a `model-provider-plugin`, which is the whole point of that
   * scenario (Requirement 17.9).
   */
  readonly plugin: ComposableRuntimeProviderPlugin
  readonly route: string
  readonly model: string
  readonly control: EmbeddingConformanceControl
  /** Requested vector width; absent means the model default. */
  readonly dimensions?: number
  /** In-flight `Physical_Batch` bound. Required by the batching scenarios. */
  readonly concurrency?: number
  /**
   * Batch bounds for this case.
   *
   * `embedding-batch-limits` and `embedding-abort-in-flight` MUST declare
   * `maxItems`, `maxTokens` and `maxBytes` explicitly, and `maxItems` must be
   * smaller than `inputs.length`: a case that fits in one batch exercises no
   * bound and proves nothing about memory.
   */
  readonly batchLimits?: Partial<Omit<ResolvedEmbeddingBatchLimits, 'estimateTokens'>>
  /** Total `Provider_Attempt`s the scenario is scripted to spend, when it is fixed. */
  readonly expectedAttempts?: number
  /**
   * The stable code this scenario must fail with.
   *
   * Required by the three mapping/validation scenarios, and compared against the
   * code that actually surfaced — that comparison is what holds two different
   * providers to ONE error taxonomy.
   */
  readonly expectedFailureCode?: string
  /**
   * A `Space_Id` the resolved call must NOT be compatible with.
   *
   * Required by `embedding-space-mismatch`. Derive it from a genuinely different
   * space (another model generation, another width), never by editing a string.
   */
  readonly incompatibleSpace?: EmbeddingSpaceId
  /**
   * A second model id on the same route whose embedding space differs.
   *
   * Optional. When present, the harness additionally shows the two models are not
   * interchangeable, so there is no compatible group to silently fall back into.
   */
  readonly foreignModel?: string
  /** A second width for the cache scenario, used to show the key reflects dimensions. */
  readonly alternateDimensions?: number
}

export interface EmbeddingConformanceFixture {
  /** MUST synchronously create a new inert provider instance for every call. */
  create(input: EmbeddingConformanceCaseInput): EmbeddingConformanceCase
}
