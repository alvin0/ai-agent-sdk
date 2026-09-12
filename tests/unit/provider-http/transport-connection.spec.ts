/**
 * Unit gate for the shared transport connection snapshot and its limits.
 *
 * Feature: embedding-support — Requirements 13.1, 13.2.
 *
 * Two claims live here, and neither is about a pipeline:
 *
 *  - Requirement 13.1: capturing a snapshot merges the transport's header layer
 *    beneath the auth layer exactly once, and the sensitive-name set survives, so
 *    redaction still covers whatever the auth layer marked.
 *  - Requirement 13.2: the six transport bounds are defaulted and validated in one
 *    place, with a fixed reporting order, so no pipeline can resolve them differently.
 */

import { describe, expect, it } from 'vitest'
import { attributionHeaders, resolveRetryPolicy } from '../../../packages/core/src/index.ts'
import {
  captureTransportConnection,
  type HttpTransportConnection,
} from '../../../packages/provider-http/src/transport/connection.ts'
import {
  DEFAULT_MAX_ERROR_BODY_BYTES,
  DEFAULT_MAX_REQUEST_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveTransportLimits,
} from '../../../packages/provider-http/src/transport/limits.ts'

const RETRY_POLICY = resolveRetryPolicy({ mode: 'normal', maxRetries: 1 }, 'test.retryPolicy')

function connectionOf(overrides: Partial<HttpTransportConnection> = {}): HttpTransportConnection {
  return {
    baseUrl: 'https://api.example.test',
    headers: { authorization: 'Bearer secret-token' },
    retryPolicy: RETRY_POLICY,
    ...overrides,
  }
}

describe('resolveTransportLimits (Requirement 13.2)', () => {
  it('defaults every bound a connection leaves undeclared', () => {
    expect(resolveTransportLimits(connectionOf())).toEqual({
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES,
      maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
      maxResponseChunks: DEFAULT_MAX_RESPONSE_CHUNKS,
      maxErrorBodyBytes: DEFAULT_MAX_ERROR_BODY_BYTES,
      requestLoggerTimeoutMs: DEFAULT_REQUEST_LOGGER_TIMEOUT_MS,
    })
  })

  it('keeps every declared bound and freezes the result', () => {
    const limits = resolveTransportLimits(connectionOf({
      requestTimeoutMs: 1_000,
      maxRequestBytes: 2_048,
      maxResponseBytes: 4_096,
      maxResponseChunks: 8,
      maxErrorBodyBytes: 512,
      requestLoggerTimeoutMs: 50,
    }))
    expect(limits).toEqual({
      requestTimeoutMs: 1_000,
      maxRequestBytes: 2_048,
      maxResponseBytes: 4_096,
      maxResponseChunks: 8,
      maxErrorBodyBytes: 512,
      requestLoggerTimeoutMs: 50,
    })
    expect(Object.isFrozen(limits)).toBe(true)
  })

  it('rejects a non-integer byte bound and a non-positive duration', () => {
    expect(() => resolveTransportLimits(connectionOf({ maxRequestBytes: 1.5 })))
      .toThrow(/maxRequestBytes must be a positive safe integer/)
    expect(() => resolveTransportLimits(connectionOf({ maxResponseChunks: 0 })))
      .toThrow(/maxResponseChunks must be a positive safe integer/)
    expect(() => resolveTransportLimits(connectionOf({ requestTimeoutMs: 0 })))
      .toThrow(/requestTimeoutMs must be a positive finite number/)
    expect(() => resolveTransportLimits(connectionOf({ requestLoggerTimeoutMs: Number.NaN })))
      .toThrow(/requestLoggerTimeoutMs must be a positive finite number/)
  })

  it('reports the earlier field when several bounds are invalid', () => {
    expect(() => resolveTransportLimits(connectionOf({
      requestTimeoutMs: -1,
      maxRequestBytes: -1,
      maxErrorBodyBytes: -1,
    }))).toThrow(/requestTimeoutMs/)
    expect(() => resolveTransportLimits(connectionOf({
      maxRequestBytes: -1,
      maxErrorBodyBytes: -1,
    }))).toThrow(/maxRequestBytes/)
  })
})

describe('captureTransportConnection (Requirement 13.1)', () => {
  it('returns the snapshot untouched when the transport layer is empty', () => {
    const connection = connectionOf()
    expect(captureTransportConnection(connection, {})).toBe(connection)
  })

  it('merges the transport layer and attribution beneath the auth layer', () => {
    const captured = captureTransportConnection(connectionOf(), {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
    })
    expect(captured.headers).toEqual({
      'accept': 'text/event-stream',
      'authorization': 'Bearer secret-token',
      'content-type': 'application/json',
      'user-agent': attributionHeaders()['user-agent'],
    })
    expect(captured.baseUrl).toBe('https://api.example.test')
    expect(captured.retryPolicy).toBe(RETRY_POLICY)
    expect(Object.isFrozen(captured)).toBe(true)
  })

  it('keeps the sensitive names the auth layer declared', () => {
    const captured = captureTransportConnection(
      connectionOf({
        headers: { 'x-goog-api-key': 'secret', 'x-tenant': 'acme' },
        sensitiveHeaderNames: ['x-goog-api-key'],
      }),
      { 'content-type': 'application/json' },
    )
    expect([...captured.sensitiveHeaderNames ?? []]).toContain('x-goog-api-key')
    expect(captured.headers['x-tenant']).toBe('acme')
  })

  it('preserves fields a pipeline adds on top of the transport snapshot', () => {
    interface WithCatalog extends HttpTransportConnection {
      readonly models: readonly string[]
    }
    const captured = captureTransportConnection<WithCatalog>(
      { ...connectionOf(), models: ['model-a'] },
      { 'content-type': 'application/json' },
    )
    expect(captured.models).toEqual(['model-a'])
  })
})
