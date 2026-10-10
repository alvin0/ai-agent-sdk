import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import { isJsonValue, type JsonValue } from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, TextAnnotation } from '@alvin0/ai-agent-sdk-core'
import type { AnthropicReasoningState } from './serialize.ts'
import type { WireCitation, WireServerToolUseBlock, WireWebSearchToolResultBlock } from './wire.ts'

export type BlockKind = 'text' | 'reasoning' | 'tool-call' | 'native-tool-call'

export interface OpenBlock {
  readonly kind: BlockKind
  text: string
  args: string
  callId: string
  name: string
  signature: string | undefined
  redactedData: string | undefined
  annotations: TextAnnotation[]
  nativeCall: WireServerToolUseBlock | undefined
  nativeResult: WireWebSearchToolResultBlock | undefined
  closed: boolean
}

export function blockKind(type: string | undefined): BlockKind | undefined {
  switch (type) {
    case 'text': return 'text'
    case 'thinking':
    case 'redacted_thinking': return 'reasoning'
    case 'tool_use': return 'tool-call'
    case 'server_tool_use': return 'native-tool-call'
    default: return undefined
  }
}

export function closedBlock(open: OpenBlock): ContentBlock | undefined {
  switch (open.kind) {
    case 'text':
      return {
        type: 'text', text: open.text,
        ...open.annotations.length === 0 ? {} : { annotations: open.annotations },
      }
    case 'reasoning': return closedReasoning(open)
    case 'tool-call':
      return {
        type: 'tool-call',
        id: ToolCallId(open.callId),
        name: open.name,
        arguments: open.args.length > 0 ? open.args : '{}',
      }
    case 'native-tool-call': return closedNativeTool(open)
    default:
      return undefined
  }
}

export function parsedArguments(raw: string, fallback?: unknown): JsonValue {
  if (raw.length === 0) return isJsonValue(fallback) ? fallback : {}
  try {
    const value: unknown = JSON.parse(raw)
    return isJsonValue(value) ? value : {}
  } catch {
    return {}
  }
}

export function citationAnnotation(citation: WireCitation): TextAnnotation | undefined {
  if (citation.type !== 'web_search_result_location' || typeof citation.url !== 'string') {
    return undefined
  }
  return {
    type: 'url-citation', url: citation.url,
    ...typeof citation.title === 'string' ? { title: citation.title } : {},
    providerState: structuredClone(citation),
  }
}

function closedReasoning(open: OpenBlock): ContentBlock {
  const state: AnthropicReasoningState = open.redactedData !== undefined
    ? { kind: 'redacted_thinking', data: open.redactedData }
    : {
      kind: 'thinking',
      ...open.signature === undefined ? {} : { signature: open.signature },
    }
  return { type: 'reasoning', text: open.text, providerState: state }
}

function closedNativeTool(open: OpenBlock): ContentBlock {
  const parsed = parsedArguments(open.args, open.nativeCall?.input)
  const call: WireServerToolUseBlock = open.nativeCall ?? {
    type: 'server_tool_use', id: open.callId, name: 'web_search', input: parsed,
  }
  return {
    type: 'native-tool-call', id: open.callId,
    name: open.name === 'web_search' ? 'web-search' : open.name.replaceAll('_', '-'),
    arguments: parsed,
    content: [],
    providerState: {
      call: { ...call, input: parsed },
      ...open.nativeResult === undefined ? {} : { result: open.nativeResult },
    },
  }
}
