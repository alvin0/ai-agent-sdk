/**
 * Responses API SSE events to the SDK's chunk protocol.
 *
 * Two design notes worth reading before changing anything here.
 *
 * First, block correlation is keyed on `item_id`, not on the provider's
 * `output_index`. Item ids are stable and present on every delta event, whereas
 * index fields vary by event type, so keying on the id and assigning our OWN
 * indices in first-seen order is both simpler and closer to what our protocol
 * promises.
 *
 * Second, reasoning state is carried on the reasoning BLOCK
 * (`ReasoningBlock.providerState`) rather than in the stream's `replayState`
 * envelope. The envelope has to stay positionally aligned with emitted blocks and
 * is discarded whole when it drifts; attaching the state to the block it belongs
 * to cannot drift, and it survives assembly for free.
 *
 * @module ai-agent-sdk/providers/responses/translate
 */

import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk } from './contract.ts'
import type { WireStreamEvent } from './wire.ts'
import { requestedImageMediaType } from './stream-items.ts'
import { translateEvent, type StreamState } from './stream-events.ts'

export async function* translateResponsesStream(
  events: AsyncIterable<ProtocolSseEvent>, displayName: string, request?: ProtocolRequest,
): AsyncGenerator<ProtocolStreamChunk> {
  const state: StreamState = {
    open: new Map(), nextIndex: 0, sawToolCall: false, imageMediaType: requestedImageMediaType(request),
  }
  for await (const raw of events) {
    const event = parseEvent(raw, displayName)
    yield* translateEvent(state, event, displayName)
    if (event.type === 'response.completed' || event.type === 'response.incomplete') return
  }
  throw new ModelError(
    `${displayName} stream ended before the response completed`,
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
