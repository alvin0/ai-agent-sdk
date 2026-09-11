/**
 * SSE frames for the two wire protocols one Copilot route serves.
 *
 * Copilot is the only provider in this repository whose single route dispatches
 * to TWO endpoints — `/responses` and `/chat/completions` — so the conformance
 * data has to exist twice: the request bodies differ (`input` versus `messages`)
 * and so do the stream shapes. Everything else about a conformance run is shared,
 * which is why only the frames and the endpoint override live here and no
 * assertion does.
 *
 * Each protocol declares the same three variants the generic runner asks for:
 * a complete stream with authoritative usage, one with the usage payload absent,
 * and one whose usage contradicts itself. Totals match across both protocols
 * (3 input + 2 output = 5) so the two runs can share `expectedTotalTokens`.
 *
 * @module ai-agent-sdk/testkit/provider/copilot/frames
 */

/** The three stream variants the generic conformance runner drives. */
export interface CopilotConformanceFrames {
  /** A complete stream whose usage is authoritative and internally consistent. */
  readonly completeFrames: readonly string[]
  /** The same stream with no usage payload at all. */
  readonly missingUsageFrames: readonly string[]
  /** The same stream with a total that contradicts its own parts. */
  readonly malformedUsageFrames: readonly string[]
}

/** Text body every complete stream produces, on both protocols. */
export const COPILOT_CONFORMANCE_TEXT = 'ok'

/** The `/responses` prelude, up to but excluding the terminal event. */
const RESPONSES_PRELUDE: readonly string[] = Object.freeze([
  'data: {"type":"response.created","response":{"id":"copilot-r1"}}',
  'data: {"type":"response.output_item.added","item":{"id":"i1","type":"message"}}',
  `data: {"type":"response.output_text.delta","item_id":"i1","delta":"${COPILOT_CONFORMANCE_TEXT}"}`,
  'data: {"type":"response.output_item.done","item":{"id":"i1","type":"message",'
    + `"content":[{"type":"output_text","text":"${COPILOT_CONFORMANCE_TEXT}"}]}}`,
])

/**
 * `/responses` frames.
 *
 * Usage rides on the terminal `response.completed` event, which is where this
 * endpoint reports it.
 */
export const COPILOT_RESPONSES_FRAMES: CopilotConformanceFrames = Object.freeze({
  completeFrames: Object.freeze([
    ...RESPONSES_PRELUDE,
    'data: {"type":"response.completed","response":{"id":"copilot-r1",'
      + '"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}',
  ]),
  missingUsageFrames: Object.freeze([
    ...RESPONSES_PRELUDE,
    'data: {"type":"response.completed","response":{"id":"copilot-r1"}}',
  ]),
  malformedUsageFrames: Object.freeze([
    ...RESPONSES_PRELUDE,
    'data: {"type":"response.completed","response":{"id":"copilot-r1",'
      + '"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":1}}}',
  ]),
})

/** The `/chat/completions` prelude, up to but excluding the usage-only chunk. */
const CHAT_PRELUDE: readonly string[] = Object.freeze([
  'data: {"id":"chatcmpl-copilot","object":"chat.completion.chunk",'
    + '"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  'data: {"id":"chatcmpl-copilot","object":"chat.completion.chunk",'
    + `"choices":[{"index":0,"delta":{"content":"${COPILOT_CONFORMANCE_TEXT}"},"finish_reason":null}]}`,
  'data: {"id":"chatcmpl-copilot","object":"chat.completion.chunk",'
    + '"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
])

/**
 * `/chat/completions` frames.
 *
 * Usage arrives AFTER the terminal finish, on a chunk carrying no choices — the
 * opposite placement from `/responses`, and the reason the two protocols need
 * separate data rather than a shared template.
 */
export const COPILOT_CHAT_COMPLETIONS_FRAMES: CopilotConformanceFrames = Object.freeze({
  completeFrames: Object.freeze([
    ...CHAT_PRELUDE,
    'data: {"id":"chatcmpl-copilot","object":"chat.completion.chunk","choices":[],'
      + '"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
  ]),
  missingUsageFrames: Object.freeze([...CHAT_PRELUDE]),
  malformedUsageFrames: Object.freeze([
    ...CHAT_PRELUDE,
    'data: {"id":"chatcmpl-copilot","object":"chat.completion.chunk","choices":[],'
      + '"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":1}}',
  ]),
})
