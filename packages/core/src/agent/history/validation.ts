import { validateHistoryEvent } from './validation-events.ts'
import { type SnapshotValidationState } from './validation-primitives.ts'
export { validateHistoryEvent } from './validation-events.ts'
export * from './validation-content.ts'
export * from './validation-primitives.ts'
import {
  type SurfaceOp, type HistoryEvent, type HistoryEntry, type HistorySnapshot,
  type ResolvedHistoryLimits,
} from './types.ts'
import { serializedBytes } from './config.ts'

export function snapshotEntries(value: unknown): readonly HistoryEntry[] {
  if (typeof value !== 'object' || value === null) throw new TypeError('history snapshot must be an object')
  const snapshot = value as Partial<HistorySnapshot>
  if (snapshot.version !== 1) throw new TypeError('unsupported history snapshot version')
  if (!Array.isArray(snapshot.entries)) throw new TypeError('history snapshot entries must be an array')
  return snapshot.entries as readonly HistoryEntry[]
}

export function assertEntriesWithinLimits(entries: readonly HistoryEntry[], limits: ResolvedHistoryLimits): number {
  let totalBytes = 0
  for (const entry of entries) {
    const bytes = serializedBytes(entry)
    if (bytes > limits.maxEntryBytes) {
      throw new RangeError(`history snapshot entry exceeds the ${limits.maxEntryBytes}-byte limit`)
    }
    totalBytes += bytes
    if (totalBytes > limits.maxBytes) {
      throw new RangeError(`history snapshot exceeds the ${limits.maxBytes}-byte limit`)
    }
  }
  return totalBytes
}

export function emptyValidationState(): SnapshotValidationState {
  return {
    messageIds: new Set(),
    toolCallIds: new Set(),
    nativeToolIds: new Set(),
    toolCallEventIds: new Set(),
    compactions: new Map(),
    visibleMessageSeqs: new Set(),
  }
}

export function cloneValidationState(state: SnapshotValidationState): SnapshotValidationState {
  return {
    messageIds: new Set(state.messageIds),
    toolCallIds: new Set(state.toolCallIds),
    nativeToolIds: new Set(state.nativeToolIds),
    toolCallEventIds: new Set(state.toolCallEventIds),
    compactions: new Map([...state.compactions].map(([id, lifecycle]) => [id, { ...lifecycle }])),
    visibleMessageSeqs: new Set(state.visibleMessageSeqs),
  }
}

export function validateEntries(entries: readonly HistoryEntry[]): SnapshotValidationState {
  const state = emptyValidationState()
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as Partial<HistoryEntry> | undefined
    if (entry === undefined || entry.seq !== index + 1 || typeof entry.event !== 'object'
      || entry.event === null || !('kind' in entry.event)) {
      throw new TypeError(`invalid history entry at index ${index}`)
    }
    if (![
      'user', 'assistant', 'tool-call', 'tool-result',
      'compaction-start', 'compaction-prune', 'compaction-summary', 'compaction-end',
    ].includes(String(entry.event.kind))) {
      throw new TypeError(`unknown history event kind at index ${index}`)
    }
    validateHistoryEvent(entry.event, entry.seq, state)
    validateSurfaceOp(
      entry.surfaceOp as SurfaceOp,
      entry.seq,
      state.visibleMessageSeqs,
      messageOfHistoryEvent(entry.event),
    )
    updateVisibleMessages(entry as HistoryEntry, state.visibleMessageSeqs)
  }
  return state
}

export function updateVisibleMessages(entry: HistoryEntry, visible: Set<number>): void {
  if (entry.surfaceOp !== 'append') {
    const operation = entry.surfaceOp
    const targets = operation.targets === undefined
      ? [...visible].filter(seq => seq >= operation.from && seq <= operation.to)
      : [...operation.targets]
    for (const target of targets) visible.delete(target)
  }
  if (messageOfHistoryEvent(entry.event)) visible.add(entry.seq)
}

export function messageOfHistoryEvent(event: HistoryEvent): boolean {
  return event.kind === 'user' || event.kind === 'assistant' || event.kind === 'tool-result'
}

export function validateSurfaceOp(
  op: SurfaceOp,
  nextSeq: number,
  visible?: ReadonlySet<number>,
  replacementCarriesMessage = true,
): void {
  if (op === 'append') return
  validateReplaceSpan(op, nextSeq)
  validateReplaceTargets(op, nextSeq)
  if (visible !== undefined) {
    if (!replacementCarriesMessage) throw new TypeError('history replacement entry must carry a message')
    const targets = op.targets ?? [...visible].filter(seq => seq >= op.from && seq <= op.to)
    if (targets.length === 0 || targets.some(seq => !visible.has(seq))) {
      throw new TypeError('history replace targets must reference current visible messages')
    }
  }
}

function validateReplaceSpan(op: Exclude<SurfaceOp, 'append'>, nextSeq: number): void {
  if (typeof op !== 'object' || op.op !== 'replace'
    || !Number.isInteger(op.from) || !Number.isInteger(op.to)
    || op.from < 1 || op.to < op.from || op.to >= nextSeq) {
    throw new TypeError('history replace span must reference an earlier inclusive sequence range')
  }
}

function validateReplaceTargets(op: Exclude<SurfaceOp, 'append'>, nextSeq: number): void {
  if (op.targets !== undefined) {
    if (op.targets.length === 0 || new Set(op.targets).size !== op.targets.length
      || op.targets.some(seq => !Number.isInteger(seq) || seq < 1 || seq >= nextSeq)) {
      throw new TypeError('history replace targets must be unique earlier sequence numbers')
    }
    if (op.targets.some(seq => seq < op.from || seq > op.to)) {
      throw new TypeError('history replace targets must stay within its inclusive sequence range')
    }
  }
}
