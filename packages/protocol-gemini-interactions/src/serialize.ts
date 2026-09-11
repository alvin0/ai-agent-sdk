import {
  isNativeToolSchema,
  MODEL_ERROR_CODES,
  ModelError,
  type ContentBlock,
  type DocumentBlock,
  type ImageBlock,
  type Message,
  type ModelOutputFormat,
  type ModelToolSchema,
  type NativeWebSearchTool,
  type TextAnnotation,
  type ToolChoice,
  type ToolSchema,
} from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from './contract.ts'
import type {
  GeminiInteractionsDialect,
  GeminiThoughtState,
  WireContent,
  WireGenerationConfig,
  WireRequest,
  WireResponseFormat,
  WireStep,
  WireTool,
  WireToolChoice,
} from './wire.ts'

function imageContent(block: ImageBlock): WireContent {
  const resolution = block.detail === 'low' || block.detail === 'high'
    ? block.detail
    : undefined
  if (block.source.kind === 'base64') {
    return {
      type: 'image', data: block.source.data, mime_type: block.source.mediaType,
      ...(resolution === undefined ? {} : { resolution }),
    }
  }
  return {
    type: 'image', uri: block.source.kind === 'url' ? block.source.url : block.source.fileId,
    ...(resolution === undefined ? {} : { resolution }),
  }
}

function documentContent(block: DocumentBlock): WireContent {
  if (block.source.kind === 'base64') {
    return { type: 'document', data: block.source.data, mime_type: block.source.mediaType }
  }
  // This API collapses "remote URL" and "uploaded file" into one `uri`, exactly as
  // it does for images.
  return {
    type: 'document',
    uri: block.source.kind === 'url' ? block.source.url : block.source.fileId,
    mime_type: 'application/pdf',
  }
}

function annotationOf(annotation: TextAnnotation) {
  if (annotation.type !== 'url-citation') return undefined
  return {
    type: 'url_citation',
    url: annotation.url,
    ...(annotation.title === undefined ? {} : { title: annotation.title }),
    ...(annotation.startIndex === undefined ? {} : { start_index: annotation.startIndex }),
    ...(annotation.endIndex === undefined ? {} : { end_index: annotation.endIndex }),
  }
}

function contentOf(block: ContentBlock): WireContent | undefined {
  if (block.type === 'text') {
    const annotations = block.annotations?.map(annotationOf)
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
    return {
      type: 'text', text: block.text,
      ...(annotations === undefined || annotations.length === 0 ? {} : { annotations }),
    }
  }
  if (block.type === 'image') return imageContent(block)
  if (block.type === 'document') return documentContent(block)
  return undefined
}

function thoughtStateOf(value: unknown): GeminiThoughtState {
  if (typeof value !== 'object' || value === null) return {}
  const state = value as GeminiThoughtState
  return {
    ...(typeof state.signature === 'string' ? { signature: state.signature } : {}),
    ...(Array.isArray(state.summary) ? { summary: structuredClone(state.summary) } : {}),
  }
}

function argumentsObject(raw: string): Record<string, unknown> {
  if (raw.length === 0) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error: unknown) {
    throw new ModelError(
      'Gemini Interactions requires function-call arguments to be a JSON object',
      MODEL_ERROR_CODES.INVALID_REQUEST,
      { cause: error },
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ModelError(
      'Gemini Interactions requires function-call arguments to be a JSON object',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return value as Record<string, unknown>
}

function toolResult(
  block: Extract<ContentBlock, { type: 'tool-result' }>,
  toolNames: ReadonlyMap<string, string>,
): WireStep {
  const contents = block.content.map(contentOf)
    .filter((item): item is WireContent => item !== undefined)
  const name = toolNames.get(block.toolCallId)
  return {
    type: 'function_result',
    call_id: block.toolCallId,
    ...(name === undefined ? {} : { name }),
    result: contents,
    ...(block.isError === undefined ? {} : { is_error: block.isError }),
  }
}

function appendUserMessage(
  message: Message,
  output: WireStep[],
  toolNames: ReadonlyMap<string, string>,
): void {
  let content: WireContent[] = []
  const flush = (): void => {
    if (content.length === 0) return
    output.push({ type: 'user_input', content })
    content = []
  }
  for (const block of message.content) {
    if (block.type === 'tool-result') {
      flush()
      output.push(toolResult(block, toolNames))
      continue
    }
    const mapped = contentOf(block)
    if (mapped !== undefined) content.push(mapped)
  }
  flush()
}

function appendAssistantMessage(message: Message, output: WireStep[]): void {
  let content: WireContent[] = []
  const flush = (): void => {
    if (content.length === 0) return
    output.push({ type: 'model_output', content })
    content = []
  }
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'image' || block.type === 'document') {
      const mapped = contentOf(block)
      if (mapped !== undefined) content.push(mapped)
      continue
    }
    flush()
    if (block.type === 'reasoning') {
      const state = thoughtStateOf(block.providerState)
      const summary = state.summary ?? (block.text.length === 0
        ? undefined
        : [{ type: 'text' as const, text: block.text }])
      output.push({
        type: 'thought',
        ...(state.signature === undefined ? {} : { signature: state.signature }),
        ...(summary === undefined || summary.length === 0 ? {} : { summary: [...summary] }),
      })
    } else if (block.type === 'tool-call') {
      output.push({
        type: 'function_call', id: block.id, name: block.name,
        arguments: argumentsObject(block.arguments),
      })
    }
  }
  flush()
}

function inputOf(request: ProtocolRequest): WireStep[] {
  const output: WireStep[] = []
  const toolNames = new Map<string, string>()
  for (const message of request.options.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') toolNames.set(block.id, block.name)
    }
  }
  for (const message of request.options.messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant') appendAssistantMessage(message, output)
    else appendUserMessage(message, output, toolNames)
  }
  return output
}

function systemInstructionOf(request: ProtocolRequest): string {
  const messages = request.options.messages
    .filter(message => message.role === 'system')
    .flatMap(message => message.content)
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
  return [request.options.system, ...messages]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join('\n\n')
}

function functionTool(tool: ToolSchema): WireTool {
  return {
    type: 'function', name: tool.name, description: tool.description,
    parameters: tool.parameters,
  }
}

function googleSearchTool(tool: NativeWebSearchTool): WireTool {
  if (tool.searchContextSize !== undefined || tool.allowedDomains !== undefined
    || tool.blockedDomains !== undefined || tool.userLocation !== undefined
    || tool.maxUses !== undefined) {
    throw new ModelError(
      'Gemini Interactions web search does not support SDK search filters or limits',
      MODEL_ERROR_CODES.INVALID_REQUEST,
    )
  }
  return { type: 'google_search', search_types: ['web_search'] }
}

function toolOf(tool: ModelToolSchema): WireTool {
  if (!isNativeToolSchema(tool)) return functionTool(tool)
  if (tool.name === 'web-search') return googleSearchTool(tool)
  throw new ModelError(
    'Gemini Interactions does not expose image generation as an SDK native tool',
    MODEL_ERROR_CODES.INVALID_REQUEST,
  )
}

function toolChoiceOf(choice: ToolChoice): WireToolChoice {
  if (choice === 'required') return 'any'
  if (typeof choice === 'string') return choice
  const name = choice.type === 'native' && choice.name === 'web-search'
    ? 'google_search'
    : choice.name
  return { allowed_tools: { mode: 'any', tools: [name] } }
}

function responseFormatOf(format: ModelOutputFormat | undefined): WireResponseFormat | undefined {
  if (format === undefined) return undefined
  if (format.type === 'text') return { type: 'text', mime_type: 'text/plain' }
  return { type: 'text', mime_type: 'application/json', schema: format.schema }
}

function generationConfigOf(
  request: ProtocolRequest,
  dialect: GeminiInteractionsDialect,
): WireGenerationConfig {
  const options = request.options
  return {
    max_output_tokens: request.maxTokens,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.topP === undefined ? {} : { top_p: options.topP }),
    ...(options.stop === undefined || options.stop.length === 0
      ? {}
      : { stop_sequences: [...options.stop] }),
    ...(options.reasoningEffort === undefined
      ? {}
      : {
        thinking_level: String(options.reasoningEffort),
        thinking_summaries: dialect.thinkingSummaries,
      }),
    ...(options.toolChoice === undefined ? {} : { tool_choice: toolChoiceOf(options.toolChoice) }),
  }
}

export function serializeGeminiInteractionsRequest(
  request: ProtocolRequest,
  dialect: GeminiInteractionsDialect,
): WireRequest {
  const systemInstruction = systemInstructionOf(request)
  const tools = request.options.tools?.map(toolOf)
  const responseFormat = responseFormatOf(request.options.outputFormat)
  return {
    model: request.options.model,
    input: inputOf(request),
    ...(systemInstruction.length === 0 ? {} : { system_instruction: systemInstruction }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    stream: true,
    store: dialect.store,
    generation_config: generationConfigOf(request, dialect),
  }
}
