/**
 * The connection snapshot every HTTP pipeline in this package shares.
 *
 * The snapshot exists to close a specific gap: if the endpoint and the credential
 * were read separately, a configuration change between the two reads would send
 * one generation's secret to another generation's URL. Reading them together, once
 * per operation, makes that impossible.
 *
 * What lives here is only what a request needs regardless of what comes back:
 * where to send it, with what credentials, under what bounds, and with which retry
 * policy. A pipeline's own vocabulary stays with the pipeline — the generation
 * catalog is on {@link ../base/http-adapter.HttpConnection}, and the embedding
 * catalog will be on its own extension, because merging the two catalogs is
 * exactly the mistake that makes one model shape stand in for another.
 *
 * @module ai-agent-sdk/providers/transport/connection
 */

import { attributionHeaders, type ResolvedRetryPolicy } from '@alvin0/ai-agent-sdk-core'
import { mergeHeaderLayers } from '../common/header-layers.ts'

/** The transport-shared half of a connection snapshot. */
export interface HttpTransportConnection {
  /** Endpoint base; the pipeline's endpoint path is appended. */
  readonly baseUrl: string
  /**
   * Every header for the request, INCLUDING authorization.
   *
   * Resolved together with the endpoint so the credential travels with the URL it
   * will be sent to. The transport adds attribution and `accept` on top.
   */
  readonly headers: Readonly<Record<string, string>>
  /** Auth-produced names that must be redacted regardless of spelling. */
  readonly sensitiveHeaderNames?: readonly string[]
  /** End-to-end request/stream timeout. */
  readonly requestTimeoutMs?: number
  /** Maximum serialized outbound request bytes. */
  readonly maxRequestBytes?: number
  /** Maximum cumulative successful response bytes. */
  readonly maxResponseBytes?: number
  /** Maximum raw chunks accepted from a successful response. */
  readonly maxResponseChunks?: number
  /** Maximum bytes read from a non-success response. */
  readonly maxErrorBodyBytes?: number
  /** Maximum time granted to the optional request logger. */
  readonly requestLoggerTimeoutMs?: number
  /** Permit cleartext HTTP explicitly, for trusted local development endpoints only. */
  readonly allowInsecureHttp?: boolean
  /** Captured fetch implementation; omission uses the platform global. */
  readonly fetch?: typeof globalThis.fetch
  /** Retry policy this route owns. */
  readonly retryPolicy: ResolvedRetryPolicy
}

/**
 * Merge the transport's own header layer beneath the snapshot's auth layer, once.
 *
 * Layer ownership is what makes this safe to call on a snapshot a subclass or a
 * configuration produced: a transport header can never silently overwrite a
 * credential, and the names the auth layer marked sensitive survive the merge so
 * redaction still covers them.
 *
 * A snapshot that already carries every layer — which configured adapters return —
 * passes an empty transport layer and is returned untouched, so capturing twice
 * cannot re-apply attribution.
 * @param connection - the snapshot captured for this operation.
 * @param transportHeaders - the transport layer to merge underneath; may be empty.
 * @returns the snapshot with merged headers and the union of sensitive names.
 */
export function captureTransportConnection<T extends HttpTransportConnection>(
  connection: T,
  transportHeaders: Readonly<Record<string, string>>,
): T {
  if (Reflect.ownKeys(transportHeaders).length === 0) return connection
  const merged = mergeHeaderLayers([
    { layer: 'transport', headers: transportHeaders },
    { layer: 'sdk-attribution', headers: attributionHeaders() },
    { layer: 'auth', headers: connection.headers },
  ])
  return Object.freeze({
    ...connection,
    headers: merged.headers,
    sensitiveHeaderNames: Object.freeze([
      ...new Set([...(connection.sensitiveHeaderNames ?? []), ...merged.sensitiveHeaderNames]),
    ]),
  })
}
