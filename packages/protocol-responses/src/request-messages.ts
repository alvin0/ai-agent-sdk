import type { ContentBlock, TextBlock } from '@alvin0/ai-agent-sdk-core'
import type { Message } from '@alvin0/ai-agent-sdk-core'
import type { WireContentPart, WireInputItem } from './wire.ts'
import type { ResponsesReasoningState } from './serialize-types.ts'
import { contentPart, reasoningStateOf, toolResultOutput, nativeReplayItem } from './request-content.ts'

interface MessageState {
  role: 'user' | 'assistant'
  parts: WireContentPart[]
  phase: TextBlock['phase']
  items: WireInputItem[]
  dialectMessagePhase: boolean
}

/** Flush content at standalone-item boundaries to preserve conversation order. */
export function appendMessage(message: Message, items: WireInputItem[], dialectMessagePhase: boolean): void {
  const state: MessageState = {
    role: message.role === 'assistant' ? 'assistant' : 'user', parts: [], phase: undefined,
    items, dialectMessagePhase,
  }
  for (const block of message.content) {
    if (block.type === 'text' || block.type === 'image' || block.type === 'document') appendContent(block, state)
    else appendControl(block, state)
  }
  flushMessage(state)
}

function flushMessage(state: MessageState): void {
  if (state.parts.length === 0) return
  state.items.push({
    type: 'message', role: state.role, content: state.parts,
    ...state.role === 'assistant' && state.dialectMessagePhase && state.phase !== undefined
      ? { phase: state.phase === 'final-answer' ? 'final_answer' as const : state.phase } : {},
  })
  state.parts = []
  state.phase = undefined
}

function appendContent(block: ContentBlock, state: MessageState): void {
  if (block.type === 'text' && block.phase !== undefined && state.phase !== undefined && state.phase !== block.phase) {
    flushMessage(state)
  }
  if (block.type === 'text' && block.phase !== undefined) state.phase = block.phase
  const part = contentPart(block, state.role)
  if (part !== undefined) state.parts.push(part)
}

function appendControl(block: ContentBlock, state: MessageState): void {
  switch (block.type) {
    case 'reasoning':
      flushMessage(state)
      appendReasoning(block, state.items)
      return
    case 'tool-call':
      flushMessage(state)
      state.items.push({ type: 'function_call', call_id: block.id, name: block.name,
        arguments: block.arguments.length > 0 ? block.arguments : '{}' })
      return
    case 'tool-result':
      flushMessage(state)
      state.items.push({ type: 'function_call_output', call_id: block.toolCallId,
        output: toolResultOutput(block.content) })
      return
    case 'native-tool-call': {
      flushMessage(state)
      const replay = nativeReplayItem(block.providerState)
      if (replay !== undefined) state.items.push(replay)
      return
    }
    default: return
  }
}

function appendReasoning(block: Extract<ContentBlock, { type: 'reasoning' }>, items: WireInputItem[]): void {
  const state = reasoningStateOf(block.providerState)
  // Unfinished reasoning has no replay identity and cannot be sent back.
  if (state.id === undefined && state.encryptedContent === undefined) return
  const summary = reasoningSummary(state, block.text)
  items.push({
    type: 'reasoning',
    ...state.id === undefined ? {} : { id: state.id },
    summary: summary.map(text => ({ type: 'summary_text' as const, text })),
    ...state.encryptedContent === undefined ? {} : { encrypted_content: state.encryptedContent },
  })
}

function reasoningSummary(state: ResponsesReasoningState, text: string): readonly string[] {
  if (state.summary !== undefined && state.summary.length > 0) return state.summary
  return text.length > 0 ? [text] : []
}
