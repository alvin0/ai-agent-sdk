import { journalFailure } from './errors.ts'
import type { SegmentState } from './types.ts'

export async function appendJournalLine(
  segment: SegmentState, line: string, invalidateWriter: (error: Error) => void,
): Promise<void> {
  try { await segment.handle.writeFile(line, 'utf8') }
  catch (writeError) {
    try {
      await segment.handle.truncate(segment.bytes)
      await segment.handle.datasync()
    } catch (rollbackError) {
      const failure = journalFailure('io', 'journal append rollback failed', rollbackError)
      invalidateWriter(failure)
      throw failure
    }
    throw writeError
  }
}
