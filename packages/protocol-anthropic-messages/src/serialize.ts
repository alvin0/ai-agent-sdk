/**
 * Normalized request to Anthropic Messages API wire JSON.
 *
 * Two things here differ sharply from the Responses API and are easy to get wrong:
 *
 * 1. `tool_use.input` is a parsed OBJECT, not a JSON string. Our normalized block
 *    keeps the raw string the model produced, so it is parsed on the way out.
 * 2. Consecutive same-role messages are MERGED. This is not cosmetic tidying —
 *    when a model makes three parallel tool calls, we produce three separate
 *    tool-result messages, and this API expects all three `tool_result` blocks in
 *    ONE user message. Without merging, parallel tool use breaks.
 *
 * @module ai-agent-sdk/providers/anthropic/serialize
 */

import type { ContentBlock } from '@alvin0/ai-agent-sdk-core'
import type { Message } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from './contract.ts'
import type { WireCacheControl, WireMessage, WireRequest, WireSystemBlock } from './wire.ts'
export { DEFAULT_MAX_TOKENS } from './serialize-types.ts'
export type { AnthropicReasoningState, ThinkingBudgets, AnthropicReasoningFormat, AnthropicSerializeOptions }
  from './serialize-types.ts'
import { DEFAULT_MAX_TOKENS, type AnthropicSerializeOptions } from './serialize-types.ts'
import { requestBlocks } from './request-blocks.ts'
import { cacheControlOf, toolsOf, toolChoiceOf, samplingOptions, reasoningOptions } from './serialize-options.ts'

function messagesOf(
  messages: readonly Message[],
  cacheControl: WireCacheControl | undefined,
): WireMessage[] {
  const result: WireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') continue // hoisted to the `system` field
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const blocks = message.content.flatMap(requestBlocks)
    if (blocks.length === 0) continue

    const previous = result.at(-1)
    if (previous !== undefined && previous.role === role) previous.content.push(...blocks)
    else result.push({ role, content: blocks })
  }
  markMessageCache(result, cacheControl)
  return result
}

function markMessageCache(messages: WireMessage[], cacheControl: WireCacheControl | undefined): void {
  if (cacheControl !== undefined && messages.length >= 2) {
    const boundary = messages[messages.length - 2]
    const lastBlock = boundary?.content.at(-1)
    if (lastBlock !== undefined) lastBlock.cache_control = cacheControl
  }
}


function systemOf(
  request: ProtocolRequest,
  cacheControl: WireCacheControl | undefined,
): string | WireSystemBlock[] | undefined {
  const fromMessages = request.options.messages
    .filter(message => message.role === 'system')
    .flatMap(message => message.content)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
  const all = request.options.system === undefined
    ? fromMessages
    : [request.options.system, ...fromMessages]
  const joined = all.join('\n\n')
  if (joined.length === 0) return undefined
  if (cacheControl === undefined) return joined
  return [{ type: 'text', text: joined, cache_control: cacheControl }]
}

export function serializeAnthropicRequest(
  request: ProtocolRequest, options: AnthropicSerializeOptions,
): WireRequest {
  const { options: call } = request
  const cacheControl = cacheControlOf(options)
  const system = systemOf(request, cacheControl)
  const tools = toolsOf(request, cacheControl)
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS
  return {
    model: call.model, max_tokens: maxTokens,
    messages: messagesOf(call.messages, cacheControl),
    ...system === undefined ? {} : { system },
    ...tools === undefined ? {} : { tools },
    ...call.toolChoice === undefined ? {} : { tool_choice: toolChoiceOf(call.toolChoice) },
    ...samplingOptions(request),
    ...reasoningOptions(request, options, maxTokens),
    stream: true,
  }
}
