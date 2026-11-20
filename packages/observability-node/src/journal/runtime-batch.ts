import { deepFreeze } from '@alvin0/ai-agent-sdk-core'
import type { ObservationDeliveryAck, ObservationDeliveryBatch } from '@alvin0/ai-agent-sdk-core/observability'
import { captureRuntimeJournalItem } from './runtime-frame.ts'
import { journalChecksum } from './frame.ts'
import { waitForJournalExport } from './batch.ts'

export interface RuntimeBatchReceipt {
  readonly keys: readonly string[]
  readonly payloadHash: string
  readonly promise: Promise<ObservationDeliveryAck>
  readonly controller: AbortController
  waiters: number
  delivered: boolean
}

export function captureRuntimeJournalBatch(batch: ObservationDeliveryBatch) {
  const batchId = batch.id
  const items = [...batch.events, ...batch.runRecords].map(captureRuntimeJournalItem)
  const keys = Object.freeze(items.map(item => item.key))
  const payloadHash = journalChecksum(JSON.stringify(items.map(item => item.payloadHash)))
  const acknowledgment = deepFreeze({ batchId,
    acceptedEventIds: items.filter(item => item.kind === 'event').map(item => item.id),
    acceptedRunIds: items.filter(item => item.kind === 'run-terminal-record').map(item => item.id) })
  return { batchId, items, keys, payloadHash, acknowledgment }
}

export function waitForRuntimeJournalExport(
  receipt: RuntimeBatchReceipt, signal: AbortSignal,
): Promise<ObservationDeliveryAck> {
  receipt.waiters++
  let waiting = true
  const leave = (): void => {
    if (!waiting) return
    waiting = false
    receipt.waiters--
    if (receipt.waiters === 0 && !receipt.delivered) receipt.controller.abort(signal.reason)
  }
  signal.addEventListener('abort', leave, { once: true })
  if (signal.aborted) leave()
  return waitForJournalExport(receipt.promise, signal).finally(() => {
    signal.removeEventListener('abort', leave)
    leave()
  })
}
