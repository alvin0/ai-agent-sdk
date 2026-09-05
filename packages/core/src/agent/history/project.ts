import type { Message } from '../../message/index.ts'
import type { HistoryEntry } from './history.ts'

export interface HistorySurfaceNode {
  readonly seq: number
  readonly message: Message
}

/** Rebuild the model-visible surface from an append-only history prefix. */
export function projectMessages(entries: readonly HistoryEntry[]): readonly Message[] {
  return Object.freeze(projectHistorySurface(entries).map(item => item.message))
}

/** Rebuild the model-visible surface while retaining durable log identities. */
export function projectHistorySurface(entries: readonly HistoryEntry[]): readonly HistorySurfaceNode[] {
  const visible: HistorySurfaceNode[] = []
  for (const entry of entries) {
    let insertionIndex = visible.length
    if (entry.surfaceOp !== 'append') {
      const operation = entry.surfaceOp
      const targets = operation.targets === undefined
        ? undefined
        : new Set(operation.targets)
      const replaced = visible.flatMap((current, index) => {
        const selected = targets?.has(current.seq)
          ?? (current.seq >= operation.from && current.seq <= operation.to)
        return selected ? [index] : []
      })
      if (replaced.length > 0) insertionIndex = replaced[0] ?? visible.length
      for (let index = visible.length - 1; index >= 0; index--) {
        const current = visible[index]
        if (current !== undefined && (targets?.has(current.seq)
          ?? (current.seq >= operation.from && current.seq <= operation.to))) {
          visible.splice(index, 1)
        }
      }
    }
    const message = messageOf(entry)
    if (message !== undefined) visible.splice(insertionIndex, 0, { seq: entry.seq, message })
  }
  return Object.freeze(visible.map(item => Object.freeze({ ...item })))
}

function messageOf(entry: HistoryEntry): Message | undefined {
  switch (entry.event.kind) {
    case 'user':
    case 'assistant':
      return entry.event.message
    case 'tool-result':
      return entry.event.message
    case 'tool-call':
    case 'compaction-start':
    case 'compaction-prune':
    case 'compaction-summary':
    case 'compaction-end':
      return undefined
  }
}
