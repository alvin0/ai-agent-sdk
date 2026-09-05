import type { Message } from '../../message/index.ts'
import { deepFreeze } from '../../primitives/index.ts'
import { projectHistorySurface, projectMessages } from './project.ts'
import {
  type SurfaceOp, type HistoryEvent, type HistoryEntry, type HistorySnapshot, type HistoryLimits,
  type ResolvedHistoryLimits,
} from './types.ts'
import { resolveHistoryLimits, serializedBytes } from './config.ts'
import {
  snapshotEntries, assertEntriesWithinLimits, emptyValidationState, cloneValidationState,
  validateEntries, type SnapshotValidationState, validateHistoryEvent, updateVisibleMessages,
  messageOfHistoryEvent, validateSurfaceOp,
} from './validation.ts'

/** Append-only conversation history with a replaceable model-facing projection. */
export class History {
  private readonly log: HistoryEntry[]
  private replacementGeneration: number
  private validationState: SnapshotValidationState
  private readonly limits: ResolvedHistoryLimits
  private storedBytes = 0

  constructor(limits: HistoryLimits = {}) {
    this.log = []
    this.replacementGeneration = 0
    this.validationState = emptyValidationState()
    this.limits = resolveHistoryLimits(limits)
  }

  private static hydrate(
    entries: HistoryEntry[],
    validationState: SnapshotValidationState,
    limits: ResolvedHistoryLimits,
    storedBytes: number,
  ): History {
    const history = new History(limits)
    history.log.push(...entries)
    history.replacementGeneration = entries.filter(entry => entry.surfaceOp !== 'append').length
    history.validationState = validationState
    history.storedBytes = storedBytes
    return history
  }

  static fromSnapshot(snapshot: HistorySnapshot, limits: HistoryLimits = {}): History {
    const resolved = resolveHistoryLimits(limits)
    const sourceEntries = snapshotEntries(snapshot)
    if (sourceEntries.length > resolved.maxEntries) {
      throw new RangeError(`history snapshot exceeds the ${resolved.maxEntries}-entry limit`)
    }
    // Reject oversized input before duplicating it with structuredClone. The
    // detached clone is measured again because accessors/toJSON on hostile
    // objects must not be able to make the preflight size authoritative.
    assertEntriesWithinLimits(sourceEntries, resolved)
    const clone = structuredClone(sourceEntries) as HistoryEntry[]
    const storedBytes = assertEntriesWithinLimits(clone, resolved)
    const validationState = validateEntries(clone)
    return History.hydrate(clone.map(entry => deepFreeze(entry)), validationState, resolved, storedBytes)
  }

  private static assertCandidateWithinLimits(entry: HistoryEntry, limits: ResolvedHistoryLimits): number {
    const bytes = serializedBytes(entry)
    if (bytes > limits.maxEntryBytes) {
      throw new RangeError(`history entry exceeds the ${limits.maxEntryBytes}-byte limit`)
    }
    return bytes
  }

  private static cloneCandidate(
    seq: number,
    event: HistoryEvent,
    surfaceOp: SurfaceOp,
    limits: ResolvedHistoryLimits,
  ): { readonly entry: HistoryEntry; readonly bytes: number } {
    const source = { seq, event, surfaceOp }
    // Preflight before cloning so a single oversized caller value cannot force
    // an equally large detached copy merely to discover that it exceeds policy.
    History.assertCandidateWithinLimits(source, limits)
    const entry = structuredClone(source) as HistoryEntry
    return { entry, bytes: History.assertCandidateWithinLimits(entry, limits) }
  }

  append(event: HistoryEvent, surfaceOp: SurfaceOp = 'append'): HistoryEntry {
    return this.appendOne(event, surfaceOp)
  }

  /** Validate and commit related history writes atomically. */
  appendBatch(
    writes: readonly { readonly event: HistoryEvent; readonly surfaceOp?: SurfaceOp }[],
  ): readonly HistoryEntry[] {
    if (writes.length === 0) return Object.freeze([])
    if (writes.length === 1) {
      const write = writes[0]!
      return Object.freeze([this.appendOne(write.event, write.surfaceOp ?? 'append')])
    }
    if (this.log.length + writes.length > this.limits.maxEntries) {
      throw new RangeError(`history reached its ${this.limits.maxEntries}-entry limit`)
    }
    const state = cloneValidationState(this.validationState)
    const candidates: HistoryEntry[] = []
    let totalBytes = this.storedBytes
    let replacements = 0
    for (let index = 0; index < writes.length; index++) {
      const write = writes[index]!
      const surfaceOp = write.surfaceOp ?? 'append'
      const { entry: candidate, bytes: entryBytes } = History.cloneCandidate(
        this.log.length + index + 1, write.event, surfaceOp, this.limits,
      )
      validateHistoryEvent(candidate.event, candidate.seq, state)
      validateSurfaceOp(
        candidate.surfaceOp,
        candidate.seq,
        state.visibleMessageSeqs,
        messageOfHistoryEvent(candidate.event),
      )
      updateVisibleMessages(candidate, state.visibleMessageSeqs)
      totalBytes += entryBytes
      if (totalBytes > this.limits.maxBytes) {
        throw new RangeError(`history reached its ${this.limits.maxBytes}-byte limit`)
      }
      candidates.push(deepFreeze(candidate))
      if (surfaceOp !== 'append') replacements++
    }
    this.log.push(...candidates)
    this.validationState = state
    this.storedBytes = totalBytes
    this.replacementGeneration += replacements
    return Object.freeze([...candidates])
  }

  private appendOne(event: HistoryEvent, surfaceOp: SurfaceOp): HistoryEntry {
    if (this.log.length >= this.limits.maxEntries) {
      throw new RangeError(`history reached its ${this.limits.maxEntries}-entry limit`)
    }
    const { entry: candidate, bytes: entryBytes } = History.cloneCandidate(
      this.log.length + 1, event, surfaceOp, this.limits,
    )
    try {
      validateHistoryEvent(candidate.event, candidate.seq, this.validationState)
      validateSurfaceOp(
        candidate.surfaceOp,
        candidate.seq,
        this.validationState.visibleMessageSeqs,
        messageOfHistoryEvent(candidate.event),
      )
      updateVisibleMessages(candidate, this.validationState.visibleMessageSeqs)
      if (this.storedBytes + entryBytes > this.limits.maxBytes) {
        throw new RangeError(`history reached its ${this.limits.maxBytes}-byte limit`)
      }
      const entry = deepFreeze(candidate)
      this.log.push(entry)
      this.storedBytes += entryBytes
      if (surfaceOp !== 'append') this.replacementGeneration++
      return entry
    } catch (error: unknown) {
      // Incremental validators mutate correlation sets. Rebuild only on the
      // exceptional path so normal append stays O(1) rather than O(history).
      this.validationState = validateEntries(this.log)
      throw error
    }
  }

  entries(): readonly HistoryEntry[] {
    return Object.freeze([...this.log])
  }

  messages(): readonly Message[] {
    return projectMessages(this.log)
  }

  /** Current model-visible nodes with durable seq identity, in surface order. */
  surface(): readonly import('./project.ts').HistorySurfaceNode[] {
    return projectHistorySurface(this.log)
  }

  generation(): number {
    return this.replacementGeneration
  }

  snapshot(): HistorySnapshot {
    return deepFreeze(structuredClone({ version: 1 as const, entries: this.log }))
  }
}

export type {
  SurfaceOp, CompactionBackoffReason, HistoryEvent, HistoryEntry, HistorySnapshot, HistoryLimits,
} from './types.ts'
