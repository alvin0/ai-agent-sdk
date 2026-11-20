/** Surface range selection and lossless-log tool-result pruning. */

import type { ContentBlock } from '../../message/index.ts'
import { createMessage } from '../../message/index.ts'
import type { ToolCallId } from '../../primitives/index.ts'
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
  keepFrom = balancedPrefixLength(surface, keepFrom)
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

function balancedPrefixLength(surface: readonly HistorySurfaceNode[], split: number): number {
  const calls = indexToolCalls(surface)
  const boundaries = new Int32Array(surface.length + 1)
  for (let index = 0; index < surface.length; index++) {
    for (const block of surface[index]!.message.content) {
      if (block.type !== 'tool-result') continue
      const call = calls.get(block.toolCallId)
      if (call === undefined) return 0
      // Every split between a call and its result separates that pair. Mark
      // these intervals once instead of rescanning the surface per candidate.
      const from = Math.min(call, index) + 1
      const to = Math.max(call, index) + 1
      boundaries[from] = boundaries[from]! + 1
      boundaries[to] = boundaries[to]! - 1
    }
  }
  let crossing = 0
  let balanced = 0
  for (let index = 0; index <= split; index++) {
    crossing += boundaries[index]!
    if (crossing === 0) balanced = index
  }
  return balanced
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

function indexToolCalls(
  surface: readonly HistorySurfaceNode[],
): ReadonlyMap<ToolCallId, number> {
  const calls = new Map<ToolCallId, number>()
  for (let index = 0; index < surface.length; index++) {
    for (const block of surface[index]!.message.content) {
      if (block.type === 'tool-call') calls.set(block.id, index)
    }
  }
  return calls
}
