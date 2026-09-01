/** Surface range selection and lossless-log tool-result pruning. */

import type { ContentBlock } from '@ai-agent-sdk/core'
import { createMessage, type Message } from '@ai-agent-sdk/core'
import type { ToolCallId } from '@ai-agent-sdk/core'
import type { History } from '../history/history.ts'
import type { HistorySurfaceNode } from '../history/project.ts'
import { estimateMessageTokens } from './token-estimator.ts'

export function selectCompactablePrefix(
  surface: readonly HistorySurfaceNode[],
  retainTokens: number,
): readonly HistorySurfaceNode[] {
  if (surface.length < 2) return []
  let accumulated = 0
  let keepFrom = surface.length
  for (let index = surface.length - 1; index >= 0; index--) {
    accumulated += estimateMessageTokens(surface[index]?.message)
    keepFrom = index
    if (accumulated >= retainTokens) break
  }
  keepFrom = Math.max(1, Math.min(keepFrom, surface.length - 1))
  while (keepFrom > 0 && !toolPairingBalanced(surface.map(node => node.message), keepFrom)) keepFrom--
  return Object.freeze(surface.slice(0, keepFrom))
}

/** Replace oversized model-visible tool text while retaining the full original log entry. */
export function pruneToolResults(
  history: History,
  surface: readonly HistorySurfaceNode[],
  maxChars: number,
): number {
  let pruned = 0
  for (const node of surface) {
    if (node.message.source.kind !== 'tool') continue
    const textBlocks = node.message.content.flatMap(block =>
      block.type === 'tool-result'
        ? block.content.filter((child): child is Extract<ContentBlock, { type: 'text' }> => child.type === 'text')
        : [])
    const charsBefore = textBlocks.reduce((total, block) => total + [...block.text].length, 0)
    if (charsBefore <= maxChars) continue
    const sourceEntry = history.entries().find(entry => entry.seq === node.seq)
    if (sourceEntry?.event.kind !== 'tool-result') continue
    const perBlock = Math.max(1, Math.floor(maxChars / Math.max(1, textBlocks.length)))
    const content = node.message.content.map(block => block.type !== 'tool-result'
      ? block
      : {
        ...block,
        content: block.content.map(child => child.type === 'text'
          ? { ...child, text: truncateMiddleCodePoints(child.text, perBlock) }
          : child),
      })
    const replacement = createMessage({ role: 'user', source: node.message.source, content })
    const charsAfter = content.flatMap(block => block.type === 'tool-result'
      ? block.content.filter((child): child is Extract<ContentBlock, { type: 'text' }> => child.type === 'text')
      : []).reduce((total, block) => total + [...block.text].length, 0)
    history.appendBatch([
      { event: {
        kind: 'compaction-prune', callId: sourceEntry.event.callId,
        originalSeq: node.seq, charsBefore, charsAfter,
      } },
      {
        event: { ...sourceEntry.event, message: replacement },
        surfaceOp: { op: 'replace', from: node.seq, to: node.seq, targets: [node.seq] },
      },
    ])
    pruned++
  }
  return pruned
}

function toolPairingBalanced(messages: readonly Message[], split: number): boolean {
  const side = new Map<ToolCallId, 'head' | 'tail'>()
  for (let index = 0; index < messages.length; index++) {
    const location = index < split ? 'head' : 'tail'
    for (const block of messages[index]?.content ?? []) {
      if (block.type === 'tool-call') side.set(block.id, location)
    }
  }
  for (let index = 0; index < messages.length; index++) {
    const location = index < split ? 'head' : 'tail'
    for (const block of messages[index]?.content ?? []) {
      if (block.type === 'tool-result' && side.get(block.toolCallId) !== location) return false
    }
  }
  return true
}

function truncateMiddleCodePoints(value: string, maxChars: number): string {
  const points = [...value]
  if (points.length <= maxChars) return value
  const marker = [...'\n…[tool result pruned for context]…\n']
  if (maxChars <= marker.length) return points.slice(0, maxChars).join('')
  const head = Math.ceil((maxChars - marker.length) / 2)
  const tail = Math.floor((maxChars - marker.length) / 2)
  return [...points.slice(0, head), ...marker, ...points.slice(points.length - tail)].join('')
}
