import type { ContentBlock, ToolCallBlock } from '../../message/index.ts'
import { freezeMessage, type Message } from '../../message/index.ts'
import { MessageId, type ToolCallId } from '../../primitives/index.ts'

/** Repair provider-invalid tool pairing without mutating persisted history. */
export function normalizeToolPairing(messages: readonly Message[]): readonly Message[] {
  const calls = new Map<ToolCallId, { call: ToolCallBlock; owner: Message }>()
  const answered = new Set<ToolCallId>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') calls.set(block.id, { call: block, owner: message })
      if (block.type === 'tool-result' && calls.has(block.toolCallId)) answered.add(block.toolCallId)
    }
  }

  const result: Message[] = []
  const seenCalls = new Set<ToolCallId>()
  for (const message of messages) {
    if (message.source.kind === 'tool' && !seenCalls.has(message.source.callId)) continue
    result.push(message)
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      seenCalls.add(block.id)
      if (!answered.has(block.id)) result.push(syntheticInterruptedResult(message, block.id))
    }
  }
  return Object.freeze(result)
}

function syntheticInterruptedResult(owner: Message, callId: ToolCallId): Message {
  const content: ContentBlock[] = [{
    type: 'tool-result',
    toolCallId: callId,
    content: [{ type: 'text', text: 'Error: the previous tool call was interrupted before a result was recorded' }],
    isError: true,
  }]
  return freezeMessage({
    id: MessageId(`synthetic-tool-result:${owner.id}:${callId}`),
    role: 'user',
    source: { kind: 'tool', callId },
    content,
  })
}
