import type { ComposableModelProviderPlugin } from '@alvin0/ai-agent-sdk-core/provider'

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

export interface ProviderConformanceCaseInput {
  readonly scenario: ProviderConformanceScenario
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
}
