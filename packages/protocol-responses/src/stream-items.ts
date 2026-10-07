import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { isJsonValue } from '@alvin0/ai-agent-sdk-core'
import type { AssistantTextPhase, ContentBlock, ImageMediaType, TextAnnotation } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest } from './contract.ts'
import type { ResponsesReasoningState } from './serialize.ts'
import type { WireOutputItem } from './wire.ts'

export type ItemKind = 'text' | 'reasoning' | 'tool-call' | 'native-tool-call'

export interface OpenItem {
  readonly index: number
  readonly kind: ItemKind
  text: string
  args: string
  callId: string
  name: string
  nativeName: string
  /** Last `summary_index` seen, so a new paragraph gets a separator. */
  summaryIndex: number | undefined
  phase: AssistantTextPhase | undefined
}

export function textPhase(value: string | undefined): AssistantTextPhase | undefined {
  if (value === 'commentary') return 'commentary'
  if (value === 'final_answer') return 'final-answer'
  return undefined
}

export function itemKind(type: string | undefined): ItemKind | undefined {
  switch (type) {
    case 'message': return 'text'
    case 'reasoning': return 'reasoning'
    case 'function_call': return 'tool-call'
    case 'web_search_call': return 'native-tool-call'
    case 'image_generation_call': return 'native-tool-call'
    default: return undefined
  }
}

export function nativeName(type: string | undefined): string {
  if (type === 'web_search_call') return 'web-search'
  if (type === 'image_generation_call') return 'image-generation'
  return type?.replace(/_call$/, '').replaceAll('_', '-') ?? 'native-tool'
}

export function textAnnotations(item: WireOutputItem): TextAnnotation[] {
  if (!Array.isArray(item.content)) return []
  return item.content.flatMap((part) => {
    if (typeof part !== 'object' || part === null) return []
    const annotations = (part as Record<string, unknown>).annotations
    if (!Array.isArray(annotations)) return []
    return annotations.flatMap((annotation): TextAnnotation[] => {
      if (typeof annotation !== 'object' || annotation === null) return []
      const record = annotation as Record<string, unknown>
      if (record.type !== 'url_citation' || typeof record.url !== 'string') return []
      return [{
        type: 'url-citation',
        url: record.url,
        ...typeof record.title === 'string' ? { title: record.title } : {},
        ...typeof record.start_index === 'number' ? { startIndex: record.start_index } : {},
        ...typeof record.end_index === 'number' ? { endIndex: record.end_index } : {},
      }]
    })
  })
}

export function itemText(item: WireOutputItem): string {
  const content = item.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const record = part as Record<string, unknown>
      return typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

export function itemSummary(item: WireOutputItem): string[] {
  const summary = item.summary
  if (!Array.isArray(summary)) return []
  return summary
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const record = part as Record<string, unknown>
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(text => text.length > 0)
}

export function doneBlock(
  item: WireOutputItem, open: OpenItem, imageMediaType: ImageMediaType,
): ContentBlock | undefined {
  switch (open.kind) {
    case 'text': return doneText(item, open)
    case 'reasoning': return doneReasoning(item, open)
    case 'tool-call': return doneTool(item, open)
    case 'native-tool-call': return doneNative(item, open, imageMediaType)
    default: return undefined
  }
}

function doneText(item: WireOutputItem, open: OpenItem): ContentBlock {
  const text = itemText(item)
  const phase = textPhase(item.phase) ?? open.phase
  return {
    type: 'text',
    text: text.length > 0 ? text : open.text,
    ...phase === undefined ? {} : { phase },
    ...textAnnotations(item).length === 0 ? {} : { annotations: textAnnotations(item) },
  }
}

function doneReasoning(item: WireOutputItem, open: OpenItem): ContentBlock {
  const summary = itemSummary(item)
  const state: ResponsesReasoningState = {
    ...typeof item.id === 'string' ? { id: item.id } : {},
    ...typeof item.encrypted_content === 'string'
      ? { encryptedContent: item.encrypted_content }
      : {},
    ...summary.length > 0 ? { summary } : {},
  }
  return {
    type: 'reasoning',
    text: summary.length > 0 ? summary.join('\n\n') : open.text,
    providerState: state,
  }
}

function doneTool(item: WireOutputItem, open: OpenItem): ContentBlock {
  const args = typeof item.arguments === 'string' && item.arguments.length > 0
    ? item.arguments
    : open.args
  return {
    type: 'tool-call',
    id: ToolCallId(item.call_id ?? open.callId),
    name: item.name ?? open.name,
    arguments: args.length > 0 ? args : '{}',
  }
}

function doneNative(item: WireOutputItem, open: OpenItem, imageMediaType: ImageMediaType): ContentBlock {
  const content: ContentBlock[] = open.nativeName === 'image-generation'
    && typeof item.result === 'string' && item.result.length > 0
    ? [{
      type: 'image',
      source: { kind: 'base64', mediaType: imageMediaType, data: item.result },
    }]
    : []
  return {
    type: 'native-tool-call',
    id: item.id ?? open.callId,
    name: open.nativeName,
    ...typeof item.status === 'string' ? { status: item.status } : {},
    ...isJsonValue(item.action) ? { arguments: item.action } : {},
    content,
    providerState: item,
  }
}


export function kindToBlockType(kind: ItemKind): 'text' | 'reasoning' | 'tool-call' | 'native-tool-call' {
  return kind
}

export function requestedImageMediaType(request: ProtocolRequest | undefined): ImageMediaType {
  const tool = request?.options.tools?.find(candidate => 'type' in candidate
    && candidate.type === 'native'
    && candidate.name === 'image-generation')
  if (tool === undefined || !('format' in tool)) return 'image/png'
  if (tool.format === 'jpeg') return 'image/jpeg'
  if (tool.format === 'webp') return 'image/webp'
  return 'image/png'
}