/**
 * Normalized request to Responses API wire JSON.
 *
 * The interesting work is flattening. Our conversation is a list of messages,
 * each holding an ordered list of content blocks; the wire wants a FLAT list of
 * items where a tool result and a tool call are peers of a message rather than
 * parts of one. So one assistant message that reasoned, spoke, and called two
 * tools expands to four items, and their relative order must be preserved
 * because the model reads it as its own prior turn.
 *
 * @module ai-agent-sdk/providers/responses/serialize
 */

import type { ProtocolRequest } from './contract.ts'
import type { ContentBlock } from '@alvin0/ai-agent-sdk-core'
import type { ResponsesDialect, WireInputItem, WireRequest } from './wire.ts'
export type { ResponsesReasoningState } from './serialize-types.ts'
import { appendMessage } from './request-messages.ts'
import { toolsOptions, reasoningOptions, dialectOptions, samplingOptions } from './serialize-options.ts'

function instructionsOf(request: ProtocolRequest): string {
  const fromMessages = request.options.messages
    .filter(message => message.role === 'system')
    .flatMap(message => message.content)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
  const all = request.options.system === undefined
    ? fromMessages
    : [request.options.system, ...fromMessages]
  return all.join('\n\n')
}

export function serializeResponsesRequest(request: ProtocolRequest, dialect: ResponsesDialect): WireRequest {
  const input: WireInputItem[] = []
  for (const message of request.options.messages) {
    if (message.role === 'system') continue
    appendMessage(message, input, dialect.messagePhase === true)
  }
  const instructions = instructionsOf(request)
  return {
    model: request.options.model,
    ...instructions.length === 0 ? {} : { instructions },
    input,
    ...toolsOptions(request),
    ...reasoningOptions(request, dialect),
    ...dialectOptions(request, dialect),
    ...samplingOptions(request, dialect),
    stream: true,
  }
}
