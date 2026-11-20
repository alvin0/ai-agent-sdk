import type { ObservationBatch } from '@alvin0/ai-agent-sdk-core/observability'
import { captureJournalEvent, journalChecksum } from './frame.ts'
import type { JournalBatchReceipt } from './types.ts'

export function reclaimAcknowledgedBatches(
  batches: Map<string, JournalBatchReceipt>, acknowledged: ReadonlySet<string>, retained: ReadonlyMap<string, string>,
): void {
  for (const [batchId, receipt] of batches) {
    if (receipt.delivered && receipt.eventIds.every(id => acknowledged.has(id) || !retained.has(id))) {
      batches.delete(batchId)
    }
  }
}

export function captureJournalBatch(batch: ObservationBatch) {
  const batchId = batch.batchId
  const events = batch.events.map(captureJournalEvent)
  return { batchId, events, eventIds: Object.freeze(events.map(event => event.eventId)),
    payloadHash: journalChecksum(JSON.stringify(events.map(event => event.payloadHash))) }
}

export function waitForJournalExport<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new Error('journal export aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(
      acknowledgment => { cleanup(); resolve(acknowledgment) },
      error => { cleanup(); reject(error) },
    )
    if (signal.aborted) abort()
  })
}
