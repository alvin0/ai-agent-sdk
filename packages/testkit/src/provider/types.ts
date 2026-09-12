import type { ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'
import type { EmbeddingConformanceFixture } from './embedding/types.ts'

/**
 * Every scenario a provider fixture can be asked to build.
 *
 * Two disjoint groups in one union. The first ten drive the generation contract
 * and are UNCHANGED — a provider that conforms today keeps conforming. The last
 * twelve drive the embedding contract, and every one of them either starts with
 * `embedding-` or names the plugin-compatibility edge it exercises, which is what
 * lets `EmbeddingConformanceScenario` derive its own subset without a second
 * hand-maintained list (Requirement 17.1).
 */
export type ProviderConformanceScenario =
  | 'success'
  | 'retry-success'
  | 'retry-exhaustion'
  | 'missing-usage'
  | 'malformed-usage'
  | 'abort-in-flight'
  | 'stream-bound-failure'
  | 'cleanup-failure'
  | 'catalog-empty'
  | 'catalog-failure'
  | 'embedding-success'
  | 'embedding-reordered-response'
  | 'embedding-invalid-index'
  | 'embedding-invalid-vector'
  | 'embedding-batch-limits'
  | 'embedding-abort-in-flight'
  | 'embedding-retry-cost'
  | 'embedding-missing-usage'
  | 'embedding-cache-key'
  | 'embedding-space-mismatch'
  | 'embedding-only-runtime'
  | 'generation-only-plugin'

/**
 * The ten generation scenarios, derived rather than restated.
 *
 * A generation fixture is only ever asked for one of these, so widening
 * {@link ProviderConformanceScenario} with the embedding group leaves every
 * existing fixture's exhaustiveness intact.
 */
export type ProviderGenerationScenario = Exclude<
  ProviderConformanceScenario,
  `embedding-${string}` | 'generation-only-plugin'
>

export interface ProviderConformanceCaseInput {
  readonly scenario: ProviderGenerationScenario
  readonly id: string
  readonly route: string
  /** Raw value that the scenario must place only in an internal cause/error. */
  readonly privateSentinel: string
}

export interface ProviderConformanceControlSnapshot {
  readonly setupCalls: number
  readonly cleanupCalls: number
  readonly dispatchCalls: number
}

export interface ProviderConformanceControl {
  snapshot(): ProviderConformanceControlSnapshot
  /** Required only by the abort-in-flight scenario. */
  waitForDispatch?(): Promise<void>
}

export interface ProviderConformanceCase {
  readonly plugin: ComposableModelProviderPlugin
  readonly route: string
  readonly model: string
  readonly control: ProviderConformanceControl
  readonly expectedAttempts?: number
  readonly expectedTotalTokens?: number
  /** Required by stream-bound-failure and compared with the support-safe run report. */
  readonly expectedFailureCode?: string
}

export interface ProviderConformanceFixture {
  /** Must synchronously create a new inert provider instance for every call. */
  create(input: ProviderConformanceCaseInput): ProviderConformanceCase
}

/**
 * Every claim a conformance run can report on.
 *
 * The nineteen generation ids are unchanged. The sixteen embedding ids are all
 * prefixed `embedding-`, so `EmbeddingConformanceCheckId` is a derivation rather
 * than a copy, and a new embedding check cannot be added in one place and
 * forgotten in the other (Requirement 17.1).
 */
export type ProviderConformanceCheckId =
  | 'inert-construction'
  | 'marker-kind-preflight'
  | 'marker-version-preflight'
  | 'duplicate-route-preflight'
  | 'transactional-rollback'
  | 'success-stream-order'
  | 'complete-usage'
  | 'retry-success-accounting'
  | 'retry-exhaustion-accounting'
  | 'missing-usage-honesty'
  | 'malformed-usage-honesty'
  | 'in-flight-cancellation'
  | 'bounded-stream-failure'
  | 'failure-redaction'
  | 'cleanup-failure-containment'
  | 'empty-catalog'
  | 'failed-catalog-explicit-call'
  | 'observation-correlation-privacy'
  | 'idempotent-cleanup'
  | 'embedding-mapping-index-faithful'
  | 'embedding-mapping-invalid-rejected'
  | 'embedding-vector-validation'
  | 'embedding-batch-limits-respected'
  | 'embedding-batch-memory-bounded'
  | 'embedding-abort-stops-unsent'
  | 'embedding-close-covers-operation'
  | 'embedding-retry-no-resend'
  | 'embedding-timeout-dispatch-unknown'
  | 'embedding-cache-key-composition'
  | 'embedding-space-guard'
  | 'embedding-no-model-fallback'
  | 'embedding-plugin-generation-only'
  | 'embedding-plugin-embedding-only'
  | 'embedding-usage-honesty'
  | 'embedding-trace-privacy'

export interface ProviderConformanceCheck {
  readonly id: ProviderConformanceCheckId
  readonly status: 'passed' | 'failed'
  readonly message: string
}

export interface ProviderConformanceReport {
  readonly schemaVersion: 1
  readonly status: 'passed' | 'failed'
  readonly checks: readonly ProviderConformanceCheck[]
  readonly passed: number
  readonly failed: number
}

export interface ProviderConformanceOptions {
  readonly caseTimeoutMs?: number
  readonly startupTimeoutMs?: number
  readonly closeTimeoutMs?: number
  /**
   * Supply an embedding fixture and the embedding contract runs in the SAME
   * report, appending its sixteen checks to the same `checks` array.
   *
   * Optional because embedding is a separate provider capability: a
   * generation-only provider conforms fully without it, and an embedding-only
   * provider runs `runEmbeddingConformanceSuite` directly instead.
   */
  readonly embedding?: EmbeddingConformanceFixture
}
