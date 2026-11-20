import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCoreSpan, createOperationId, type ObservationEvent } from '@alvin0/ai-agent-sdk-core'
import { JsonlObservationJournalExporter } from '../../packages/observability-node/src/journal.ts'

function event(sequence: number, contentBytes: number): ObservationEvent {
  const occurredAt = new Date().toISOString()
  return { schemaVersion: 1, eventId: createOperationId(), sequence, name: 'sdk.model.call',
    phase: 'point', occurredAt, monotonicMs: 0, priority: 'normal',
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: 'test', runtime: 'node' },
    correlation: createCoreSpan({ name: 'sdk.model.call', runId: 'capacity-expiry',
      startedAt: occurredAt, monotonicMs: 0 }).correlation, data: { content: 'x'.repeat(contentBytes) } }
}

it.each(['current', 'closed'] as const)(
  'admits a retry after acknowledged %s segments reach their retention deadline', async state => {
    const root = await mkdtemp(join(tmpdir(), 'journal-capacity-expiry-'))
    const base = Date.now()
    let now = base
    let segmentId = 0
    const journal = new JsonlObservationJournalExporter({
      rootDir: root, mode: 'audit', maxSegmentBytes: state === 'current' ? 10_000 : 1,
      maxRetainedBytes: state === 'current' ? 2_000 : 2_500, acknowledgedRetentionMs: 1_000,
      now: () => new Date(now), segmentId: () => `capacityexpiry${++segmentId}`,
    })
    const signal = new AbortController().signal
    try {
      const retained = event(1, 500)
      await journal.stage(retained)
      if (state === 'closed') await journal.stage(event(2, 0))
      const existing = (await journal.recover()).records
      await journal.acknowledgeEvents(existing.map(record => record.event.eventId))
      for (const name of new Set(existing.map(record => record.segment))) {
        await utimes(join(root, name), new Date(base), new Date(base))
      }
      expect((await journal.stats()).unacknowledgedEvents).toBe(0)
      const incoming = event(3, state === 'current' ? 500 : 1_000)
      await expect(journal.stage(incoming)).rejects.toThrow(/capacity/)
      expect((await journal.recover()).records.map(record => record.event.eventId))
        .toEqual(existing.map(record => record.event.eventId))

      now = base + 1_001
      await expect(journal.stage(incoming)).resolves.toBeUndefined()
      const recovered = await journal.recover()
      expect(recovered.quarantinedSegments).toEqual([])
      expect(recovered.records.map(record => record.event.eventId)).toContain(incoming.eventId)
      expect((await journal.stats()).retainedBytes).toBeLessThanOrEqual(state === 'current' ? 2_000 : 2_500)
    } finally {
      await journal.shutdown(signal)
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('preserves unacknowledged current records after their retention age has elapsed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-unacknowledged-capacity-'))
  let now = Date.now()
  const journal = new JsonlObservationJournalExporter({
    rootDir: root, mode: 'audit', maxSegmentBytes: 10_000, maxRetainedBytes: 2_000,
    acknowledgedRetentionMs: 1_000, now: () => new Date(now),
  })
  const signal = new AbortController().signal
  try {
    const retained = event(1, 500)
    await journal.stage(retained)
    now += 60_000
    await expect(journal.stage(event(2, 500))).rejects.toThrow(/capacity/)
    expect((await journal.recover()).records.map(record => record.event.eventId)).toEqual([retained.eventId])
    expect((await journal.stats()).unacknowledgedEvents).toBe(1)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})
