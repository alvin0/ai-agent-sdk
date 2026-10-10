import type { ContentBlock, DocumentBlock, ImageBlock, TextBlock } from '@alvin0/ai-agent-sdk-core'
import type { WireContentPart, WireInputItem } from './wire.ts'
import type { ResponsesReasoningState } from './serialize-types.ts'

const DEFAULT_DOCUMENT_FILENAME = 'document.pdf'

export function reasoningStateOf(value: unknown): ResponsesReasoningState {
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

export function textAnnotations(block: TextBlock) {
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

export function imagePart(block: ImageBlock): WireContentPart {
  const detail = block.detail
  if (block.source.kind === 'file') {
    return { type: 'input_image', file_id: block.source.fileId, ...detail === undefined ? {} : { detail } }
  }
  const image_url = block.source.kind === 'url'
    ? block.source.url
    : `data:${block.source.mediaType};base64,${block.source.data}`
  return { type: 'input_image', image_url, ...detail === undefined ? {} : { detail } }
}

export function documentPart(block: DocumentBlock): WireContentPart {
  if (block.source.kind === 'file') return { type: 'input_file', file_id: block.source.fileId }
  if (block.source.kind === 'url') return { type: 'input_file', file_url: block.source.url }
  return {
    type: 'input_file',
    // The API reads the file type from the extension here, so a name is required
    // rather than optional; a neutral default beats a rejected request.
    filename: block.filename ?? DEFAULT_DOCUMENT_FILENAME,
    file_data: `data:${block.source.mediaType};base64,${block.source.data}`,
  }
}

export function contentPart(block: ContentBlock, role: 'user' | 'assistant'): WireContentPart | undefined {
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
  if (block.type === 'document') return documentPart(block)
  return undefined
}

export function toolResultOutput(blocks: readonly ContentBlock[]): string | WireContentPart[] {
  const hasBinary = blocks.some(block => block.type === 'image' || block.type === 'document')
  if (!hasBinary) {
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

export function nativeReplayItem(value: unknown): WireInputItem | undefined {
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
  if (item.type === 'image_generation_call') return imageReplayItem(item)
  return undefined
}

function imageReplayItem(item: Record<string, unknown>): WireInputItem {
  return {
    type: 'image_generation_call',
    ...typeof item.id === 'string' ? { id: item.id } : {},
    ...typeof item.status === 'string' ? { status: item.status } : {},
    ...typeof item.result === 'string' || item.result === null ? { result: item.result } : {},
  }
}
