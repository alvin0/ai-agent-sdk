import type { HistoryEntry, HistoryEvent, ResolvedHistoryLimits } from './types.ts'
import { countImages, retainLatestImagesInEvent } from './image-retention.ts'
import type { ImageRetentionMetrics, ResolvedImageRetentionOptions } from './image-retention.ts'

export function preRetentionLimits(limits: ResolvedHistoryLimits): ResolvedHistoryLimits {
  const maxEntries = Math.max(limits.maxEntries, 100_000)
  const maxEntryBytes = Math.max(limits.maxEntryBytes, 16 * 1024 * 1024)
  const maxBytes = Math.max(limits.maxBytes, 128 * 1024 * 1024, maxEntryBytes)
  return Object.freeze({ maxEntries, maxEntryBytes, maxBytes })
}

/**
 * Prune aged-out images from snapshot entries in place.
 * @returns the pruning metrics and each entry's image count after pruning, so
 * callers can seed retention bookkeeping without walking the entries again.
 */
export function pruneSnapshotImages(
  entries: HistoryEntry[],
  policy: ResolvedImageRetentionOptions,
): { readonly persistedMetrics: ImageRetentionMetrics; readonly imageCounts: readonly number[] } {
  const counts = entries.map(entry => countImages(entry.event))
  let remaining = Math.max(0, counts.reduce((total, count) => total + count, 0) - policy.keepLatest)
  let imagesPruned = 0
  let bytesSaved = 0
  for (let index = 0; index < entries.length && remaining > 0; index++) {
    const count = Math.min(remaining, counts[index] ?? 0)
    if (count === 0) continue
    const entry = entries[index]!
    const pruned = retainLatestImagesInEvent(entry.event, count, policy)
    entries[index] = { ...entry, event: pruned.event }
    counts[index] = counts[index]! - pruned.metrics.imagesPruned
    remaining -= pruned.metrics.imagesPruned
    imagesPruned += pruned.metrics.imagesPruned
    bytesSaved += pruned.metrics.bytesSaved
  }
  return { persistedMetrics: Object.freeze({ imagesPruned, bytesSaved }), imageCounts: counts }
}

export interface StoredImageUpdate {
  readonly seq: number
  readonly entry: HistoryEntry
  readonly byteDelta: number
}

export interface StoredPrunePlan {
  readonly updates: readonly StoredImageUpdate[]
  readonly prunedImages: number
  readonly bytesSaved: number
  readonly storedByteDelta: number
}

export interface RetentionPlan extends StoredPrunePlan {
  readonly events: HistoryEvent[]
  readonly newImagesPruned: number
  readonly newBytesSaved: number
}
