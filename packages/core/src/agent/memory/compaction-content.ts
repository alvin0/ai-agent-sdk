import type { ContentBlock, ToolCallBlock, ToolResultBlock } from '../../message/index.ts'
import { createMessage, type Message } from '../../message/index.ts'

export interface CharacterBudget { remaining: number }

export const COMPACTION_INSTRUCTION = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION for a long-running AI agent task.',
  'Condense the conversation above into a handoff that lets another model continue without '
    + 'forgetting the original purpose.',
  '',
  'Output exactly these Markdown sections, in order, using terse bullets. Write "(none)" for an empty section.',
  '## Primary Request and Intent',
  '## Progress and Completed Work',
  '## Decisions and Rationale',
  '## Constraints and User Preferences',
  '## Important Files, Symbols, and Evidence',
  '## Errors and Failed Approaches',
  '## Pending Work',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
  '',
  'Preserve exact paths, identifiers, commands, error strings, numeric limits, and user corrections when they matter.',
  'Under Important Files, mark relevant files as inspected or modified and preserve the exact '
    + 'declarations or findings needed next.',
  'Under Current Work, record the last successful tool action, the latest verification result, and '
    + 'whether any edit is still partial.',
  'Under Next Step, name one direct edit or command. Do not recommend rereading an unchanged file '
    + 'whose relevant contents are already recorded.',
  'Do not reveal hidden chain-of-thought. Record only public progress, observed evidence, '
    + 'decisions, and actionable context.',
  'If an earlier <compacted-summary> exists, merge still-valid facts with newer information and drop stale facts.',
  'Output only the checkpoint. Do not call tools and do not acknowledge the compaction.',
].join('\n')

export function sanitizeForSummary(
  message: Message,
  maxChars: number,
  budget: CharacterBudget,
): Message {
  const content = message.content.flatMap(block => sanitizeBlock(block, maxChars, budget))
  const source = message.source.kind === 'model'
    ? { kind: 'model' as const, provider: message.source.provider, model: message.source.model }
    : message.source
  return createMessage({ role: message.role, source, content })
}

function sanitizeBlock(
  block: ContentBlock,
  maxChars: number,
  budget: CharacterBudget,
): ContentBlock[] {
  switch (block.type) {
    case 'text': return [{ type: 'text', text: boundedText(block.text, maxChars, budget) }]
    case 'reasoning': return block.text.length === 0 ? [] : [{
      type: 'text', text: boundedText(`[Reasoning summary] ${block.text}`, maxChars, budget),
    }]
    case 'image': return [{ type: 'text', text: boundedText(`[Image input: ${block.source.kind}]`, maxChars, budget) }]
    case 'document': return [{
      type: 'text',
      text: boundedText(`[Document input: ${documentLabel(block)}]`, maxChars, budget),
    }]
    case 'tool-call': return [{
      ...block, arguments: boundedToolArguments(block.arguments, maxChars, budget),
    } satisfies ToolCallBlock]
    case 'tool-result': return [{
      ...block,
      content: block.content.flatMap(child => sanitizeBlock(child, maxChars, budget)),
    } satisfies ToolResultBlock]
    case 'native-tool-call': return [{
      type: 'text',
      text: boundedText(
        `[Native tool ${block.name} (${nativeStatus(block)})] ${safeJson(nativeArguments(block))}`,
        maxChars,
        budget,
      ),
    }]
    default: return [{
      type: 'text', text: boundedText(`[Unsupported content block: ${safeJson(block)}]`, maxChars, budget),
    }]
  }
}

function boundedText(value: string, maxChars: number, budget: CharacterBudget): string {
  const allowed = Math.max(0, Math.min(maxChars, budget.remaining))
  const result = truncateMiddle(value, allowed)
  budget.remaining -= result.length
  return result
}

function boundedToolArguments(value: string, maxChars: number, budget: CharacterBudget): string {
  const allowed = Math.max(0, Math.min(maxChars, budget.remaining))
  if (value.length <= allowed) {
    budget.remaining -= value.length
    return value
  }
  const placeholder = '{"_compacted":true}'
  if (placeholder.length <= allowed) {
    budget.remaining -= placeholder.length
    return placeholder
  }
  return '{}'
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}
function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = '\n…[truncated for compaction]…\n'
  if (maxChars <= marker.length) return value.slice(0, maxChars)
  const head = Math.ceil((maxChars - marker.length) / 2)
  const tail = Math.floor((maxChars - marker.length) / 2)
  return value.slice(0, head) + marker + value.slice(value.length - tail)
}

function documentLabel(block: Extract<ContentBlock, { type: 'document' }>): string {
  return block.filename ?? block.source.kind
}
function nativeStatus(block: Extract<ContentBlock, { type: 'native-tool-call' }>): string {
  return block.status ?? 'unknown'
}
function nativeArguments(block: Extract<ContentBlock, { type: 'native-tool-call' }>): unknown {
  return block.arguments ?? {}
}
