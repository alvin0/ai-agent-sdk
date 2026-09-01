/**
 * The serializable twin of a failure, and the hardened boundary that produces one
 * from an arbitrary thrown value.
 *
 * This module is written defensively on purpose. The value being normalized may
 * come from a third-party SDK, and such objects can define `message`, `code`, or
 * `failure` as GETTERS that throw, or sit behind a Proxy. If normalization itself
 * threw, the original failure would be replaced by a confusing secondary one — so
 * every read goes through `getOwnPropertyDescriptor`, checks for a data property,
 * and is individually contained.
 *
 * @module ai-agent-sdk/core/errors/failure
 */

import type { ProviderRequestId } from '../primitives/brand.ts'
import { AgentSdkError } from './agent-sdk-error.ts'
import { MODEL_ERROR_CODES } from './model-error.ts'

/**
 * Serializable facts about a provider or transport failure.
 *
 * The live `Error` is what you throw; this is its data twin, safe to log, persist,
 * or send across a process boundary — an `Error` survives neither
 * `structuredClone` nor JSON with its class intact.
 *
 * Note what is deliberately absent: any judgement about whether to retry. These
 * are facts; policy decides.
 */
export interface ModelFailure {
  /** Human-readable provider or transport failure summary. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier, for support escalation. */
  readonly requestId?: ProviderRequestId
}

/**
 * Detach serializable provider facts from a value thrown by an adapter.
 * @param value - arbitrary value thrown during adapter dispatch or iteration.
 * @returns immutable provider-neutral facts, suitable for a terminal finish chunk.
 */
export function normalizeModelFailure(value: unknown): ModelFailure {
  const error = value instanceof Error
    ? value
    : new AgentSdkError(thrownMessage(value), MODEL_ERROR_CODES.UNKNOWN, { cause: value })
  // A ModelError from a DIFFERENT copy of this package keeps its own data but not
  // its class identity, so `instanceof` misses it. Trust the carried facts only
  // when both own properties survive validation and agree with each other.
  const carried = ownFailureSnapshot(error)
  if (carried !== undefined && carried.code === ownErrorCode(error)) return carried
  return Object.freeze({
    message: errorMessage(error),
    code: agentSdkErrorCode(error),
  })
}

/** Render a non-Error throw without letting hostile coercion escape. */
function thrownMessage(value: unknown): string {
  try {
    const message = String(value)
    return message.length > 0 ? message : 'model adapter failed'
  } catch {
    return 'model adapter failed'
  }
}

/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error: Error): ModelFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    return descriptor !== undefined && 'value' in descriptor
      ? failureSnapshot(descriptor.value)
      : undefined
  } catch {
    return undefined
  }
}

/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value: unknown): ModelFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as Partial<ModelFailure>
    const { message, code, status, providerRetryAfterMs, requestId } = candidate
    if (typeof message !== 'string' || message.length === 0
      || typeof code !== 'string' || code.length === 0
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined
        && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0))) {
      return undefined
    }
    return Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
    })
  } catch {
    return undefined
  }
}

/** Read an error message without letting an accessor replace the primary failure. */
function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // Fall through: a serializable failure still has to exist beside the Error.
  }
  return 'model adapter failed'
}

/**
 * Trust only codes from this SDK's taxonomy.
 *
 * A third-party SDK's `code` is not our vocabulary — adopting it could let an
 * unrelated string like `ERR_BAD_REQUEST` collide with a retry allow-list entry.
 */
function agentSdkErrorCode(error: Error): string {
  return error instanceof AgentSdkError ? error.code : MODEL_ERROR_CODES.UNKNOWN
}
