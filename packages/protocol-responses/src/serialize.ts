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
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, ImageBlock, TextBlock } from '@alvin0/ai-agent-sdk-core'
import type { Message } from '@alvin0/ai-agent-sdk-core'
import {
  isNativeToolSchema,
  type ModelOutputFormat,
  type ModelToolSchema,
  type NativeImageGenerationTool,
  type NativeWebSearchTool,
  type ToolChoice,
  type ToolSchema,
} from '@alvin0/ai-agent-sdk-core'
import type {
  ResponsesDialect,
  WireContentPart,
  WireInputItem,
  WireRequest,
  WireTool,
  WireToolChoice,
  WireTextControls,
} from './wire.ts'

/**
 * Adapter-private state kept on a {@link ReasoningBlock} so a reasoning item can
 * be echoed back byte-identically on the next request of a tool-use loop.
 */
export interface ResponsesReasoningState {
  /** Server-assigned item id. */
  id?: string
  /** Opaque encrypted chain of thought. */
  encryptedContent?: string
  /** Summary paragraphs, in order. */
  summary?: readonly string[]
}

/** Read the reasoning state back off a block, tolerating anything unexpected. */
function reasoningStateOf(value: unknown): ResponsesReasoningState {
  if (typeof value !== 'object' || value === null) return {}
  const state = value as ResponsesReasoningState
  return {
    ...typeof state.id === 'string' ? { id: state.id } : {},
    ...typeof state.encryptedContent === 'string'
      ? { encryptedContent: state.encryptedContent }
      : {},
    ...Array.isArray(state.summary) ? { summary: state.summary } : {},
  }
}

function textAnnotations(block: TextBlock) {
  return block.annotations?.flatMap(annotation => annotation.type === 'url-citation'
    ? [{
      type: 'url_citation' as const,
      url: annotation.url,
      ...annotation.title === undefined ? {} : { title: annotation.title },
      ...annotation.startIndex === undefined ? {} : { start_index: annotation.startIndex },
      ...annotation.endIndex === undefined ? {} : { end_index: annotation.endIndex },
    }]
    : [])
}

function imagePart(block: ImageBlock): WireContentPart {
  const detail = block.detail
  if (block.source.kind === 'file') {
    return { type: 'input_image', file_id: block.source.fileId, ...detail === undefined ? {} : { detail } }
  }
  const image_url = block.source.kind === 'url'
    ? block.source.url
    : `data:${block.source.mediaType};base64,${block.source.data}`
  return { type: 'input_image', image_url, ...detail === undefined ? {} : { detail } }
}

/** Convert one content block to a request-side content part. */
function contentPart(block: ContentBlock, role: 'user' | 'assistant'): WireContentPart | undefined {
  if (block.type === 'text') {
    // An assistant turn's own text must come back as `output_text`; sending it as
    // `input_text` would present the model's prior words as if the user said them.
    if (role !== 'assistant') return { type: 'input_text', text: block.text }
    const annotations = textAnnotations(block)
    return {
      type: 'output_text', text: block.text,
      ...annotations === undefined ? {} : { annotations },
    }
  }
  if (block.type === 'image') return imagePart(block)
  return undefined
}

/** Render a tool result's blocks as the wire's polymorphic `output` value. */
function toolResultOutput(blocks: readonly ContentBlock[]): string | WireContentPart[] {
  const hasImage = blocks.some(block => block.type === 'image')
  if (!hasImage) {
    // The common case. A plain string keeps the payload small and is what the
    // API documents first.
    return blocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  return blocks
    .map(block => contentPart(block, 'user'))
    .filter((part): part is WireContentPart => part !== undefined)
}

/**
 * Expand one message into zero or more wire items, appending them in order.
 *
 * Content parts accumulate into a single message item, which is FLUSHED whenever
 * a block appears that has to become its own top-level item. That flushing is
 * what preserves "spoke, then called a tool, then spoke again" as three items in
 * the right order instead of collapsing it.
 */
function appendMessage(message: Message, items: WireInputItem[], dialectMessagePhase: boolean): void {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  let parts: WireContentPart[] = []
  let phase: Extract<ContentBlock, { type: 'text' }>['phase']

  const flush = (): void => {
    if (parts.length === 0) return
    items.push({
      type: 'message', role, content: parts,
      ...role === 'assistant' && dialectMessagePhase && phase !== undefined
        ? { phase: phase === 'final-answer' ? 'final_answer' as const : phase }
        : {},
    })
    parts = []
    phase = undefined
  }

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'image': {
        if (block.type === 'text' && block.phase !== undefined && phase !== undefined && phase !== block.phase) flush()
        if (block.type === 'text' && block.phase !== undefined) phase = block.phase
        const part = contentPart(block, role)
        if (part !== undefined) parts.push(part)
        break
      }
      case 'reasoning': {
        flush()
        const state = reasoningStateOf(block.providerState)
        // Prefer the recorded summary paragraphs; fall back to the block's text so
        // a hand-built or replayed message still carries something.
        const summary = state.summary !== undefined && state.summary.length > 0
          ? state.summary
          : block.text.length > 0 ? [block.text] : []
        items.push({
          type: 'reasoning',
          ...state.id === undefined ? {} : { id: state.id },
          summary: summary.map(text => ({ type: 'summary_text' as const, text })),
          ...state.encryptedContent === undefined
            ? {}
            : { encrypted_content: state.encryptedContent },
        })
        break
      }
      case 'tool-call': {
        flush()
        items.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          // Empty arguments must still be valid JSON, or the provider rejects it.
          arguments: block.arguments.length > 0 ? block.arguments : '{}',
        })
        break
      }
      case 'tool-result': {
        flush()
        items.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          output: toolResultOutput(block.content),
        })
        break
      }
      case 'native-tool-call': {
        flush()
        const replay = nativeReplayItem(block.providerState)
        if (replay !== undefined) items.push(replay)
        break
      }
      default:
        // A content block introduced by declaration merging. Skipping is correct:
        // this serializer cannot know its wire form, and inventing one would
        // corrupt the request.
        break
    }
  }
  flush()
}

/** Collect the system prompt from the request plus any system-role messages. */
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

/** Map the neutral tool-choice vocabulary onto this API's. */
function toolChoiceOf(choice: ToolChoice): WireToolChoice {
  if (typeof choice === 'string') return choice
  if (choice.type === 'native') return { type: nativeWireType(choice.name) }
  return { type: 'function', name: choice.name }
}

/** Map a tool schema; `strict: false` because caller schemas are not vetted. */
function functionTool(tool: ToolSchema): WireTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    // Strict mode imposes real JSON-Schema restrictions (no optional fields
    // without null, `additionalProperties: false` required). Opting a caller's
    // schema in silently would turn a working tool into a request rejection.
    strict: false,
    parameters: tool.parameters,
  }
}

function nativeWireType(name: string): string {
  if (name === 'web-search') return 'web_search'
  if (name === 'image-generation') return 'image_generation'
  return name.replaceAll('-', '_')
}

function webSearchTool(tool: NativeWebSearchTool): WireTool {
  if (tool.blockedDomains !== undefined) {
    throw new ModelError(
      'OpenAI Responses web search does not support blockedDomains; use allowedDomains',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  if (tool.maxUses !== undefined) {
    throw new ModelError(
      'OpenAI Responses web search does not support maxUses',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return {
    type: 'web_search',
    ...tool.searchContextSize === undefined ? {} : { search_context_size: tool.searchContextSize },
    ...tool.allowedDomains === undefined ? {} : { filters: { allowed_domains: [...tool.allowedDomains] } },
    ...tool.userLocation === undefined ? {} : {
      user_location: { type: 'approximate', ...tool.userLocation },
    },
  }
}

function imageGenerationTool(tool: NativeImageGenerationTool): WireTool {
  return {
    type: 'image_generation',
    ...tool.size === undefined ? {} : { size: tool.size },
    ...tool.quality === undefined ? {} : { quality: tool.quality },
    ...tool.format === undefined ? {} : { output_format: tool.format },
    ...tool.background === undefined ? {} : { background: tool.background },
    ...tool.partialImages === undefined ? {} : { partial_images: tool.partialImages },
  }
}

function toolOf(tool: ModelToolSchema): WireTool {
  if (!isNativeToolSchema(tool)) return functionTool(tool)
  if (tool.name === 'web-search') return webSearchTool(tool)
  return imageGenerationTool(tool)
}

function textControls(
  format: ModelOutputFormat | undefined,
  dialect: ResponsesDialect,
): WireTextControls | undefined {
  if (format === undefined) return undefined
  if (format.type === 'text') {
    return dialect.structuredOutputs ? { format: { type: 'text' } } : undefined
  }
  if (!dialect.structuredOutputs) {
    throw new ModelError(
      'This Responses endpoint does not support JSON Schema output',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return {
    format: {
      type: 'json_schema',
      name: format.name,
      schema: format.schema,
      strict: true,
    },
  }
}

function nativeReplayItem(value: unknown): WireInputItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Record<string, unknown>
  if (item.type === 'web_search_call') {
    return {
      type: 'web_search_call',
      ...typeof item.id === 'string' ? { id: item.id } : {},
      ...typeof item.status === 'string' ? { status: item.status } : {},
      ...item.action === undefined ? {} : { action: structuredClone(item.action) },
    }
  }
  if (item.type === 'image_generation_call') {
    return {
      type: 'image_generation_call',
      ...typeof item.id === 'string' ? { id: item.id } : {},
      ...typeof item.status === 'string' ? { status: item.status } : {},
      ...typeof item.result === 'string' || item.result === null ? { result: item.result } : {},
    }
  }
  return undefined
}

/**
 * Build the Responses request body.
 * @param request - the resolved request, model, and connection.
 * @param dialect - which optional fields this endpoint accepts.
 * @returns the wire body, ready to serialize.
 */
export function serializeResponsesRequest(
  request: ProtocolRequest,
  dialect: ResponsesDialect,
): WireRequest {
  const { options } = request
  const input: WireInputItem[] = []
  for (const message of options.messages) {
    if (message.role === 'system') continue // folded into `instructions`
    appendMessage(message, input, dialect.messagePhase === true)
  }

  const instructions = instructionsOf(request)
  const tools = options.tools === undefined || options.tools.length === 0
    ? undefined
    : options.tools.map(toolOf)
  const text = textControls(options.outputFormat, dialect)

  return {
    model: options.model,
    ...instructions.length === 0 ? {} : { instructions },
    input,
    ...tools === undefined ? {} : { tools },
    ...options.toolChoice === undefined ? {} : { tool_choice: toolChoiceOf(options.toolChoice) },
    ...tools === undefined ? {} : { parallel_tool_calls: true },
    ...options.reasoningEffort === undefined && dialect.reasoningSummary === undefined
      ? {}
      : {
        reasoning: {
          ...options.reasoningEffort === undefined
            ? {}
            : { effort: String(options.reasoningEffort) },
          ...dialect.reasoningSummary === undefined
            ? {}
            : { summary: dialect.reasoningSummary },
        },
      },
    ...text === undefined ? {} : { text },
    store: dialect.store,
    stream: true,
    ...dialect.include.length === 0 ? {} : { include: [...dialect.include] },
    ...dialect.promptCacheKey === undefined ? {} : { prompt_cache_key: dialect.promptCacheKey },
    ...dialect.maxOutputTokens ? { max_output_tokens: request.maxTokens } : {},
    ...dialect.sampling && options.temperature !== undefined
      ? { temperature: options.temperature }
      : {},
    ...dialect.sampling && options.topP !== undefined ? { top_p: options.topP } : {},
  }
}
