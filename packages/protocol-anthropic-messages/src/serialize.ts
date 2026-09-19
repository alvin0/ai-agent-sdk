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
  type ModelOutputFormat,
  type ModelToolSchema,
  type NativeWebSearchTool,
  type ToolChoice,
  type ToolSchema,
} from '@alvin0/ai-agent-sdk-core'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, DocumentSource, ImageSource } from '@alvin0/ai-agent-sdk-core'
import type { Message } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from './contract.ts'
import type {
  WireCacheControl,
  WireDocumentSource,
  WireImageSource,
  WireCitation,
  WireMessage,
  WireOutputConfig,
  WireRequest,
  WireRequestBlock,
  WireSystemBlock,
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

/**
 * Map a document source onto this API's tagged source object.
 *
 * All three variants are supported here, including the file id that
 * {@link imageSource} has to reject.
 */
function documentSource(source: DocumentSource): WireDocumentSource {
  if (source.kind === 'url') return { type: 'url', url: source.url }
  if (source.kind === 'file') return { type: 'file', file_id: source.fileId }
  return { type: 'base64', media_type: source.mediaType, data: source.data }
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
    case 'document': {
      // `title` is what a citation is attributed to, so the file name is a much
      // better fallback than leaving it unset.
      const title = block.title ?? block.filename
      return [{
        type: 'document',
        source: documentSource(block.source),
        ...title === undefined ? {} : { title },
        ...block.context === undefined ? {} : { context: block.context },
        ...block.citations === undefined ? {} : { citations: { enabled: block.citations } },
      }]
    }
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
 * @param messages - the normalized conversation.
 * @param cacheControl - when set, attached to the LAST block of the
 *   SECOND-TO-LAST wire message — everything but the newest turn, which is
 *   the only part of the history that changed since the previous request.
 *   A history of fewer than two wire messages has nothing stable to mark yet.
 */
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
  if (cacheControl !== undefined && result.length >= 2) {
    const boundary = result[result.length - 2]
    const lastBlock = boundary?.content.at(-1)
    if (lastBlock !== undefined) lastBlock.cache_control = cacheControl
  }
  return result
}

/**
 * Collect the system prompt from the request plus any system-role messages.
 * @param request - the resolved request.
 * @param cacheControl - when set, the joined text comes back as ONE block
 *   carrying this breakpoint instead of a plain string — the system prompt is
 *   as stable a prefix as a conversation has, so it is always the first thing
 *   marked when caching is on.
 */
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

/** How a reasoning effort becomes a thinking token budget, for `reasoningFormat: 'thinking-budget'`. */
export type ThinkingBudgets = Readonly<Record<string, number>>

/** Which field carries reasoning effort on the wire. */
export type AnthropicReasoningFormat = 'output-config' | 'thinking-budget'

/** Options controlling how the request is built. */
export interface AnthropicSerializeOptions {
  /**
   * `'output-config'` (default, current models): effort is pass-through —
   * sent verbatim as `output_config.effort`, exactly what the caller gave.
   * `'thinking-budget'` (older models, or a gateway that only understands a
   * token budget): effort is looked up in `budgets` and converted to
   * `thinking.budget_tokens` instead — the SDK does the conversion because the
   * endpoint has no `effort` field to receive the raw string at all.
   */
  reasoningFormat?: AnthropicReasoningFormat
  /** Effort id to thinking-token budget; only consulted under `'thinking-budget'`. */
  budgets: ThinkingBudgets
  /**
   * Extended-thinking mode, sent only when set — omission means "say nothing",
   * which is this API's own way of leaving the model's default behavior alone.
   * Ignored under `'thinking-budget'`, which derives `thinking` from the effort instead.
   */
  thinking?: 'adaptive' | 'disabled'
  /**
   * Mark the stable prefix of one request as a cache breakpoint: the system
   * prompt, the last tool definition (if any), and every message but the
   * newest — up to 3 of this API's 4-breakpoint ceiling, leaving one spare.
   * A conversation resending its whole history on every turn (this API is
   * stateless) pays full price for that history without this; with it, a
   * later turn reads the unchanged prefix at a steep discount instead of
   * paying to reprocess it.
   *
   * Off by default: not every account or Anthropic-COMPATIBLE gateway
   * behind this same adapter understands `cache_control`, and a route that
   * doesn't should not silently be asked to. See `dialectOf()` in
   * `provider-anthropic/src/adapter.ts` for the live-discovered fallback
   * that turns this off automatically, permanently, the first time a
   * gateway rejects it.
   */
  promptCaching?: boolean
  /** Cache breakpoint lifetime. Defaults to this API's own default (5 minutes). */
  promptCachingTtl?: '5m' | '1h'
}

/**
 * Last-resort `max_tokens`, used only when neither the caller, the model, nor
 * the route names one. This API rejects a request that omits the field
 * entirely, unlike most others — see {@link serializeAnthropicRequest}.
 */
export const DEFAULT_MAX_TOKENS = 8_192

/**
 * Resolve the `thinking` field under `reasoningFormat: 'thinking-budget'`.
 *
 * The budget must leave room for a real answer, so it is capped below
 * `max_tokens` — this API requires `budget_tokens < max_tokens` and rejects the
 * request otherwise.
 */
function thinkingFromBudget(
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

function outputConfig(
  format: ModelOutputFormat | undefined,
  effort: string | undefined,
): WireOutputConfig | undefined {
  const formatPart = format === undefined || format.type === 'text'
    ? undefined
    : { type: 'json_schema' as const, schema: format.schema }
  if (formatPart === undefined && effort === undefined) return undefined
  return {
    ...(formatPart === undefined ? {} : { format: formatPart }),
    ...(effort === undefined ? {} : { effort }),
  }
}

/**
 * Build the Messages request body.
 * @param request - the resolved request, model, and connection.
 * @param options - which field carries effort, its budget table, and the
 * explicit-thinking switch.
 * @returns the wire body, ready to serialize.
 */
export function serializeAnthropicRequest(
  request: ProtocolRequest,
  options: AnthropicSerializeOptions,
): WireRequest {
  const { options: call } = request
  const cacheControl: WireCacheControl | undefined = options.promptCaching === true
    ? { type: 'ephemeral', ...(options.promptCachingTtl === undefined ? {} : { ttl: options.promptCachingTtl }) }
    : undefined
  const system = systemOf(request, cacheControl)
  const tools = call.tools === undefined || call.tools.length === 0
    ? undefined
    : call.tools.map(toolOf)
  // The LAST tool carries the breakpoint: tool definitions are serialized in
  // one fixed block ahead of every message, so marking the final one caches
  // the whole list — same reasoning as the system prompt.
  if (cacheControl !== undefined && tools !== undefined) {
    const lastTool = tools[tools.length - 1]
    if (lastTool !== undefined) lastTool.cache_control = cacheControl
  }
  // Required by this API — unlike most others, omitting it is an error — so
  // this is the one field the SDK still defaults on the caller's behalf when
  // nothing upstream (caller, model, or route) named a value.
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS
  const reasoningFormat = options.reasoningFormat ?? 'output-config'
  const effort = call.reasoningEffort === undefined ? undefined : String(call.reasoningEffort)
  const budgetThinking = reasoningFormat === 'thinking-budget'
    ? thinkingFromBudget(effort, maxTokens, options.budgets)
    : undefined
  // Under 'output-config', `thinking` is an independent, explicit switch — not
  // derived from effort — so it is sent only when the caller configured one.
  const thinking = reasoningFormat === 'thinking-budget'
    ? budgetThinking
    : options.thinking === undefined
      ? undefined
      : options.thinking === 'adaptive' ? { type: 'adaptive' as const } : { type: 'disabled' as const }
  const output = outputConfig(call.outputFormat, reasoningFormat === 'output-config' ? effort : undefined)

  return {
    model: call.model,
    max_tokens: maxTokens,
    messages: messagesOf(call.messages, cacheControl),
    ...system === undefined ? {} : { system },
    ...tools === undefined ? {} : { tools },
    ...call.toolChoice === undefined ? {} : { tool_choice: toolChoiceOf(call.toolChoice) },
    // Pass-through: the caller's own sampling choices are forwarded as given.
    // An endpoint that rejects temperature/top_p alongside thinking says so in
    // its own error — the SDK no longer guesses and drops them first.
    ...call.temperature === undefined ? {} : { temperature: call.temperature },
    ...call.topP === undefined ? {} : { top_p: call.topP },
    ...call.stop === undefined || call.stop.length === 0
      ? {}
      : { stop_sequences: [...call.stop] },
    ...thinking === undefined ? {} : { thinking },
    ...output === undefined ? {} : { output_config: output },
    stream: true,
  }
}
