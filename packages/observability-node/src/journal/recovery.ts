import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { deepFreeze } from '@alvin0/ai-agent-sdk-core'
import { ensureSafeRoot } from '../common/safe-filesystem.ts'
import { readSegmentLines } from './segment-reader.ts'
import { journalFailure } from './errors.ts'
import { journalChecksum, validObservationEvent } from './frame.ts'
import type { JournalRecoveryRecord, JournalRecoveryResult } from './types.ts'

export async function recoverJournal(rootInput: string): Promise<JournalRecoveryResult> {
  const root = await ensureSafeRoot(rootInput)
  const names = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
  const records: JournalRecoveryRecord[] = []
  const quarantinedSegments: string[] = []
  const truncatedSegments: string[] = []
  const eventIds = new Set<string>()
  for (const name of names) {
    await recoverSegment(root, name, { records, quarantinedSegments, truncatedSegments, eventIds })
  }
  return deepFreeze({ records, quarantinedSegments, truncatedSegments })
}

interface RecoveryState {
  records: JournalRecoveryRecord[]; quarantinedSegments: string[]; truncatedSegments: string[]; eventIds: Set<string>
}

async function recoverSegment(root: string, name: string, state: RecoveryState): Promise<void> {
  const { records, quarantinedSegments, truncatedSegments, eventIds } = state
  const lines = await readSegmentLines(root, name, truncatedSegments, false)
  const segmentEventIds: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    try {
      const { event, payloadJson, eventId } = parseRecoveryLine(line, eventIds)
      eventIds.add(eventId)
      segmentEventIds.push(eventId)
      records.push(deepFreeze({ segment: name, line: index + 1, event, payloadJson }))
    } catch (error) {
      if (index === lines.length - 1) {
        await quarantineSegment(root, name, { records, quarantinedSegments, eventIds, segmentEventIds })
        break
      }
      throw journalFailure('corrupt', `journal segment ${name} has mid-file corruption`, error)
    }
  }
}

function parseRecoveryLine(line: string, eventIds: ReadonlySet<string>) {
  const envelope = JSON.parse(line) as Record<string, unknown>
  if (envelope.schemaVersion !== 1 || typeof envelope.eventId !== 'string'
    || typeof envelope.payloadJson !== 'string' || typeof envelope.sha256 !== 'string'
    || envelope.sha256 !== journalChecksum(envelope.payloadJson)) throw new Error('invalid frame')
  const event = JSON.parse(envelope.payloadJson) as unknown
  if (!validObservationEvent(event, envelope.eventId) || eventIds.has(envelope.eventId))
    throw new Error('invalid event')
  return { event, payloadJson: envelope.payloadJson, eventId: envelope.eventId }
}

async function quarantineSegment(root: string, name: string, state: {
  records: JournalRecoveryRecord[]; quarantinedSegments: string[]; eventIds: Set<string>; segmentEventIds: string[]
}): Promise<void> {
  const { records, quarantinedSegments, eventIds, segmentEventIds } = state
  const quarantine = `${name}.corrupt-${Date.now()}`
  await rename(join(root, name), join(root, quarantine))
  quarantinedSegments.push(quarantine)
  for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex--) {
    if (records[recordIndex]?.segment === name) records.splice(recordIndex, 1)
  }
  for (const eventId of segmentEventIds) eventIds.delete(eventId)
}
