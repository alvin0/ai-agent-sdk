/**
 * Normalized request to Chat Completions wire JSON.
 *
 * Two things make this different from the Responses serializer. First, the wire
 * wants MESSAGES rather than a flat item list, so an assistant turn that spoke
 * and called two tools stays ONE message carrying both `content` and
 * `tool_calls`, while a tool result becomes its own `role: 'tool'` message
 * correlated by `tool_call_id`. Second, every optional field is gated by a
 * {@link ChatCompletionsDialect} flag, and a disabled flag means the key is
 * ABSENT — not `null`, not a default value. Some gateways reject an
 * unknown-but-null key outright, and a default silently changes behaviour
 * nobody asked for.
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/serialize
 */

import { MODEL_ERROR_CODES, ModelError, isNativeToolSchema } from '@alvin0/ai-agent-sdk-core'
import type {
  ContentBlock,
  ImageBlock,
  Message,
  ModelOutputFormat,
  ModelToolSchema,
  TextBlock,
  ToolChoice,
  ToolSchema,
} from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from './contract.ts'
import type {
  ChatCompletionsDialect,
  WireContentPart,
  WireImageDetail,
  WireMessage,
  WireRequest,
  WireResponseFormat,
  WireTool,
  WireToolCall,
  WireToolChoice,
} from './wire.ts'

/** Separator used whenever several text blocks collapse into one string. */
const TEXT_JOINER = '\n'

function textBlocks(blocks: readonly ContentBlock[]): TextBlock[] {
  return blocks.filter((block): block is TextBlock => block.type === 'text')
}

function joinedText(blocks: readonly ContentBlock[]): string {
  return textBlocks(blocks).map(block => block.text).join(TEXT_JOINER)
}

/** `original` has no wire spelling here, so it travels as no detail at all. */
function imageDetail(block: ImageBlock): WireImageDetail | undefined {
  const detail = block.detail
  if (detail === 'auto' || detail === 'low' || detail === 'high') return detail
  return undefined
}

/**
 * Convert one image block to an `image_url` part.
 *
 * A provider-side uploaded file has no representation in this API — the part
 * only accepts a URL — so a `file` source yields nothing rather than a
 * fabricated URL that would 400 at best and fetch the wrong bytes at worst.
 */
function imagePart(block: ImageBlock): WireContentPart | undefined {
  if (block.source.kind === 'file') return undefined
  const url = block.source.kind === 'url'
    ? block.source.url
    : `data:${block.source.mediaType};base64,${block.source.data}`
  const detail = imageDetail(block)
  return { type: 'image_url', image_url: { url, ...detail === undefined ? {} : { detail } } }
}

function contentPart(block: ContentBlock): WireContentPart | undefined {
  if (block.type === 'text') return { type: 'text', text: block.text }
  if (block.type === 'image') return imagePart(block)
  // `document` included: Chat Completions has no document part, and rendering a
  // PDF as text here would drop the page images the caller asked the model to read.
  return undefined
}

function toolCall(block: Extract<ContentBlock, { type: 'tool-call' }>): WireToolCall {
  return {
    id: block.id,
    type: 'function',
    function: {
      name: block.name,
      // VERBATIM. The string is replayed exactly as the model produced it: a
      // `JSON.parse`/`JSON.stringify` round-trip reorders keys and renormalizes
      // numbers, and some models read that exact string as their own context.
      // Only a truly empty value is substituted, because `arguments` must still
      // be valid JSON.
      arguments: block.arguments.length > 0 ? block.arguments : '{}',
    },
  }
}

/**
 * Expand one message into one or more wire messages, appended in order.
 *
 * The accumulator is FLUSHED before a block that has to become its own
 * top-level message, which is what keeps "spoke, called a tool, got a result,
 * spoke again" in the order the model produced it.
 */
function appendMessage(message: Message, messages: WireMessage[]): void {
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  let parts: WireContentPart[] = []
  let calls: WireToolCall[] = []

  const flush = (): void => {
    if (parts.length === 0 && calls.length === 0) return
    if (role === 'assistant') {
      const text = parts
        .flatMap(part => part.type === 'text' ? [part.text] : [])
        .join(TEXT_JOINER)
      messages.push({
        role: 'assistant',
        // Absent on a turn that only called tools; an empty string there reads
        // to the model as "I said nothing out loud", which is a different claim.
        ...text.length === 0 ? {} : { content: text },
        ...calls.length === 0 ? {} : { tool_calls: calls },
      })
    } else if (parts.length > 0) {
      const onlyText = parts.every(part => part.type === 'text')
      messages.push({
        role: 'user',
        content: onlyText
          ? parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(TEXT_JOINER)
          : parts,
      })
    }
    parts = []
    calls = []
  }

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
      case 'image':
      case 'document': {
        const part = contentPart(block)
        if (part !== undefined) parts.push(part)
        break
      }
      case 'tool-call': {
        calls.push(toolCall(block))
        break
      }
      case 'tool-result': {
        flush()
        messages.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          // The wire accepts a string only; non-text result blocks have no slot.
          content: joinedText(block.content),
        })
        break
      }
      default:
        // `reasoning`, `native-tool-call`, and any block added by declaration
        // merging. Skipping is correct: this API has no field to replay them
        // into, and inventing one would corrupt the turn.
        break
    }
  }
  flush()
}

/** The system prompt, plus any system-role messages, in order. */
function systemTextOf(request: ProtocolRequest): string {
  const fromMessages = request.options.messages
    .filter(message => message.role === 'system')
    .map(message => joinedText(message.content))
    .filter(text => text.length > 0)
  const all = request.options.system === undefined
    ? fromMessages
    : [request.options.system, ...fromMessages]
  return all.join('\n\n')
}

/** Map a tool schema; `strict` is left off because caller schemas are not vetted. */
function functionTool(tool: ToolSchema): WireTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.parameters },
    },
  }
}

function toolOf(tool: ModelToolSchema): WireTool {
  if (!isNativeToolSchema(tool)) return functionTool(tool)
  // Chat Completions runs no tools of its own. Dropping the request silently
  // would hand back an answer produced without the search the caller required.
  throw new ModelError(
    `Chat Completions does not support the provider-native tool "${tool.name}"`,
    MODEL_ERROR_CODES.INVALID_REQUEST,
  )
}

function toolChoiceOf(choice: ToolChoice): WireToolChoice {
  if (typeof choice === 'string') return choice
  if (choice.type === 'native') {
    throw new ModelError(
      `Chat Completions cannot be forced to call the provider-native tool "${choice.name}"`,
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return { type: 'function', function: { name: choice.name } }
}

/**
 * Map the neutral output format onto `response_format`, per dialect state.
 *
 * A schema the endpoint cannot honour is an error rather than a downgrade to
 * free text: the caller is about to `JSON.parse` the answer.
 */
function responseFormatOf(
  format: ModelOutputFormat | undefined,
  structuredOutputs: ChatCompletionsDialect['structuredOutputs'],
): WireResponseFormat | undefined {
  if (format === undefined || structuredOutputs === false) {
    if (format !== undefined && format.type === 'json_schema' && structuredOutputs === false) {
      throw new ModelError(
        'This Chat Completions endpoint does not support structured output',
        MODEL_ERROR_CODES.INVALID_REQUEST,
      )
    }
    return undefined
  }
  if (format.type === 'text') return { type: 'text' }
  // `json-object`: JSON mode without a schema. The endpoint guarantees valid
  // JSON but not this shape, which is still strictly better than free text.
  if (structuredOutputs === 'json-object') return { type: 'json_object' }
  return {
    type: 'json_schema',
    json_schema: { name: format.name, schema: format.schema, strict: true },
  }
}

/**
 * Build the Chat Completions request body.
 * @param request - the resolved request, model, and output cap.
 * @param dialect - which optional fields this endpoint accepts.
 * @returns the wire body, ready to serialize.
 */
export function serializeChatCompletionsRequest(
  request: ProtocolRequest,
  dialect: ChatCompletionsDialect,
): WireRequest {
  const { options } = request
  const messages: WireMessage[] = []

  const system = systemTextOf(request)
  // The system prompt leads the array under whichever role this endpoint reads.
  if (system.length > 0) messages.push({ role: dialect.systemRole, content: system })

  for (const message of options.messages) {
    if (message.role === 'system') continue // already folded in above
    appendMessage(message, messages)
  }

  const tools = dialect.tools && options.tools !== undefined && options.tools.length > 0
    ? options.tools.map(toolOf)
    : undefined
  const responseFormat = responseFormatOf(options.outputFormat, dialect.structuredOutputs)

  return {
    model: options.model,
    messages,
    stream: true,
    ...dialect.streamUsage ? { stream_options: { include_usage: true } } : {},
    ...dialect.maxTokensField === false ? {} : { [dialect.maxTokensField]: request.maxTokens },
    ...dialect.sampling && options.temperature !== undefined
      ? { temperature: options.temperature }
      : {},
    ...dialect.sampling && options.topP !== undefined ? { top_p: options.topP } : {},
    // `frequency_penalty` and `presence_penalty` have no source in
    // `GenerateOptions`, so they are never sent. Same for `seed` and `user`:
    // `dialect.seed` exists so a provider that grows a source for it does not
    // have to re-thread the flag through the dialect first.
    ...dialect.stop && options.stop !== undefined && options.stop.length > 0
      ? { stop: [...options.stop] }
      : {},
    ...dialect.reasoningEffort && options.reasoningEffort !== undefined
      ? { reasoning_effort: String(options.reasoningEffort) }
      : {},
    ...tools === undefined ? {} : { tools },
    ...tools === undefined || options.toolChoice === undefined
      ? {}
      : { tool_choice: toolChoiceOf(options.toolChoice) },
    // Only meaningful alongside `tools`, and older gateways reject the key
    // outright, which is why the flag defaults off.
    ...tools !== undefined && dialect.parallelToolCalls ? { parallel_tool_calls: true } : {},
    ...responseFormat === undefined ? {} : { response_format: responseFormat },
    ...dialect.promptCacheKey === undefined
      ? {}
      : { prompt_cache_key: dialect.promptCacheKey },
  }
}
