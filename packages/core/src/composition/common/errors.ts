export type RuntimeConstructionFailureReason = 'invalid' | 'failed' | 'timed-out' | 'aborted'

export type RuntimeConstructionFailureCode =
  | 'CAPABILITY_KIND_MISMATCH'
  | 'CAPABILITY_API_UNSUPPORTED'
  | 'CAPABILITY_ID_CONFLICT'
  | 'PROVIDER_ROUTE_CONFLICT'
  /** Two plugins of the SAME operation claim one route (Requirement 11.6). */
  | 'PROVIDER_OPERATION_CONFLICT'
  | 'PROVIDER_SETUP_ASYNC_UNSUPPORTED'
  | 'OBSERVATION_BOUNDARY_UNSUPPORTED'
  | 'CAPABILITY_STARTUP_FAILED'
  | 'CAPABILITY_STARTUP_TIMEOUT'
  | 'CAPABILITY_STARTUP_ABORTED'

import type { CapabilityIdentityConflict } from '../../errors/capability-identity.ts'
export type { CapabilityIdentityConflict } from '../../errors/capability-identity.ts'

export type RuntimeConstructionComponent =
  | { readonly kind: 'provider-plugin'; readonly id: string }
  | { readonly kind: 'observation-exporter'; readonly id: string }

export interface RuntimeComponentCloseReport {
  readonly kind: 'provider-registration' | 'observation-exporter' | 'agent-team'
  readonly id: string
  readonly status: 'closed' | 'failed' | 'timed-out'
  readonly error?: { readonly code: string; readonly stage: string; readonly message: string }
}

/**
 * One entry of a whole-input failure sweep.
 *
 * Declared here rather than beside the preflight that produces it so
 * {@link ConstructionFailure} can carry it without importing a composition
 * phase. `ProviderPreflightFailure` narrows `code` to the subset a provider
 * sweep can produce.
 */
export interface RuntimeConstructionAggregateEntry {
  /** Position in the caller's input list. */
  readonly index: number
  readonly code: RuntimeConstructionFailureCode
  /** Present only when the id was readable as inert, bounded data. */
  readonly pluginId?: string
  /** The earlier index this entry collides with, for conflict codes. */
  readonly conflictsWithIndex?: number
}

export interface ConstructionFailure {
  readonly failureCode: RuntimeConstructionFailureCode
  readonly stage: 'preflight' | 'provider-setup' | 'exporter-ready' | 'activation'
  readonly reason: RuntimeConstructionFailureReason
  readonly component?: RuntimeConstructionComponent
  readonly conflict?: CapabilityIdentityConflict
  readonly cleanup?: readonly RuntimeComponentCloseReport[]
  /**
   * Every failure the sweep found, not just the reported one.
   *
   * `failureCode` stays the FIRST failure's code so existing assertions keep
   * their meaning; this list is purely additive (DD-3).
   */
  readonly aggregate?: readonly RuntimeConstructionAggregateEntry[]
}

/** Support-safe envelope: deliberately carries no raw input, exception or cause. */
export class AgentRuntimeConstructionError extends Error {
  readonly code = 'RUNTIME_CONSTRUCTION_FAILED' as const
  readonly failureCode: RuntimeConstructionFailureCode
  readonly stage: ConstructionFailure['stage']
  readonly reason: RuntimeConstructionFailureReason
  readonly component?: RuntimeConstructionComponent
  readonly conflict?: CapabilityIdentityConflict
  readonly cleanup: readonly RuntimeComponentCloseReport[]
  /** Empty unless the failure came from a whole-input sweep. */
  readonly aggregate: readonly RuntimeConstructionAggregateEntry[]

  constructor(failure: ConstructionFailure) {
    super('Agent runtime construction did not complete')
    this.name = 'AgentRuntimeConstructionError'
    this.failureCode = failure.failureCode
    this.stage = failure.stage
    this.reason = failure.reason
    if (failure.component !== undefined) this.component = Object.freeze({ ...failure.component })
    if (failure.conflict !== undefined) this.conflict = Object.freeze({ ...failure.conflict })
    this.cleanup = Object.freeze((failure.cleanup ?? []).map(row => Object.freeze({
      ...row,
      ...(row.error === undefined ? {} : { error: Object.freeze({ ...row.error }) }),
    })))
    this.aggregate = Object.freeze((failure.aggregate ?? []).map(entry => Object.freeze({ ...entry })))
  }
}

export function invalidPreflight(
  failureCode: RuntimeConstructionFailureCode = 'CAPABILITY_STARTUP_FAILED',
  conflict?: CapabilityIdentityConflict,
): AgentRuntimeConstructionError {
  return new AgentRuntimeConstructionError({
    failureCode, stage: 'preflight', reason: 'invalid',
    ...(conflict === undefined ? {} : { conflict }),
  })
}

export function checkPreflightAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentRuntimeConstructionError({
    failureCode: 'CAPABILITY_STARTUP_ABORTED', stage: 'preflight', reason: 'aborted',
  })
}
