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

const ENCODER = new TextEncoder()
const INVALID_DATA = Symbol('invalid failure data')
const FAILURE_ENVELOPE_LIMITS = Object.freeze({
  messageBytes: 2_048,
  codeBytes: 128,
  requestIdBytes: 1_024,
})

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
  const source = objectLike(value) ? value : undefined
  // A ModelError from a DIFFERENT copy of this package keeps its own data but not
  // its class identity, so `instanceof` misses it. Trust the carried facts only
  // when both own properties survive validation and agree with each other.
  const carried = source === undefined ? undefined : ownFailureSnapshot(source)
  if (source !== undefined && carried !== undefined && carried.code === ownErrorCode(source)) return carried
  const error = isError(value)
    ? value
    : new AgentSdkError(thrownMessage(value), MODEL_ERROR_CODES.UNKNOWN, { cause: value })
  return Object.freeze({
    message: errorMessage(error),
    code: agentSdkErrorCode(error),
  })
}

function objectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function isError(value: unknown): value is Error {
  try { return value instanceof Error } catch { return false }
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
function ownErrorCode(error: object): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error: object): ModelFailure | undefined {
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
  if (!objectLike(value) || Array.isArray(value)) return undefined
  const message = ownFailureData(value, 'message')
  const code = ownFailureData(value, 'code')
  const status = ownFailureData(value, 'status')
  const providerRetryAfterMs = ownFailureData(value, 'providerRetryAfterMs')
  const requestId = ownFailureData(value, 'requestId')
  if (message === INVALID_DATA || code === INVALID_DATA || status === INVALID_DATA
    || providerRetryAfterMs === INVALID_DATA || requestId === INVALID_DATA
    || !boundedString(message, FAILURE_ENVELOPE_LIMITS.messageBytes)
    || !boundedString(code, FAILURE_ENVELOPE_LIMITS.codeBytes)
    || (status !== undefined && (!Number.isSafeInteger(status) || (status as number) < 100 || (status as number) > 599))
    || (providerRetryAfterMs !== undefined
      && (!Number.isFinite(providerRetryAfterMs) || (providerRetryAfterMs as number) <= 0))
    || (requestId !== undefined && !boundedString(requestId, FAILURE_ENVELOPE_LIMITS.requestIdBytes))) {
    return undefined
  }
  return Object.freeze({
    message,
    code,
    ...status === undefined ? {} : { status: status as number },
    ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: providerRetryAfterMs as number },
    ...requestId === undefined ? {} : { requestId: requestId as ProviderRequestId },
  })
}

function ownFailureData(source: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) return undefined
    return 'value' in descriptor ? descriptor.value : INVALID_DATA
  } catch {
    return INVALID_DATA
  }
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0
    && ENCODER.encode(value).byteLength <= maxBytes
}

/** Read an error message without letting an accessor replace the primary failure. */
function errorMessage(error: Error): string {
  const message = ownFailureData(error, 'message')
  if (boundedString(message, FAILURE_ENVELOPE_LIMITS.messageBytes)) return message
  return 'model adapter failed'
}

/**
 * Trust only codes from this SDK's taxonomy.
 *
 * A third-party SDK's `code` is not our vocabulary — adopting it could let an
 * unrelated string like `ERR_BAD_REQUEST` collide with a retry allow-list entry.
 */
function agentSdkErrorCode(error: Error): string {
  try {
    const code = ownErrorCode(error)
    return error instanceof AgentSdkError
      && boundedString(code, FAILURE_ENVELOPE_LIMITS.codeBytes)
      ? code
      : MODEL_ERROR_CODES.UNKNOWN
  } catch {
    return MODEL_ERROR_CODES.UNKNOWN
  }
}
