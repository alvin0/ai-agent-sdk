import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { recoverJournal } from './recovery.ts'
import type { JournalRecoveryRecord } from './types.ts'

/** Collect whole-segment acknowledgment evidence before retention can remove any file. */
export async function journalRetentionCandidates(root: string, acknowledged: ReadonlySet<string>) {
  const recovered = await recoverJournal(root)
  const bySegment = new Map<string, JournalRecoveryRecord[]>()
  for (const record of recovered.records) {
    const records = bySegment.get(record.segment) ?? []
    records.push(record)
    bySegment.set(record.segment, records)
  }
  const candidates: Array<{ name: string; bytes: number; mtimeMs: number; acknowledged: boolean }> = []
  for (const [name, records] of bySegment) {
    const info = await stat(join(root, name))
    candidates.push({ name, bytes: info.size, mtimeMs: info.mtimeMs,
      acknowledged: records.every(record => acknowledged.has(record.event.eventId)) })
  }
  return { bySegment, candidates }
}
