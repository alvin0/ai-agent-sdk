/**
 * Decode an SSE byte stream into events.
 *
 * All the genuinely hard framing work  Echunk reassembly, UTF-8 sequences split
 * across reads, CRLF and BOM handling, comment and unknown-field skipping,
 * joining multiple `data:` lines of one event  Ebelongs to `eventsource-parser`.
 *
 * Note what is deliberately NOT decided here. OpenAI terminates with a literal
 * `data: [DONE]` sentinel; Anthropic terminates with a named `message_stop` event
 * and sends no sentinel at all. Baking in either rule would make the parser lie
 * about the other, so termination is the adapter's call and this generator simply
 * runs to the end of the body.
 *
 * The callback-based parser is used rather than `EventSourceParserStream` so the
 * SDK does not require `TextDecoderStream` to exist  Eit is absent on some
 * runtimes this package should still work on.
 *
 * @module ai-agent-sdk/core/stream/sse
 */

import { createParser } from 'eventsource-parser'
import { waitForSettlement } from '../runtime/settlement.ts'

/**
 * Ceiling on characters the parser may buffer across reads.
 *
 * A stream that never sends an event terminator would otherwise buffer without
 * bound. 1 MiB is far above any legitimate single SSE event from either provider
 * and far below a memory problem.
 */
const MAX_SSE_BUFFER_CHARS = 1_048_576

/** One decoded server-sent event. */
export interface SseEvent {
  /**
   * The event name, or `undefined` when the server declared none.
   *
   * NOT defaulted to `'message'` the way a browser `EventSource` would. Absence is
   * reported faithfully, which is what lets an adapter tell Anthropic's named
   * events apart from OpenAI's anonymous data-only frames.
   */
  event: string | undefined
  /** The event's data payload. */
  data: string
}

/**
 * Parse an SSE byte stream into events, in arrival order.
 *
 * Framing is spec-strict: an event dispatches only on its blank-line terminator,
 * so an unterminated tail at EOF is truncation rather than a flushable payload.
 * @param stream - raw SSE bytes, as `Response.body` provides them. Reads may split
 *   anywhere, including mid-codepoint; the streaming decoder handles that.
 * @param onActivity - called on every frame INCLUDING comments. Providers send
 *   comment-only keepalives during long pauses, so a liveness watchdog has to
 *   count them as activity even though they carry no data.
 * @returns each event in arrival order; returns normally at end of body.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  teardownTimeoutMs = 30_000,
): AsyncGenerator<SseEvent> {
  // The parser reports events through callbacks, so they are queued here and
  // drained after each read. Draining between reads (rather than accumulating)
  // keeps the queue bounded by one network chunk's worth of events.
  const pending: SseEvent[] = []
  const parser = createParser({
    maxBufferSize: MAX_SSE_BUFFER_CHARS,
    onEvent(event) {
      pending.push({ event: event.event, data: event.data })
    },
    onComment() {
      onActivity?.()
    },
  })

  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let drained = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      if (value !== undefined) parser.feed(decoder.decode(value, { stream: true }))
      yield* drain(pending)
    }
    // Flush any bytes the streaming decoder was holding for a split codepoint.
    const tail = decoder.decode()
    if (tail.length > 0) {
      parser.feed(tail)
      yield* drain(pending)
    }
    drained = true
  } finally {
    // The consumer stopped early, or a read failed. Cancelling is what actually
    // tears down the underlying HTTP response instead of leaking the connection;
    // it also releases the reader lock.
    if (drained) reader.releaseLock()
    else if (!await waitForSettlement(reader.cancel().catch(() => undefined), teardownTimeoutMs)) {
      throw new Error(`SSE body ignored cancellation for more than ${teardownTimeoutMs}ms`)
    }
  }
}

/** Yield and remove every queued event, preserving arrival order. */
function* drain(pending: SseEvent[]): Generator<SseEvent> {
  while (pending.length > 0) {
    const event = pending.shift()
    if (event === undefined) return
    yield event
  }
}
