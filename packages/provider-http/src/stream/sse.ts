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
 * @module @alvin0/ai-agent-sdk-provider-http/sse
 */

import {
  DEFAULT_MAX_SSE_EVENT_CHARS,
  DEFAULT_MAX_SSE_EVENTS,
  DEFAULT_SSE_TEARDOWN_TIMEOUT_MS,
} from './config.ts'
import { parseSseBounded } from './parser.ts'

/**
 * Ceiling on characters the parser may buffer across reads.
 *
 * A stream that never sends an event terminator would otherwise buffer without
 * bound. 1 MiB is far above any legitimate single SSE event from either provider
 * and far below a memory problem.
 */
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
  teardownTimeoutMs = DEFAULT_SSE_TEARDOWN_TIMEOUT_MS,
): AsyncGenerator<SseEvent> {
  yield* parseSseBounded(stream, onActivity, teardownTimeoutMs, {
    maxEvents: DEFAULT_MAX_SSE_EVENTS,
    maxEventChars: DEFAULT_MAX_SSE_EVENT_CHARS,
  })
}
