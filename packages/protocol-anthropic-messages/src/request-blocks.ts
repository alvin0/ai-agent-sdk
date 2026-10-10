import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, DocumentSource, ImageSource } from '@alvin0/ai-agent-sdk-core'
import type {
  WireDocumentSource, WireImageSource, WireCitation, WireRequestBlock, WireToolResultContent,
} from './wire.ts'
import type { AnthropicReasoningState } from './serialize-types.ts'

export function reasoningStateOf(value: unknown): AnthropicReasoningState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as AnthropicReasoningState
  if (state.kind !== 'thinking' && state.kind !== 'redacted_thinking') return undefined
  return {
    kind: state.kind,
    ...typeof state.signature === 'string' ? { signature: state.signature } : {},
    ...typeof state.data === 'string' ? { data: state.data } : {},
  }
}

export function imageSource(source: ImageSource): WireImageSource {
  if (source.kind === 'url') return { type: 'url', url: source.url }
  if (source.kind === 'base64') {
    return { type: 'base64', media_type: source.mediaType, data: source.data }
  }
  throw new ModelError(
    'Anthropic image inputs support URL or base64 sources, not file ids',
    MODEL_ERROR_CODES.INVALID_REQUEST,
  )
}

export function documentSource(source: DocumentSource): WireDocumentSource {
  if (source.kind === 'url') return { type: 'url', url: source.url }
  if (source.kind === 'file') return { type: 'file', file_id: source.fileId }
  return { type: 'base64', media_type: source.mediaType, data: source.data }
}

export function toolResultContent(blocks: readonly ContentBlock[]): WireToolResultContent[] | string {
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

export function toolInput(raw: string): unknown {
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

export function citationOf(value: unknown): WireCitation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const citation = value as Record<string, unknown>
  return typeof citation.type === 'string' ? structuredClone(citation) as WireCitation : undefined
}

export function nativeReplayBlocks(value: unknown): WireRequestBlock[] {
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

export function requestBlocks(block: ContentBlock): WireRequestBlock[] {
  switch (block.type) {
    case 'text': return textBlocks(block)
    case 'image':
      return [{ type: 'image', source: imageSource(block.source) }]
    case 'document': return documentBlocks(block)
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
    case 'reasoning': return reasoningBlocks(block)
    default:
      return []
  }
}

function textBlocks(block: Extract<ContentBlock, { type: 'text' }>): WireRequestBlock[] {
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


function documentBlocks(block: Extract<ContentBlock, { type: 'document' }>): WireRequestBlock[] {
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


function reasoningBlocks(block: Extract<ContentBlock, { type: 'reasoning' }>): WireRequestBlock[] {
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
