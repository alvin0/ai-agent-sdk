import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { journalFailure } from './errors.ts'
import { parseRuntimeJournalLine, type RuntimeJournalRecord } from './runtime-frame.ts'
import { readSegmentLines } from './segment-reader.ts'

export async function recoverRuntimeSegment(root: string, name: string, state: {
  payloads: ReadonlyMap<string, string>; truncatedSegments: string[]; quarantinedSegments: string[]
}): Promise<RuntimeJournalRecord[]> {
  const { payloads, truncatedSegments, quarantinedSegments } = state
  const path = join(root, name)
  const lines = await readSegmentLines(root, name, truncatedSegments, true)
  const segmentRecords: RuntimeJournalRecord[] = []
  for (let index = 0; index < lines.length; index++) {
    try {
      const record = parseRuntimeJournalLine(lines[index] ?? '', name, index + 1)
      const previous = payloads.get(record.key)
      if (previous !== undefined && previous !== record.payloadJson) throw new Error('conflicting duplicate item')
      segmentRecords.push(record)
    } catch (error) {
      if (index !== lines.length - 1) {
        throw journalFailure('corrupt', `runtime journal segment ${name} has mid-file corruption`, error)
      }
      const quarantine = `${name}.corrupt-${Date.now()}`
      await rename(path, join(root, quarantine))
      quarantinedSegments.push(quarantine)
      segmentRecords.length = 0
      break
    }
  }
  return segmentRecords
}

