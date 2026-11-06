/** HTTP/2 response stream → Fetch Response. */
import {
  constants, type ClientHttp2Stream, type IncomingHttpHeaders, type IncomingHttpStatusHeader,
} from 'node:http2'
import { finished, pipeline, type Duplex, type Readable } from 'node:stream'
import { MAX_TIMER_MS } from '@alvin0/ai-agent-sdk-core'
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

/** How the body tells the transport whether it is waiting on its reader, and how long it waits on the server. */
export interface BodyOptions {
  /** The reader stopped pulling and the queue is full: do not keep the process alive for it. */
  readonly waiting?: () => void
  /** The reader is pulling again. */
  readonly reading?: () => void
  /**
   * Give up on a body whose server sends nothing for this long while the body is
   * waiting for data (as undici's `bodyTimeout`); time a full queue waits on its
   * reader does not count. Unset: no limit.
   */
  readonly timeoutMs?: number
}

/**
 * A response dropped with its body unread would otherwise hold its stream slot
 * for as long as the server keeps the stream open. When a Response is
 * garbage-collected while nobody has started reading its body (it is not
 * locked), the body stops being held by the stream's listeners: if the caller
 * kept `response.body` it can still be read, otherwise it is collected in turn
 * (see {@link droppedBodies}). The held value never reaches the Response.
 */
const unreadResponses = new FinalizationRegistry<{ body: ReadableStream<Uint8Array>; state: BodyState }>(
  ({ body, state }) => {
    if (body.locked || state.settled) return
    state.orphan = true
    state.flowing = undefined
    droppedBodies.register(body, state)
  },
)

/** A body nobody holds any more resets its stream with CANCEL, as `fetch` does, releasing its slot. */
const droppedBodies = new FinalizationRegistry<BodyState>((state) => {
  settle(state, new Error('response body was garbage-collected before it was read'))
})

/**
 * Build the Response for one stream. The body is decoded like `fetch` decodes it
 * (gzip, deflate, br); cancelling the body resets the HTTP/2 stream with CANCEL.
 */
export function createResponse(
  stream: ClientHttp2Stream,
  incoming: IncomingHttpHeaders & IncomingHttpStatusHeader,
  request: { readonly method: string; readonly url: URL; readonly redirected: boolean },
  options: BodyOptions = {},
): Response {
  const status = Number(incoming[':status'])
  const headers = responseHeaders(incoming)
  const empty = request.method === 'HEAD' || NULL_BODY_STATUSES.has(status)
  if (empty) stream.resume()
  const state = empty ? undefined : bodyState(stream, decoded(stream, headers.get('content-encoding')), options)
  const body = state === undefined ? null : webBody(state)
  const response = new Response(body, { status, headers })
  Object.defineProperty(response, 'url', { value: request.url.href })
  if (request.redirected) Object.defineProperty(response, 'redirected', { value: true })
  if (body !== null && state !== undefined) unreadResponses.register(response, { body, state })
  return response
}

/**
 * Everything the Node stream's listeners and timer need. It holds the web
 * stream's controller strongly (`flowing`) only while data flows to a body that
 * may be read; otherwise only through a `WeakRef`, so a body nobody holds can be
 * collected even though the HTTP/2 session still references the listeners.
 */
interface BodyState {
  readonly stream: ClientHttp2Stream
  readonly source: Readable
  readonly options: BodyOptions
  settled: boolean
  /** The source is paused because the queue is full. */
  paused: boolean
  /** Its Response was collected while the body was unread; it is held weakly until someone reads it. */
  orphan: boolean
  controller: WeakRef<ReadableStreamDefaultController<Uint8Array>> | undefined
  flowing: ReadableStreamDefaultController<Uint8Array> | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

function bodyState(stream: ClientHttp2Stream, source: Readable, options: BodyOptions): BodyState {
  return { stream, source, options, settled: false, paused: false, orphan: false, controller: undefined,
    flowing: undefined, timer: undefined }
}

/**
 * The body as a web stream fed straight from the Node stream's events — one hop
 * per chunk, as `Readable.toWeb` does — whose `cancel()` resets the HTTP/2 stream
 * with CANCEL. Backpressure pauses the source once the queue is full; while it is
 * paused the stream does not keep the process alive.
 */
function webBody(state: BodyState): ReadableStream<Uint8Array> {
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    start(controller) {
      state.controller = new WeakRef(controller)
      state.flowing = controller
      feed(state)
    },
    pull(controller) {
      // Someone reads a body whose Response was dropped: hold it strongly again.
      if (state.orphan && body.locked) state.orphan = false
      if (!state.orphan && !state.settled) state.flowing = controller
      if (!state.paused) return
      state.paused = false
      state.options.reading?.()
      state.source.resume()
      armTimeout(state)
    },
    cancel(reason) { settle(state, reason) },
  }, new ByteLengthQueuingStrategy({ highWaterMark: state.source.readableHighWaterMark }))
  return body
}

/** Kept outside `webBody` so no listener's or timer's closure can hold the web stream itself. */
function feed(state: BodyState): void {
  const { source } = state
  source.on('data', (chunk: Buffer) => {
    const controller = state.flowing ?? state.controller?.deref()
    if (state.settled || controller === undefined) return
    armTimeout(state)
    // Copied, as Readable.toWeb does, so a pooled buffer is never handed out.
    controller.enqueue(new Uint8Array(chunk))
    if ((controller.desiredSize ?? 0) > 0 || state.paused) return
    state.paused = true
    state.flowing = undefined
    // Dropped, not just cleared: Node's refresh() does nothing for a cleared timer, so the
    // next pull must arm a new one.
    clearTimeout(state.timer)
    state.timer = undefined
    source.pause()
    state.options.waiting?.()
  })
  // Only the response side: a server may answer early and then stop an upload
  // still in flight (RFC 9113 §8.1), and that must not fail a complete body.
  finished(source, { writable: false }, (error) => {
    const controller = state.flowing ?? state.controller?.deref()
    if (!finish(state)) return
    if (error) controller?.error(error)
    else controller?.close()
  })
  armTimeout(state)
}

/** (Re)start the wait for the server's next chunk; the timer never keeps the process alive. */
function armTimeout(state: BodyState): void {
  const timeoutMs = state.options.timeoutMs
  if (timeoutMs === undefined || state.settled) return
  if (state.timer !== undefined) {
    state.timer.refresh()
    return
  }
  state.timer = setTimeout(() => {
    if (state.paused) return
    const error = new Error(`HTTP/2 response body received no data for ${timeoutMs} ms`)
    const controller = state.flowing ?? state.controller?.deref()
    settle(state, error)
    controller?.error(error)
  }, Math.min(timeoutMs, MAX_TIMER_MS))
  state.timer.unref()
}

/** Mark the body settled; false when it already was. */
function finish(state: BodyState): boolean {
  if (state.settled) return false
  state.settled = true
  state.flowing = undefined
  clearTimeout(state.timer)
  return true
}

/** Settle the body early: reset the HTTP/2 stream with CANCEL. */
function settle(state: BodyState, reason: unknown): void {
  if (!finish(state)) return
  cancelStream(state.stream, reason)
  if (state.source !== state.stream) state.source.destroy()
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
