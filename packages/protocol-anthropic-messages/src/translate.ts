/**
 * Anthropic Messages API SSE events to the SDK's chunk protocol.
 *
 * Notable differences from the Responses translation:
 *
 * - Block indices come straight from the provider. This API numbers content
 *   blocks contiguously from zero in emission order, which is already exactly
 *   what our protocol wants, so no remapping is needed.
 * - Usage arrives in TWO places: input counts on `message_start`, output counts on
 *   `message_delta`. Cumulative snapshots are emitted as usage-progress; the
 *   final usage is emitted once at message_stop, before the finish.
 * - `input_tokens` here already EXCLUDES cached tokens, so unlike the Responses
 *   translation nothing is subtracted. Getting this backwards would under-report
 *   input on every cached call.
 *
 * @module ai-agent-sdk/providers/anthropic/translate
 */

import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolSseEvent, ProtocolStreamChunk } from './contract.ts'
import type { WireStreamEvent } from './wire.ts'
import { translateEvent, type StreamState } from './stream-events.ts'

export async function* translateAnthropicStream(
  events: AsyncIterable<ProtocolSseEvent>, displayName: string,
): AsyncGenerator<ProtocolStreamChunk> {
  const state: StreamState = {
    open: new Map(), emittedBlocks: 0, stop: undefined,
    usage: { input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined, seen: false },
  }
  for await (const raw of events) {
    const event = parseEvent(raw, displayName)
    yield* translateEvent(state, event, displayName)
    if (event.type === 'message_stop') return
  }
  throw new ModelError(
    `${displayName} stream ended before message_stop`,
    MODEL_ERROR_CODES.STREAM_CLOSED,
  )
}

function parseEvent(raw: ProtocolSseEvent, displayName: string): WireStreamEvent {
  try { return JSON.parse(raw.data) as WireStreamEvent }
  catch (error: unknown) {
    throw new ModelError(
      `${displayName} sent a malformed stream event`,
      MODEL_ERROR_CODES.MALFORMED_RESPONSE, { cause: error },
    )
  }
}
