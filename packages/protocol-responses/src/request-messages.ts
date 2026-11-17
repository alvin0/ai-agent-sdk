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
      const replay = nativeReplayItem(block)
      if (replay !== undefined) state.items.push(replay)
      return
    }
    default: return
  }
}

function appendReasoning(block: Extract<ContentBlock, { type: 'reasoning' }>, items: WireInputItem[]): void {
  const state = reasoningStateOf(block.providerState)
  const content = reasoningContent(state, block)
  // Unfinished reasoning has no replay identity and cannot be sent back.
  if (state.id === undefined && state.encryptedContent === undefined) return
  const summary = reasoningSummary(state, block, content)
  items.push({
    type: 'reasoning',
    ...state.id === undefined ? {} : { id: state.id },
    summary: summary.map(text => ({ type: 'summary_text' as const, text })),
    ...content === undefined
      ? {}
      : { content: content.map(text => ({ type: 'reasoning_text' as const, text })) },
    ...state.encryptedContent === undefined ? {} : { encrypted_content: state.encryptedContent },
  })
}

/**
 * Raw reasoning to replay as `reasoning_text`, never relabelled as a summary.
 *
 * A block read before raw content was tracked still says `kind: 'content'`,
 * which is enough to put its text back where it came from.
 */
function reasoningContent(
  state: ResponsesReasoningState,
  block: Extract<ContentBlock, { type: 'reasoning' }>,
): readonly string[] | undefined {
  // Raw content needs the item id it belongs to; without one it is not a replay.
  if (state.content !== undefined) return state.id === undefined ? undefined : state.content
  if (state.encryptedContent !== undefined || state.summary !== undefined) return undefined
  if (state.id === undefined || block.kind !== 'content' || block.text.length === 0) return undefined
  return [block.text]
}

function reasoningSummary(
  state: ResponsesReasoningState,
  block: Extract<ContentBlock, { type: 'reasoning' }>,
  content: readonly string[] | undefined,
): readonly string[] {
  if (state.summary !== undefined && state.summary.length > 0) return state.summary
  // Raw content — tracked, or only known from `reasoning_text` deltas — is never
  // relabelled as a summary, even when it cannot be replayed.
  if (content !== undefined || state.content !== undefined || block.kind === 'content') return []
  return block.text.length > 0 ? [block.text] : []
}
