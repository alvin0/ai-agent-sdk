/** Fetch Request → HTTP/2 request headers and body. */
import type { OutgoingHttpHeaders } from 'node:http2'

/** Connection-specific fields are forbidden on HTTP/2 (RFC 9113 §8.2.2). */
const CONNECTION_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host',
])

export const DEFAULT_ACCEPT_ENCODING = 'gzip, deflate, br'
export const DEFAULT_USER_AGENT = 'node'

/** Fetch argument types, derived so this package needs no DOM lib. */
export type FetchInput = Parameters<typeof globalThis.fetch>[0]
export type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>
export type FetchBody = NonNullable<FetchInit['body']>

export interface PreparedRequest {
  readonly url: URL
  readonly method: string
  readonly headers: Headers
  /** Buffered body; replayable for redirects and refused-stream retries. */
  readonly bytes: Uint8Array | undefined
  /** Streaming body; sent once and never replayed. */
  readonly stream: ReadableStream<Uint8Array> | undefined
  readonly signal: AbortSignal
  readonly redirect: Request['redirect']
}

/**
 * Normalize through the platform `Request` so header defaults (content-type for a
 * string or form body), method validation and signal handling match `fetch`. A
 * `ReadableStream` body is streamed; every other body is buffered once, which gives
 * an exact content-length and lets a refused stream or a 307/308 be replayed.
 */
export async function prepareRequest(input: FetchInput, init: FetchInit | undefined): Promise<PreparedRequest> {
  const request = new Request(input, init)
  const streaming = init?.body instanceof ReadableStream
  const bytes = request.body === null || streaming ? undefined : new Uint8Array(await request.arrayBuffer())
  return {
    url: new URL(request.url),
    method: request.method,
    headers: new Headers(request.headers),
    bytes,
    stream: streaming ? request.body ?? undefined : undefined,
    signal: request.signal,
    redirect: request.redirect,
  }
}

export function outgoingHeaders(prepared: PreparedRequest): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    ':method': prepared.method,
    ':path': `${prepared.url.pathname}${prepared.url.search}`,
  }
  for (const [name, value] of prepared.headers) {
    if (CONNECTION_HEADERS.has(name) || (name === 'te' && value !== 'trailers')) continue
    headers[name] = value
  }
  headers['accept-encoding'] ??= DEFAULT_ACCEPT_ENCODING
  // Node's fetch sends this when the caller sets none; some APIs (GitHub) reject requests without one.
  headers['user-agent'] ??= DEFAULT_USER_AGENT
  if (prepared.bytes !== undefined) headers['content-length'] = String(prepared.bytes.byteLength)
  return headers
}
