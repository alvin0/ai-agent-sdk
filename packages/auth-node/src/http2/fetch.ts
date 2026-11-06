/**
 * A `fetch` that multiplexes HTTPS requests over `node:http2` sessions.
 *
 * Node's bundled undici (Node 26: undici 8.x) negotiates HTTP/2 but serializes
 * non-idempotent requests on an established session, so concurrent POSTs — every
 * model call — wait for each other's whole streamed response
 * (https://github.com/nodejs/undici/issues/5390). This transport keeps HTTP/2 and
 * sends each request as its own stream on a shared session.
 */
import { pipeline, Readable } from 'node:stream'
import type { ClientHttp2Stream, SecureClientSessionOptions } from 'node:http2'
import { Http2ClosedError, Http2SessionPool, Http2UnsupportedError, type Http2Lease } from './pool.ts'
import {
  outgoingHeaders, prepareRequest, type FetchBody, type FetchInit, type FetchInput, type PreparedRequest,
} from './request.ts'
import { cancelStream, createResponse } from './response.ts'

export interface NodeHttp2FetchOptions {
  /** Most concurrent streams one session carries before another is opened (default 100). */
  readonly maxStreamsPerSession?: number
  /** Close a session after this long without an active stream (default 30 s). */
  readonly idleTimeoutMs?: number
  /** Give up connecting a session after this long (default 10 s). */
  readonly connectTimeoutMs?: number
  /**
   * Fail a response body whose server sends nothing for this long while the body
   * waits for data (default 5 min, as undici's `bodyTimeout`), so a stream the
   * server leaves open releases its slot. Time a body waits on a reader that is not
   * reading does not count.
   */
  readonly bodyTimeoutMs?: number
  /**
   * How long an origin that does not negotiate h2 is sent straight through
   * `fallback` (default 5 min). A connect that failed for another reason (DNS,
   * refused, timed out) is remembered for at most 5 s, so one transient failure
   * does not move the origin off HTTP/2 for long.
   */
  readonly fallbackTtlMs?: number
  /** TLS options for new sessions, e.g. a private `ca`. */
  readonly tls?: SecureClientSessionOptions
  /**
   * Used for `http:` URLs, origins without h2, and connection failures (default:
   * global `fetch`, or the one it replaced when this transport is installed as the
   * global). Never used after `close()`: requests then reject.
   */
  readonly fallback?: typeof globalThis.fetch
}

/** A `fetch` with a `close()` that closes every pooled session. */
export type NodeHttp2Fetch = typeof globalThis.fetch & { close(): Promise<void> }

const DEFAULTS = Object.freeze({
  maxStreamsPerSession: 100, idleTimeoutMs: 30_000, connectTimeoutMs: 10_000, fallbackTtlMs: 300_000,
  bodyTimeoutMs: 300_000,
})
/** How long a transient connect failure (DNS, refused, timeout) keeps an origin on the fallback. */
const CONNECT_FAILURE_TTL_MS = 5_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20
/** Session-level failures where the server provably did not process the stream. */
const UNPROCESSED = ['NGHTTP2_REFUSED_STREAM', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_INVALID_SESSION']

interface DispatchState {
  readonly redirects: number
  readonly retried: boolean
}

/**
 * Create a `fetch` for provider options, e.g.
 * `openAiPlugin({ apiKey, fetch: createNodeHttp2Fetch() })`.
 */
export function createNodeHttp2Fetch(options: NodeHttp2FetchOptions = {}): NodeHttp2Fetch {
  // The default fallback is the global `fetch` at call time, unless the application
  // installed this transport as the global itself; calling it would loop back here,
  // so the `fetch` it replaced is used instead.
  const replaced = globalThis.fetch
  const fallback = options.fallback ?? (async (input, init) => {
    const current = globalThis.fetch
    return await (current === fetchImpl ? replaced : current)(input, init)
  })
  const client = new Http2FetchClient(options, fallback)
  const fetchImpl = (async (input: FetchInput, init?: FetchInit) =>
    await client.fetch(input, init)) as NodeHttp2Fetch
  fetchImpl.close = async () => { await client.close() }
  return Object.freeze(fetchImpl)
}

class Http2FetchClient {
  private readonly pool: Http2SessionPool
  private readonly fallbackUntil = new Map<string, number>()
  private readonly fallback: typeof globalThis.fetch
  private readonly fallbackTtlMs: number
  private readonly bodyTimeoutMs: number
  private closed = false

  constructor(options: NodeHttp2FetchOptions, fallback: typeof globalThis.fetch) {
    this.pool = new Http2SessionPool({
      maxStreamsPerSession: positive(options.maxStreamsPerSession ?? DEFAULTS.maxStreamsPerSession),
      idleTimeoutMs: positive(options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs),
      connectTimeoutMs: positive(options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs),
      ...(options.tls === undefined ? {} : { connect: options.tls }),
    })
    this.fallback = fallback
    this.fallbackTtlMs = positive(options.fallbackTtlMs ?? DEFAULTS.fallbackTtlMs)
    this.bodyTimeoutMs = positive(options.bodyTimeoutMs ?? DEFAULTS.bodyTimeoutMs)
  }

  async fetch(input: FetchInput, init: FetchInit | undefined): Promise<Response> {
    if (this.closed) throw fetchFailed(new Http2ClosedError())
    if (!this.usesHttp2(requestUrl(input))) return await this.fallback(input, init)
    return await this.dispatch(await prepareRequest(input, init), { redirects: 0, retried: false })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.pool.close()
  }

  private usesHttp2(url: URL): boolean {
    return url.protocol === 'https:' && (this.fallbackUntil.get(url.origin) ?? 0) <= Date.now()
  }

  private async dispatch(prepared: PreparedRequest, state: DispatchState): Promise<Response> {
    if (!this.usesHttp2(prepared.url)) return await this.viaFallback(prepared)
    let lease: Http2Lease
    try {
      lease = await this.pool.acquire(prepared.url.origin, prepared.signal)
    } catch (error: unknown) {
      if (prepared.signal.aborted) throw prepared.signal.reason
      if (error instanceof Http2ClosedError) throw fetchFailed(error)
      // No h2: remember it for the full window. Any other connect failure may be a
      // blip (DNS, refused, timeout), so it is remembered only briefly — long enough
      // that a burst does not each wait on a failing connect, short enough that the
      // origin soon gets HTTP/2 back. The platform fetch reports a real connection
      // failure in its own terms.
      const ttl = error instanceof Http2UnsupportedError
        ? this.fallbackTtlMs
        : Math.min(this.fallbackTtlMs, CONNECT_FAILURE_TTL_MS)
      this.fallbackUntil.set(prepared.url.origin, Date.now() + ttl)
      return await this.viaFallback(prepared)
    }
    let response: Response
    try {
      response = await exchange(lease, prepared, state.redirects > 0, this.bodyTimeoutMs)
    } catch (error: unknown) {
      if (state.retried || !retryable(error, prepared)) throw error
      return await this.dispatch(prepared, { ...state, retried: true })
    }
    return await this.followRedirect(prepared, response, state)
  }

  private async followRedirect(prepared: PreparedRequest, response: Response, state: DispatchState): Promise<Response> {
    const location = response.headers.get('location')
    if (!REDIRECT_STATUSES.has(response.status) || location === null || prepared.redirect === 'manual') return response
    await response.body?.cancel().catch(() => undefined)
    if (prepared.redirect === 'error') throw fetchFailed(new Error('unexpected redirect'))
    if (state.redirects >= MAX_REDIRECTS) throw fetchFailed(new Error('redirect count exceeded'))
    const next = redirectRequest(prepared, new URL(location, prepared.url), response.status)
    return await this.dispatch(next, { redirects: state.redirects + 1, retried: false })
  }

  private async viaFallback(prepared: PreparedRequest): Promise<Response> {
    const body = prepared.stream ?? prepared.bytes
    return await this.fallback(prepared.url, {
      method: prepared.method, headers: prepared.headers, signal: prepared.signal, redirect: prepared.redirect,
      ...(body === undefined ? {} : { body: body as FetchBody }),
      ...(prepared.stream === undefined ? {} : { duplex: 'half' }),
    } as FetchInit)
  }
}

/**
 * Send one request as one stream; resolves at response headers, releases the slot
 * when the stream closes. While the body waits on a reader that is not reading,
 * the stream keeps its slot but no longer keeps the process alive.
 */
function exchange(
  lease: Http2Lease, prepared: PreparedRequest, redirected: boolean, bodyTimeoutMs: number,
): Promise<Response> {
  const { signal } = prepared
  if (signal.aborted) {
    lease.release()
    return Promise.reject(signal.reason)
  }
  let stream: ClientHttp2Stream
  try {
    const hasBody = prepared.bytes !== undefined || prepared.stream !== undefined
    stream = lease.session.request(outgoingHeaders(prepared), { endStream: !hasBody })
  } catch (error: unknown) {
    lease.release()
    return Promise.reject(fetchFailed(error))
  }
  // Errors after the response are delivered through the body; never leave one unhandled.
  stream.on('error', () => undefined)
  const abort = () => { cancelStream(stream, signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  stream.once('close', () => {
    signal.removeEventListener('abort', abort)
    lease.release()
  })
  writeBody(stream, prepared)
  return new Promise<Response>((resolve, reject) => {
    const fail = (error: unknown) => { reject(signal.aborted ? signal.reason : fetchFailed(error)) }
    const closed = () => { fail(new Error(`HTTP/2 stream closed (code ${stream.rstCode})`)) }
    stream.once('error', fail)
    stream.once('close', closed)
    stream.once('response', (headers) => {
      // Detach both: a listener that can still reach this promise would keep the
      // Response, and so its body, alive for as long as the stream stays open.
      stream.off('error', fail)
      stream.off('close', closed)
      resolve(createResponse(stream, headers, { method: prepared.method, url: prepared.url, redirected },
        { waiting: lease.unhold, reading: lease.hold, timeoutMs: bodyTimeoutMs }))
    })
  })
}

function writeBody(stream: ClientHttp2Stream, prepared: PreparedRequest): void {
  if (prepared.bytes !== undefined) {
    stream.end(prepared.bytes)
    return
  }
  if (prepared.stream === undefined) return
  pipeline(Readable.fromWeb(prepared.stream as import('node:stream/web').ReadableStream), stream, (error) => {
    if (error) stream.destroy(error)
  })
}

/** Redirect per Fetch: 303 (and 301/302 for POST) become GET; credentials stay on their origin. */
function redirectRequest(prepared: PreparedRequest, url: URL, status: number): PreparedRequest {
  const toGet = (status === 303 && prepared.method !== 'HEAD')
    || ((status === 301 || status === 302) && prepared.method === 'POST')
  if (!toGet && prepared.stream !== undefined) throw fetchFailed(new Error('cannot replay a streamed body'))
  return {
    ...prepared, url,
    headers: redirectHeaders(prepared.headers, url.origin !== prepared.url.origin, toGet),
    method: toGet ? 'GET' : prepared.method,
    bytes: toGet ? undefined : prepared.bytes,
    stream: undefined,
  }
}

const CREDENTIAL_HEADERS = ['authorization', 'cookie']
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language']

function redirectHeaders(source: Headers, crossOrigin: boolean, toGet: boolean): Headers {
  const headers = new Headers(source)
  const removed = [...crossOrigin ? CREDENTIAL_HEADERS : [], ...toGet ? BODY_HEADERS : []]
  for (const name of removed) headers.delete(name)
  return headers
}

function retryable(error: unknown, prepared: PreparedRequest): boolean {
  if (prepared.stream !== undefined || prepared.signal.aborted) return false
  const cause = (error as { cause?: unknown } | undefined)?.cause as { code?: unknown; message?: unknown } | undefined
  const text = `${String(cause?.code ?? '')} ${String(cause?.message ?? '')}`
  return UNPROCESSED.some(marker => text.includes(marker))
}

function requestUrl(input: FetchInput): URL {
  if (input instanceof URL) return input
  return new URL(typeof input === 'string' ? input : input.url)
}

function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

function positive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('HTTP/2 fetch limits must be positive numbers')
  return value
}
