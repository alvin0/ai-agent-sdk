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

import {
  isNativeToolSchema,
  type ModelToolSchema,
  type NativeWebSearchTool,
  type ToolChoice,
  type ToolSchema,
} from '../../core/contract/tool.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../core/errors/model-error.ts'
import type { ContentBlock, ImageSource } from '../../core/message/content.ts'
import type { Message } from '../../core/message/message.ts'
import type { ProviderRequest } from '../base/http-adapter.ts'
import type {
  WireImageSource,
  WireCitation,
  WireMessage,
  WireRequest,
  WireRequestBlock,
  WireThinking,
  WireTool,
  WireToolChoice,
  WireToolResultContent,
} from './wire.ts'

/**
 * Adapter-private state kept on a {@link ReasoningBlock} so a thinking block can
 * be echoed back exactly.
 *
 * The signature is the load-bearing part: this API verifies it to confirm the
 * block is genuinely the model's own reasoning, and a thinking block sent back
 * without it is rejected.
 */
export interface AnthropicReasoningState {
  /** `thinking` for an ordinary block, `redacted_thinking` for an opaque one. */
  kind: 'thinking' | 'redacted_thinking'
  /** Cryptographic signature over the thinking content. */
  signature?: string
  /** Opaque payload of a redacted block. */
  data?: string
}

/** Read reasoning state back off a block, tolerating anything unexpected. */
function reasoningStateOf(value: unknown): AnthropicReasoningState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as AnthropicReasoningState
  if (state.kind !== 'thinking' && state.kind !== 'redacted_thinking') return undefined
  return {
    kind: state.kind,
    ...typeof state.signature === 'string' ? { signature: state.signature } : {},
    ...typeof state.data === 'string' ? { data: state.data } : {},
  }
}

/** Map an image source onto this API's tagged source object. */
function imageSource(source: ImageSource): WireImageSource {
  if (source.kind === 'url') return { type: 'url', url: source.url }
  if (source.kind === 'base64') {
    return { type: 'base64', media_type: source.mediaType, data: source.data }
  }
  throw new ModelError(
    'Anthropic image inputs support URL or base64 sources, not file ids',
    MODEL_ERROR_CODES.INVALID_REQUEST,
  )
}

/** Restrict tool-result content to the block types this API accepts there. */
function toolResultContent(blocks: readonly ContentBlock[]): WireToolResultContent[] | string {
  const parts: WireToolResultContent[] = []
  let textOnly = true
  for (const block of blocks) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') {
      textOnly = false
      parts.push({ type: 'image', source: imageSource(block.source) })
    }
    // Anything else (a nested tool result, an extension block) has no
    // representation inside a tool result and is dropped rather than guessed at.
  }
  if (textOnly) {
    return parts.map(part => (part.type === 'text' ? part.text : '')).join('\n')
  }
  return parts
}

/** Parse tool-call arguments into the object this API expects. */
function toolInput(raw: string): unknown {
  if (raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    // The model emitted invalid JSON. Sending `{}` keeps the conversation
    // well-formed so the tool layer can report the problem back to the model,
    // which is recoverable; failing the request here is not.
    return {}
  }
}

function citationOf(value: unknown): WireCitation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const citation = value as Record<string, unknown>
  return typeof citation.type === 'string' ? structuredClone(citation) as WireCitation : undefined
}

function nativeReplayBlocks(value: unknown): WireRequestBlock[] {
  if (typeof value !== 'object' || value === null) return []
  const state = value as Record<string, unknown>
  const values = [state.call, state.result]
  return values.flatMap((candidate): WireRequestBlock[] => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const block = candidate as Record<string, unknown>
    if (block.type === 'server_tool_use'
      && typeof block.id === 'string'
      && typeof block.name === 'string') {
      return [{
        type: 'server_tool_use', id: block.id, name: block.name,
        input: structuredClone(block.input ?? {}),
      }]
    }
    if (block.type === 'web_search_tool_result' && typeof block.tool_use_id === 'string') {
      return [{
        type: 'web_search_tool_result', tool_use_id: block.tool_use_id,
        content: structuredClone(block.content),
        ...block.caller === undefined ? {} : { caller: structuredClone(block.caller) },
      }]
    }
    return []
  })
}

/** Convert one normalized block to zero or more wire blocks. */
function requestBlocks(block: ContentBlock): WireRequestBlock[] {
  switch (block.type) {
    case 'text': {
      // Whitespace-only text is rejected by this API, so it is dropped.
      if (block.text.trim().length === 0) return []
      const citations = block.annotations?.flatMap((annotation): WireCitation[] => {
        if (annotation.type !== 'url-citation') return []
        const citation = citationOf(annotation.providerState)
        return citation === undefined ? [] : [citation]
      })
      return [{
        type: 'text', text: block.text,
        ...citations === undefined || citations.length === 0 ? {} : { citations },
      }]
    }
    case 'image':
      return [{ type: 'image', source: imageSource(block.source) }]
    case 'tool-call':
      return [{
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: toolInput(block.arguments),
      }]
    case 'tool-result':
      return [{
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: toolResultContent(block.content),
        ...block.isError === true ? { is_error: true } : {},
      }]
    case 'native-tool-call':
      return nativeReplayBlocks(block.providerState)
    case 'reasoning': {
      const state = reasoningStateOf(block.providerState)
      if (state === undefined) {
        // No signature means this cannot be replayed as a thinking block. Dropping
        // it is correct: sending unsigned thinking is rejected outright.
        return []
      }
      if (state.kind === 'redacted_thinking') {
        return state.data === undefined ? [] : [{ type: 'redacted_thinking', data: state.data }]
      }
      return state.signature === undefined
        ? []
        : [{ type: 'thinking', thinking: block.text, signature: state.signature }]
    }
    default:
      return []
  }
}

/**
 * Build the message list, merging consecutive same-role messages.
 *
 * See the module note for why merging matters.
 */
function messagesOf(messages: readonly Message[]): WireMessage[] {
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
  return result
}

/** Collect the system prompt from the request plus any system-role messages. */
function systemOf(request: ProviderRequest): string | undefined {
  const fromMessages = request.options.messages
    .filter(message => message.role === 'system')
    .flatMap(message => message.content)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
  const all = request.options.system === undefined
    ? fromMessages
    : [request.options.system, ...fromMessages]
  const joined = all.join('\n\n')
  return joined.length === 0 ? undefined : joined
}

/** Map the neutral tool-choice vocabulary onto this API's. */
function toolChoiceOf(choice: ToolChoice): WireToolChoice {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  // "call some tool" is spelled `any` here, not `required`.
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.type === 'native' ? nativeToolName(choice.name) : choice.name }
}

function functionTool(tool: ToolSchema): WireTool {
  return { name: tool.name, description: tool.description, input_schema: tool.parameters }
}

function nativeToolName(name: string): string {
  if (name === 'web-search') return 'web_search'
  return name.replaceAll('-', '_')
}

function webSearchTool(tool: NativeWebSearchTool): WireTool {
  if (tool.allowedDomains !== undefined && tool.blockedDomains !== undefined) {
    throw new ModelError(
      'Anthropic web search accepts allowedDomains or blockedDomains, not both',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return {
    type: 'web_search_20250305',
    name: 'web_search',
    ...tool.maxUses === undefined ? {} : { max_uses: tool.maxUses },
    ...tool.allowedDomains === undefined ? {} : { allowed_domains: [...tool.allowedDomains] },
    ...tool.blockedDomains === undefined ? {} : { blocked_domains: [...tool.blockedDomains] },
    ...tool.userLocation === undefined ? {} : {
      user_location: { type: 'approximate', ...tool.userLocation },
    },
  }
}

function toolOf(tool: ModelToolSchema): WireTool {
  if (!isNativeToolSchema(tool)) return functionTool(tool)
  if (tool.name === 'web-search') return webSearchTool(tool)
  throw new ModelError(
    `Anthropic does not support the provider-native tool '${tool.name}'`,
    MODEL_ERROR_CODES.INVALID_REQUEST,
  )
}

/** How a reasoning effort becomes a thinking token budget. */
export type ThinkingBudgets = Readonly<Record<string, number>>

/** Options controlling how the request is built. */
export interface AnthropicSerializeOptions {
  /** Effort id to thinking-token budget. An absent or zero budget disables thinking. */
  budgets: ThinkingBudgets
}

/**
 * Resolve the `thinking` field for this request.
 *
 * The budget must leave room for a real answer, so it is capped below
 * `max_tokens` — this API requires `budget_tokens < max_tokens` and rejects the
 * request otherwise.
 */
function thinkingOf(
  effort: string | undefined,
  maxTokens: number,
  budgets: ThinkingBudgets,
): WireThinking | undefined {
  if (effort === undefined) return undefined
  const requested = budgets[effort]
  if (requested === undefined || requested <= 0) return { type: 'disabled' }
  // Leave at least a quarter of the budget for the visible answer.
  const capped = Math.min(requested, Math.floor(maxTokens * 0.75))
  // This API's own floor for extended thinking.
  return capped < 1_024 ? { type: 'disabled' } : { type: 'enabled', budget_tokens: capped }
}

/**
 * Build the Messages request body.
 * @param request - the resolved request, model, and connection.
 * @param options - thinking-budget mapping.
 * @returns the wire body, ready to serialize.
 */
export function serializeAnthropicRequest(
  request: ProviderRequest,
  options: AnthropicSerializeOptions,
): WireRequest {
  const { options: call } = request
  const system = systemOf(request)
  const tools = call.tools === undefined || call.tools.length === 0
    ? undefined
    : call.tools.map(toolOf)
  const thinking = thinkingOf(
    call.reasoningEffort === undefined ? undefined : String(call.reasoningEffort),
    request.maxTokens,
    options.budgets,
  )
  const thinkingEnabled = thinking?.type === 'enabled'

  return {
    model: call.model,
    // Required by this API — unlike most others, omitting it is an error.
    max_tokens: request.maxTokens,
    messages: messagesOf(call.messages),
    ...system === undefined ? {} : { system },
    ...tools === undefined ? {} : { tools },
    ...call.toolChoice === undefined ? {} : { tool_choice: toolChoiceOf(call.toolChoice) },
    // Extended thinking is incompatible with sampling adjustments; sending both
    // is rejected, so the sampling knobs are dropped when thinking is on.
    ...!thinkingEnabled && call.temperature !== undefined
      ? { temperature: call.temperature }
      : {},
    ...!thinkingEnabled && call.topP !== undefined ? { top_p: call.topP } : {},
    ...call.stop === undefined || call.stop.length === 0
      ? {}
      : { stop_sequences: [...call.stop] },
    ...thinking === undefined ? {} : { thinking },
    stream: true,
  }
}
