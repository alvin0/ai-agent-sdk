/**
 * Transport limits: the numbers that bound ONE HTTP request, wherever it goes.
 *
 * These belong to the transport rather than to a pipeline because every pipeline
 * needs exactly the same bounds — how big a request may be, how much of a
 * response may be read, how long a diagnostic observer may hold up dispatch.
 * A pipeline adds its own decoding limits on top (the SSE pipeline bounds events
 * and event characters); it does not redefine these.
 *
 * @module ai-agent-sdk/providers/transport/limits
 */

import type { HttpTransportConnection } from './connection.ts'

/** Default end-to-end bound once provider request construction begins. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000
/** Default serialized request ceiling. */
export const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024
/** Default cumulative successful response-body ceiling. */
export const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024
/** Default number of raw response chunks accepted from one request. */
export const DEFAULT_MAX_RESPONSE_CHUNKS = 100_000
/** Default error body retained for classification and diagnostics. */
export const DEFAULT_MAX_ERROR_BODY_BYTES = 1024 * 1024
/** Default diagnostic observer deadline; logging must never gate dispatch indefinitely. */
export const DEFAULT_REQUEST_LOGGER_TIMEOUT_MS = 5_000

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

export function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`)
  }
  return value
}

/**
 * Every transport bound for one request, defaulted and validated exactly once.
 *
 * Resolved from the connection snapshot, so a configuration change between two
 * reads cannot move a bound mid-request.
 */
export interface ResolvedTransportLimits {
  /** End-to-end request/stream timeout. */
  readonly requestTimeoutMs: number
  /** Maximum serialized outbound request bytes. */
  readonly maxRequestBytes: number
  /** Maximum cumulative successful response bytes. */
  readonly maxResponseBytes: number
  /** Maximum raw chunks accepted from a successful response. */
  readonly maxResponseChunks: number
  /** Maximum bytes read from a non-success response. */
  readonly maxErrorBodyBytes: number
  /** Maximum time granted to the optional request logger. */
  readonly requestLoggerTimeoutMs: number
}

/**
 * Apply defaults and reject nonsense bounds before any I/O happens.
 *
 * Validation order is fixed and part of the contract: a configuration with two
 * invalid bounds always reports the earlier field, so the error a caller sees does
 * not depend on which limit the pipeline happens to consult first.
 * @param connection - the captured snapshot this request is bound to.
 * @returns fully resolved bounds; never partially defaulted.
 */
export function resolveTransportLimits(
  connection: HttpTransportConnection,
): ResolvedTransportLimits {
  return Object.freeze({
    requestTimeoutMs: positiveFinite(
      connection.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    ),
    maxRequestBytes: positiveInteger(
      connection.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      'maxRequestBytes',
    ),
    maxResponseBytes: positiveInteger(
      connection.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    ),
    maxResponseChunks: positiveInteger(
      connection.maxResponseChunks ?? DEFAULT_MAX_RESPONSE_CHUNKS,
      'maxResponseChunks',
    ),
    maxErrorBodyBytes: positiveInteger(
      connection.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES,
      'maxErrorBodyBytes',
    ),
    requestLoggerTimeoutMs: positiveFinite(
      connection.requestLoggerTimeoutMs ?? DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
      'requestLoggerTimeoutMs',
    ),
  })
}
