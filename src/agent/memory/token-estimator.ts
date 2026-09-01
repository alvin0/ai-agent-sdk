/** Provider-neutral deterministic context estimator used by compaction policy. */

import type { ModelToolSchema } from '../../core/contract/tool.ts'
import type { ContentBlock } from '../../core/message/content.ts'
import type { Message } from '../../core/message/message.ts'

export function estimateContextTokens(input: {
  readonly system?: string
  readonly messages: readonly Message[]
  readonly tools?: readonly ModelToolSchema[]
}): number {
  const system = input.system === undefined ? 0 : estimateTextTokens(input.system)
  const messages = input.messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
  const tools = input.tools?.reduce((total, tool) => total + estimateTextTokens(safeJson(tool)) + 8, 0) ?? 0
  return system + messages + tools + 8
}

export function estimateMessageTokens(message: Message | undefined): number {
  if (message === undefined) return 0
  return 4 + message.content.reduce((total, block) => total + estimateBlockTokens(block), 0)
}

function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text': return estimateTextTokens(block.text) + 2
    case 'reasoning': return estimateTextTokens(block.text) + estimateTextTokens(safeJson(block.providerState)) + 2
    case 'image': return block.source.kind === 'base64'
      ? Math.max(1024, estimateTextTokens(block.source.data))
      : 512
    case 'tool-call': return estimateTextTokens(block.name) + estimateTextTokens(block.arguments) + 8
    case 'tool-result': return block.content.reduce((total, child) => total + estimateBlockTokens(child), 8)
    case 'native-tool-call': return estimateTextTokens(safeJson(block)) + 8
    default: return estimateTextTokens(safeJson(block)) + 4
  }
}

function estimateTextTokens(text: string): number { return Math.ceil(text.length / 4) }
function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}
