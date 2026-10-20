import type { Message } from '../../message/index.ts'
import { deepFreeze } from '../../primitives/index.ts'
import { projectHistorySurface, projectMessages } from './project.ts'
import {
  type SurfaceOp, type HistoryEvent, type HistoryEntry, type HistorySnapshot, type HistoryLimits,
  type ResolvedHistoryLimits,
} from './types.ts'
import { resolveHistoryLimits, serializedBytes } from './config.ts'
import {
  countImages, retainLatestImagesInEvent, resolveImageRetention,
  type ImageRetentionMetrics, type ImageRetentionOptions, type ImageRetentionSnapshot,
  type ResolvedImageRetentionOptions,
} from './image-retention.ts'
import {
  preRetentionLimits, pruneSnapshotImages,
  type RetentionPlan, type StoredImageUpdate, type StoredPrunePlan,
} from './image-retention-storage.ts'
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
  private imageRetention: ResolvedImageRetentionOptions | undefined
  private retainedImages = 0
  private readonly imageEntries: { seq: number; count: number }[] = []
  private imageEntryHead = 0
  private requestImagesPruned = 0
  private requestBytesSaved = 0
  private persistedImagesPruned = 0
  private persistedBytesSaved = 0

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
    storage: {
      readonly storedBytes: number
      readonly imageRetention?: ResolvedImageRetentionOptions | undefined
      readonly persistedMetrics?: ImageRetentionMetrics
      readonly imageCounts?: readonly number[]
    },
  ): History {
    const history = new History(limits)
    history.log.push(...entries)
    history.replacementGeneration = entries.filter(entry => entry.surfaceOp !== 'append').length
    history.validationState = validationState
    history.storedBytes = storage.storedBytes
    history.persistedImagesPruned = storage.persistedMetrics?.imagesPruned ?? 0
    history.persistedBytesSaved = storage.persistedMetrics?.bytesSaved ?? 0
    if (storage.imageRetention !== undefined) history.applyImageRetention(storage.imageRetention, storage.imageCounts)
    return history
  }

  static fromSnapshot(
    snapshot: HistorySnapshot,
    limits: HistoryLimits = {},
    imageRetention?: ImageRetentionOptions,
  ): History {
    const resolved = resolveHistoryLimits(limits)
    const retention = resolveImageRetention(imageRetention)
    const sourceEntries = snapshotEntries(snapshot)
    // Image pruning never removes entries, so the count is checked against the
    // configured limit even when byte limits are relaxed for pre-retention input.
    if (sourceEntries.length > resolved.maxEntries) {
      throw new RangeError(`history snapshot exceeds the ${resolved.maxEntries}-entry limit`)
    }
    const preflightLimits = retention?.persist === 'drop-pruned'
      ? preRetentionLimits(resolved) : resolved
    // Reject oversized input before duplicating it with structuredClone. The
    // detached clone is measured again because accessors/toJSON on hostile
    // objects must not be able to make the preflight size authoritative.
    assertEntriesWithinLimits(sourceEntries, preflightLimits)
    const clone = structuredClone(sourceEntries) as HistoryEntry[]
    const pruned = retention?.persist === 'drop-pruned' ? pruneSnapshotImages(clone, retention) : undefined
    const storedBytes = assertEntriesWithinLimits(clone, resolved)
    const validationState = validateEntries(clone)
    return History.hydrate(clone.map(entry => deepFreeze(entry)), validationState, resolved, {
      storedBytes, imageRetention: retention, ...pruned,
    })
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
    const retentionPlan = this.planBatchRetention(writes)
    const state = cloneValidationState(this.validationState)
    const candidates: HistoryEntry[] = []
    let totalBytes = this.storedBytes - retentionPlan.storedByteDelta
    let replacements = 0
    for (let index = 0; index < writes.length; index++) {
      const write = writes[index]!
      const surfaceOp = write.surfaceOp ?? 'append'
      const { entry: candidate, bytes: entryBytes } = History.cloneCandidate(
        this.log.length + index + 1, retentionPlan.events[index] ?? write.event, surfaceOp, this.limits,
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
    this.commitStoredImageUpdates(retentionPlan.updates)
    this.log.push(...candidates)
    this.validationState = state
    this.storedBytes = totalBytes
    this.replacementGeneration += replacements
    this.commitBatchRetention(retentionPlan, candidates)
    return Object.freeze([...candidates])
  }

  private appendOne(event: HistoryEvent, surfaceOp: SurfaceOp): HistoryEntry {
    if (this.log.length >= this.limits.maxEntries) {
      throw new RangeError(`history reached its ${this.limits.maxEntries}-entry limit`)
    }
    const retentionPlan = this.planBatchRetention([{ event, surfaceOp }])
    const { entry: candidate, bytes: entryBytes } = History.cloneCandidate(
      this.log.length + 1, retentionPlan.events[0] ?? event, surfaceOp, this.limits,
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
      const nextStoredBytes = this.storedBytes - retentionPlan.storedByteDelta + entryBytes
      if (nextStoredBytes > this.limits.maxBytes) {
        throw new RangeError(`history reached its ${this.limits.maxBytes}-byte limit`)
      }
      const entry = deepFreeze(candidate)
      this.commitStoredImageUpdates(retentionPlan.updates)
      this.log.push(entry)
      this.storedBytes = nextStoredBytes
      if (surfaceOp !== 'append') this.replacementGeneration++
      this.commitBatchRetention(retentionPlan, [entry])
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

  /** Configure session-level image storage retention. Existing entries are pruned once on setup. */
  configureImageRetention(input: ImageRetentionOptions | ResolvedImageRetentionOptions): void {
    this.applyImageRetention(resolveImageRetention(input))
  }

  /** @param counts - known per-entry image counts, aligned with the log, to skip a rescan. */
  private applyImageRetention(
    resolved: ResolvedImageRetentionOptions | undefined, counts?: readonly number[],
  ): void {
    // Resolution is cached per input object, so a repeat of the active policy
    // (e.g. a resumed history handed to a session) needs no second O(history) scan.
    if (resolved !== undefined && resolved === this.imageRetention) return
    this.imageRetention = resolved
    this.retainedImages = 0
    this.imageEntries.length = 0
    this.imageEntryHead = 0
    if (resolved === undefined) return
    for (let index = 0; index < this.log.length; index++) {
      const entry = this.log[index]!
      const count = counts?.[index] ?? countImages(entry.event)
      if (count === 0) continue
      this.retainedImages += count
      if (resolved.persist === 'drop-pruned') this.imageEntries.push({ seq: entry.seq, count })
    }
    if (resolved.persist === 'drop-pruned') this.pruneStoredOverflow(resolved)
  }

  private pruneStoredOverflow(resolved: ResolvedImageRetentionOptions): void {
    const pruneCount = Math.max(0, this.retainedImages - resolved.keepLatest)
    if (pruneCount === 0) return
    const plan = this.planStoredPrune(pruneCount, resolved)
    this.commitStoredImageUpdates(plan.updates)
    this.commitQueuePrune(plan.prunedImages)
    this.retainedImages -= plan.prunedImages
    this.persistedImagesPruned += plan.prunedImages
    this.persistedBytesSaved += plan.bytesSaved
  }

  /** The active image retention policy, if any. */
  imageRetentionPolicy(): ResolvedImageRetentionOptions | undefined {
    return this.imageRetention
  }

  imageRetentionSnapshot(): ImageRetentionSnapshot | undefined {
    const policy = this.imageRetention
    return policy === undefined ? undefined : Object.freeze({
      keepLatest: policy.keepLatest,
      persist: policy.persist,
      imagesRetained: this.retainedImages,
      imagesPruned: this.requestImagesPruned,
      bytesSaved: this.requestBytesSaved,
      requestImagesPruned: this.requestImagesPruned,
      requestBytesSaved: this.requestBytesSaved,
      persistedImagesPruned: this.persistedImagesPruned,
      persistedBytesSaved: this.persistedBytesSaved,
    })
  }

  /** Record the most recent model-request projection without retaining request content. */
  recordImageRetention(metrics: ImageRetentionMetrics): void {
    if (this.imageRetention === undefined) return
    this.requestImagesPruned += metrics.imagesPruned
    this.requestBytesSaved += metrics.bytesSaved
  }

  private planBatchRetention(
    writes: readonly { readonly event: HistoryEvent; readonly surfaceOp?: SurfaceOp }[],
  ): RetentionPlan {
    const retention = this.imageRetention
    const events = writes.map(write => write.event)
    if (retention?.persist !== 'drop-pruned') return {
      events, updates: [], bytesSaved: 0, storedByteDelta: 0, prunedImages: 0, newImagesPruned: 0, newBytesSaved: 0,
    }
    const newImages = events.map(countImages)
    const newImageCount = newImages.reduce((total, count) => total + count, 0)
    const overflow = Math.max(0, this.retainedImages + newImageCount - retention.keepLatest)
    const oldPrune = Math.min(this.retainedImages, overflow)
    const stored = this.planStoredPrune(oldPrune, retention)
    let remaining = overflow - oldPrune
    let newImagesPruned = 0
    let newBytesSaved = 0
    for (let index = 0; index < events.length && remaining > 0; index++) {
      const count = Math.min(remaining, newImages[index] ?? 0)
      if (count === 0) continue
      const pruned = retainLatestImagesInEvent(events[index]!, count, retention)
      events[index] = pruned.event
      newImagesPruned += pruned.metrics.imagesPruned
      newBytesSaved += pruned.metrics.bytesSaved
      remaining -= pruned.metrics.imagesPruned
    }
    return {
      events,
      updates: stored.updates,
      bytesSaved: stored.bytesSaved,
      storedByteDelta: stored.storedByteDelta,
      prunedImages: stored.prunedImages,
      newImagesPruned,
      newBytesSaved,
    }
  }

  private planStoredPrune(count: number, retention: ResolvedImageRetentionOptions): StoredPrunePlan {
    let remaining = count
    const updates: StoredImageUpdate[] = []
    let prunedImages = 0
    let bytesSaved = 0
    let storedByteDelta = 0
    for (let index = this.imageEntryHead; index < this.imageEntries.length; index++) {
      if (remaining === 0) break
      const reference = this.imageEntries[index]!
      const remove = Math.min(remaining, reference.count)
      if (remove === 0) continue
      const current = this.log[reference.seq - 1]
      if (current === undefined) continue
      const pruned = retainLatestImagesInEvent(current.event, remove, retention)
      if (pruned.metrics.imagesPruned === 0) continue
      const entry = deepFreeze({ ...current, event: pruned.event })
      const byteDelta = pruned.serializedBytesDelta
      updates.push({ seq: current.seq, entry, byteDelta })
      prunedImages += pruned.metrics.imagesPruned
      bytesSaved += pruned.metrics.bytesSaved
      storedByteDelta += byteDelta
      remaining -= pruned.metrics.imagesPruned
    }
    return { updates, prunedImages, bytesSaved, storedByteDelta }
  }

  private commitStoredImageUpdates(updates: readonly StoredImageUpdate[]): void {
    for (const update of updates) {
      this.log[update.seq - 1] = update.entry
      this.storedBytes -= update.byteDelta
    }
  }

  private commitQueuePrune(count: number): void {
    let remaining = count
    while (remaining > 0) {
      const head = this.imageEntries[this.imageEntryHead]
      if (head === undefined) break
      const remove = Math.min(remaining, head.count)
      head.count -= remove
      remaining -= remove
      if (head.count === 0) this.imageEntryHead++
    }
    if (this.imageEntryHead >= 1_024 && this.imageEntryHead * 2 >= this.imageEntries.length) {
      this.imageEntries.splice(0, this.imageEntryHead)
      this.imageEntryHead = 0
    }
  }

  private commitBatchRetention(plan: RetentionPlan, candidates: readonly HistoryEntry[]): void {
    const retention = this.imageRetention
    if (retention === undefined) return
    const dropPruned = retention.persist === 'drop-pruned'
    if (dropPruned) this.commitQueuePrune(plan.prunedImages)
    for (const entry of candidates) {
      const count = countImages(entry.event)
      if (count === 0) continue
      this.retainedImages += count
      if (dropPruned) this.imageEntries.push({ seq: entry.seq, count })
    }
    if (!dropPruned) return
    this.retainedImages -= plan.prunedImages
    this.persistedImagesPruned += plan.prunedImages + plan.newImagesPruned
    this.persistedBytesSaved += plan.bytesSaved + plan.newBytesSaved
  }
}

export type {
  SurfaceOp, CompactionBackoffReason, HistoryEvent, HistoryEntry, HistorySnapshot, HistoryLimits,
} from './types.ts'
