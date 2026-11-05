/** HTTP/2 response stream → Fetch Response. */
import {
  constants, type ClientHttp2Stream, type IncomingHttpHeaders, type IncomingHttpStatusHeader,
} from 'node:http2'
import { finished, pipeline, type Duplex, type Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

/** Statuses whose responses carry no body (Fetch "null body status"). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

export function responseHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(incoming)) {
    if (name.startsWith(':') || value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else headers.append(name, String(value))
  }
  return headers
}

/**
 * Stop a stream the caller no longer wants: reset it with CANCEL (RFC 9113 §8.4)
 * rather than the INTERNAL_ERROR Node sends for `destroy(error)`, then fail local
 * readers with `reason`. An exchange that already finished both ways is left to
 * close by itself — there is nothing to cancel, and resetting it would misreport it.
 */
export function cancelStream(stream: ClientHttp2Stream, reason: unknown): void {
  if (stream.destroyed || (stream.readableEnded && stream.writableFinished)) return
  if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL)
  // Already closed with CANCEL above, so this only fails local readers; no second reset is sent.
  stream.destroy(reason as Error | undefined)
}

/**
 * Build the Response for one stream. The body is decoded like `fetch` decodes it
 * (gzip, deflate, br); cancelling the body resets the HTTP/2 stream with CANCEL.
 */
export function createResponse(
  stream: ClientHttp2Stream,
  incoming: IncomingHttpHeaders & IncomingHttpStatusHeader,
  request: { readonly method: string; readonly url: URL; readonly redirected: boolean },
): Response {
  const status = Number(incoming[':status'])
  const headers = responseHeaders(incoming)
  const empty = request.method === 'HEAD' || NULL_BODY_STATUSES.has(status)
  if (empty) stream.resume()
  const body = empty ? null : webBody(stream, decoded(stream, headers.get('content-encoding')))
  const response = new Response(body, { status, headers })
  Object.defineProperty(response, 'url', { value: request.url.href })
  if (request.redirected) Object.defineProperty(response, 'redirected', { value: true })
  return response
}

/**
 * The body as a web stream fed straight from the Node stream's events — one hop
 * per chunk, as `Readable.toWeb` does — whose `cancel()` resets the HTTP/2 stream
 * with CANCEL. Backpressure pauses the source once the queue is full.
 */
function webBody(stream: ClientHttp2Stream, source: Readable): ReadableStream<Uint8Array> {
  let settled = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on('data', (chunk: Buffer) => {
        if (settled) return
        // Copied, as Readable.toWeb does, so a pooled buffer is never handed out.
        controller.enqueue(new Uint8Array(chunk))
        if ((controller.desiredSize ?? 0) <= 0) source.pause()
      })
      // Only the response side: a server may answer early and then stop an upload
      // still in flight (RFC 9113 §8.1), and that must not fail a complete body.
      finished(source, { writable: false }, (error) => {
        if (settled) return
        settled = true
        if (error) controller.error(error)
        else controller.close()
      })
    },
    pull() { source.resume() },
    cancel(reason) {
      settled = true
      cancelStream(stream, reason)
      if (source !== stream) source.destroy()
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: source.readableHighWaterMark }))
}

function decoded(stream: ClientHttp2Stream, encoding: string | null): Readable {
  const decoder = decoderFor(encoding)
  if (decoder === undefined) return stream
  // pipeline propagates errors and destroys both ends when either side ends early.
  pipeline(stream, decoder, () => undefined)
  return decoder
}

function decoderFor(encoding: string | null): Duplex | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'br':
      return createBrotliDecompress()
    default:
      return undefined
  }
}
