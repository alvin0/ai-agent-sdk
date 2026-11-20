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
    applyHistoryEntry(visible, entry)
  }
  return Object.freeze(visible.map(item => Object.freeze({ ...item })))
}

function applyHistoryEntry(visible: HistorySurfaceNode[], entry: HistoryEntry): void {
  const operation = entry.surfaceOp === 'append' ? undefined : entry.surfaceOp
  const targets = operation?.targets === undefined ? undefined : new Set(operation.targets)
  const insertionIndex = removeSelected(visible, operation, targets)
  const message = messageOf(entry)
  if (message !== undefined) visible.splice(insertionIndex, 0, { seq: entry.seq, message })
}

function removeSelected(
  visible: HistorySurfaceNode[],
  operation: Exclude<HistoryEntry['surfaceOp'], 'append'> | undefined,
  targets: Set<number> | undefined,
): number {
  if (operation === undefined) return visible.length
  let insertionIndex: number | undefined
  let retained = 0
  for (const current of visible) {
    if (isSelected(current, operation, targets)) insertionIndex ??= retained
    else visible[retained++] = current
  }
  visible.length = retained
  return insertionIndex ?? retained
}

function isSelected(
  current: HistorySurfaceNode,
  operation: Exclude<HistoryEntry['surfaceOp'], 'append'>,
  targets: Set<number> | undefined,
): boolean {
  if (targets !== undefined) return targets.has(current.seq)
  return current.seq >= operation.from && current.seq <= operation.to
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
