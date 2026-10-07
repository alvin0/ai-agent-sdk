/**
 * The error adapters throw, and the codes they classify failures into.
 *
 * {@link ModelError} validates its own inputs and exposes a frozen serializable
 * twin ({@link ModelFailure}). The pairing is the point: a live `Error` is what
 * you throw, and a plain data object is what you log, persist, or send across a
 * process boundary  Ean `Error` does not survive `structuredClone` or JSON with
 * its class intact.
 *
 * @module ai-agent-sdk/core/errors/model-error
 */

import type { ProviderRequestId } from '../primitives/brand.ts'
import { AgentSdkError } from './agent-sdk-error.ts'
import type { ModelFailure } from './failure.ts'

/** Structured provider facts and cause accepted by {@link ModelError}. */
export interface ModelErrorOptions extends ErrorOptions {
  /** Valid HTTP status observed at the provider boundary. */
  status?: number
  /** Positive finite provider-requested delay in milliseconds. */
  providerRetryAfterMs?: number
  /** Non-empty opaque provider request id. */
  requestId?: ProviderRequestId
}

function validateModelErrorInputs(message: string, code: string, options?: ModelErrorOptions): void {
  validateText(message, 'message'); validateText(code, 'code')
  validateStatus(options?.status)
  validateRetryAfter(options?.providerRetryAfterMs)
  validateRequestId(options?.requestId)
}

function validateText(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`ModelError ${label} must be a non-empty string`)
}
function validateStatus(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 100 || value > 599)) {
    throw new Error('ModelError status must be an integer from 100 through 599')
  }
}
function validateRetryAfter(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error('ModelError providerRetryAfterMs must be a positive finite number')
  }
}
function validateRequestId(value: ProviderRequestId | undefined): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw new Error('ModelError requestId must be a non-empty string')
  }
}

function modelFailure(message: string, code: string, options?: ModelErrorOptions): ModelFailure {
  return Object.freeze({
    message, code,
    ...options?.status === undefined ? {} : { status: options.status },
    ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
    ...options?.requestId === undefined ? {} : { requestId: options.requestId },
  })
}

/**
 * Typed error for model-call failures, carrying a stable `code` from the shared
 * taxonomy plus the serializable {@link failure} twin.
 *
 * The constructor validates rather than trusts. An out-of-range `status` or a
 * negative `providerRetryAfterMs` means an adapter misread a header, and letting
 * that through would put a retry to sleep for a nonsense duration.
 */
export class ModelError extends AgentSdkError {
  /** Serializable facts retained beside this live Error. */
  readonly failure: ModelFailure

  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - non-empty stable provider-neutral machine code.
   * @param options - optional cause and validated serializable provider facts.
   */
  constructor(message: string, code: string, options?: ModelErrorOptions) {
    validateModelErrorInputs(message, code, options)
    super(message, code, options)
    this.name = 'ModelError'
    this.failure = modelFailure(message, code, options)
  }
}

/**
 * Codes produced at the provider boundary.
 *
 * Exported as a frozen object rather than a TS enum so that a third-party
 * adapter can emit its own code without this union having to know about it.
 * Retry eligibility is decided by policy against these values, never by the
 * adapter that assigns them  Esee `retry-policy.ts`.
 */
export const MODEL_ERROR_CODES = Object.freeze({
  /** Credentials were rejected (401/403). */
  AUTH: 'AUTH',
  /** Transient request-rate limiting (429). */
  RATE_LIMIT: 'RATE_LIMIT',
  /** Provider-side fault (5xx). */
  SERVER: 'SERVER',
  /** The provider stopped producing output for longer than the idle bound. */
  TIMEOUT: 'TIMEOUT',
  /** The request never completed at the network layer. */
  TRANSPORT: 'TRANSPORT',
  /** The caller's signal aborted the request. */
  ABORTED: 'ABORTED',
  /** An adapter ignored cancellation and may still own live work. */
  TEARDOWN_TIMEOUT: 'MODEL_TEARDOWN_TIMEOUT',
  /** The provider rejected the request as malformed (400/413). */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** A well-formed response could not be parsed. */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  /** The response body ended before its terminating sentinel. */
  STREAM_CLOSED: 'STREAM_CLOSED',
  /** The request carried content the selected model cannot accept. */
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  /** The request set an option this provider has no equivalent for. */
  UNSUPPORTED_OPTION: 'UNSUPPORTED_OPTION',
  /** Nothing classified it; treated as non-retryable. */
  UNKNOWN: 'UNKNOWN',
} as const)

/** Registry-level codes, raised before any provider I/O happens. */
export const REGISTRY_ERROR_CODES = Object.freeze({
  NO_ADAPTER: 'NO_ADAPTER',
  DUPLICATE_ADAPTER: 'DUPLICATE_ADAPTER',
  INVALID_ADAPTER: 'INVALID_ADAPTER',
  INVALID_CATALOG: 'INVALID_CATALOG',
  INVALID_MODEL_INFO: 'INVALID_MODEL_INFO',
  UNSUPPORTED_NATIVE_TOOL: 'UNSUPPORTED_NATIVE_TOOL',
  OUTPUT_TOKEN_LIMIT_EXCEEDED: 'OUTPUT_TOKEN_LIMIT_EXCEEDED',
  INVALID_PREPARED_CALL: 'INVALID_PREPARED_CALL',
  REGISTRATION_DISPOSED: 'REGISTRATION_DISPOSED',
} as const)
