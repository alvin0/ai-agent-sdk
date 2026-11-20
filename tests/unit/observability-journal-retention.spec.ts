import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { JsonlObservationJournalExporter } from '../../packages/observability-node/src/journal.ts'
import { RuntimeJsonlJournal } from '../../packages/observability-node/src/journal/runtime-store.ts'
import { captureRuntimeJournalOptions } from '../../packages/observability-node/src/journal/runtime-options.ts'
import { batch, event } from './observability-journal-fixtures.ts'

it('keeps a newly queued export receipt when an earlier acknowledgment runs first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-queued-ack-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    const first = event(1)
    const second = event(2)
    await journal.export(batch('first', [first]), signal)
    const acknowledged = journal.acknowledgeEvents([first.eventId])
    const exported = journal.export(batch('second', [second]), signal)
    await Promise.all([acknowledged, exported])
    await expect(journal.acknowledgeBatch('second')).resolves.toBe(1)
    expect((await journal.stats()).unacknowledgedEvents).toBe(0)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['absent', 'expired'] as const)('ignores stale %s acknowledgments before redelivery', async state => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-stale-ack-test-'))
  let segment = 0
  const journal = new JsonlObservationJournalExporter({
    rootDir: root, mode: 'operational', maxSegmentBytes: 1, acknowledgedRetentionMs: 1,
    now: () => new Date(Date.now() + 60_000), segmentId: () => `staleack${++segment}`,
  })
  const signal = new AbortController().signal
  try {
    const redelivered = event(1)
    if (state === 'expired') {
      await journal.export(batch('expired', [redelivered]), signal)
      await journal.acknowledgeEvents([redelivered.eventId])
      await journal.stage(event(2))
      await journal.cleanup()
    }
    const stale = journal.acknowledgeEvents([redelivered.eventId])
    const redelivery = journal.export(batch('redelivery', [redelivered]), signal)
    await Promise.all([stale, redelivery])
    const cursor = JSON.parse(await readFile(join(root, 'cursor.json'), 'utf8'))
    expect(cursor.acknowledgedEventIds).not.toContain(redelivered.eventId)
    expect((await journal.stats()).unacknowledgedEvents).toBe(state === 'expired' ? 2 : 1)
    await expect(journal.acknowledgeBatch('redelivery')).resolves.toBe(1)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('persists pruning of stale acknowledged IDs before permitting a restage after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-stale-cursor-test-'))
  const options = { rootDir: root, mode: 'audit' as const }
  const signal = new AbortController().signal
  const first = new JsonlObservationJournalExporter(options)
  let reopened: JsonlObservationJournalExporter | undefined
  let final: JsonlObservationJournalExporter | undefined
  try {
    const retained = event(1)
    await first.export(batch('stale', [retained]), signal)
    await first.acknowledgeEvents([retained.eventId])
    const segment = (await first.recover()).records[0]!.segment
    await first.shutdown(signal)
    await unlink(join(root, segment))
    const cursorPath = join(root, 'cursor.json')
    await writeFile(cursorPath, JSON.stringify({ schemaVersion: 1, acknowledgedEventIds: [retained.eventId] }))

    reopened = new JsonlObservationJournalExporter(options)
    await reopened.export(batch('restaged', [retained]), signal)
    expect(JSON.parse(await readFile(cursorPath, 'utf8')).acknowledgedEventIds).toEqual([])
    expect((await reopened.stats()).unacknowledgedEvents).toBe(1)
    await reopened.shutdown(signal)
    final = new JsonlObservationJournalExporter(options)
    await final.ready()
    expect((await final.stats()).unacknowledgedEvents).toBe(1)
    expect((await final.recover()).records.map(record => record.event)).toEqual([retained])
  } finally {
    await first.shutdown(signal)
    await reopened?.shutdown(signal)
    await final?.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['events', 'batch'] as const)(
  'preserves retained events when a batch is retried after acknowledgment by %s', async acknowledgment => {
    const root = await mkdtemp(join(tmpdir(), 'advanced-ack-retry-test-'))
    const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
    const signal = new AbortController().signal
    try {
      const first = event(1)
      const unrelated = event(2)
      const firstBatch = batch('ack-retry', [first])
      await journal.export(firstBatch, signal)
      await journal.stage(unrelated)
      if (acknowledgment === 'events') await journal.acknowledgeEvents([first.eventId])
      else await expect(journal.acknowledgeBatch(firstBatch.batchId)).resolves.toBe(1)

      await journal.export(firstBatch, signal)
      await journal.export(batch('different-batch', [first]), signal)
      const recovered = await journal.recover()
      expect(recovered.quarantinedSegments).toEqual([])
      expect(recovered.records.map(record => record.event.eventId)).toEqual([first.eventId, unrelated.eventId])
      expect((await journal.stats()).unacknowledgedEvents).toBe(1)
    } finally {
      await journal.shutdown(signal)
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('rejects changed retained payloads without preventing a subsequent valid retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-payload-retry-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'reliable' })
  const signal = new AbortController().signal
  try {
    const original = event(1)
    await journal.export(batch('original', [original]), signal)
    await journal.acknowledgeEvents([original.eventId])
    await expect(journal.export(batch('changed', [{ ...original, data: { content: 'changed' } }]), signal))
      .rejects.toThrow(/different data/)
    await journal.export(batch('retry', [original]), signal)
    expect((await journal.recover()).records.map(record => record.event)).toEqual([original])
    const hashes = Reflect.get(journal, 'retainedPayloadHashes') as Map<string, string>
    expect([...hashes.values()]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)])
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('deduplicates retained events during startup before ready has completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-restart-retry-test-'))
  const options = { rootDir: root, mode: 'audit' as const }
  const signal = new AbortController().signal
  const first = new JsonlObservationJournalExporter(options)
  let reopened: JsonlObservationJournalExporter | undefined
  try {
    const retained = event(1)
    const firstBatch = batch('restart', [retained])
    await first.export(firstBatch, signal)
    await first.acknowledgeEvents([retained.eventId])
    await first.shutdown(signal)
    reopened = new JsonlObservationJournalExporter(options)
    await expect(reopened.export(batch('changed', [{ ...retained, data: { content: 'changed' } }]), signal))
      .rejects.toThrow(/different data/)
    await reopened.export(firstBatch, signal)
    const recovered = await reopened.recover()
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.records.map(record => record.event)).toEqual([retained])
  } finally {
    await first.shutdown(signal)
    await reopened?.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('releases expired event identities before a queued restage writes the event again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-expired-retry-test-'))
  let segment = 0
  const journal = new JsonlObservationJournalExporter({
    rootDir: root, mode: 'operational', maxSegmentBytes: 1, acknowledgedRetentionMs: 1,
    now: () => new Date(Date.now() + 60_000), segmentId: () => `expiry${(++segment).toString().padStart(4, '0')}`,
  })
  const signal = new AbortController().signal
  try {
    const expired = event(1)
    await journal.export(batch('expired', [expired]), signal)
    await journal.acknowledgeEvents([expired.eventId])
    const retained = event(2)
    await journal.stage(retained)
    const restaged = { ...expired, data: { content: 'new payload after retention' } }
    await Promise.all([journal.cleanup(), journal.export(batch('restaged', [restaged]), signal)])
    const hashes = Reflect.get(journal, 'retainedPayloadHashes') as Map<string, string>
    expect(hashes.size).toBe(2)
    const recovered = await journal.recover()
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.records.map(record => record.event)).toEqual([retained, restaged])
    await journal.shutdown(signal)
    expect(hashes.size).toBe(2)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('reclaims a receipt when an earlier partial acknowledgment has already expired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-partial-expiry-test-'))
  let segment = 0
  const journal = new JsonlObservationJournalExporter({
    rootDir: root, mode: 'operational', maxSegmentBytes: 1, acknowledgedRetentionMs: 1,
    now: () => new Date(Date.now() + 60_000), segmentId: () => `partial${(++segment).toString().padStart(4, '0')}`,
  })
  const signal = new AbortController().signal
  try {
    const first = event(1)
    const second = event(2)
    const originalBatch = batch('partial-expiry', [first, second])
    await journal.export(originalBatch, signal)
    await journal.acknowledgeEvents([first.eventId])
    const batches = Reflect.get(journal, 'batchEvents') as Map<string, unknown>
    expect(batches.has('partial-expiry')).toBe(true)
    expect((await journal.recover()).records.map(record => record.event.eventId)).toEqual([second.eventId])
    await journal.export(originalBatch, signal)
    await expect(journal.export(batch('partial-expiry', [{ ...first, data: { content: 'changed' } }, second]), signal))
      .rejects.toThrow(/different events/)
    expect((await journal.recover()).records.map(record => record.event.eventId)).toEqual([second.eventId])
    await journal.acknowledgeEvents([second.eventId])
    expect(batches.size).toBe(0)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves unrelated batch receipts during post-shutdown acknowledgment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-post-close-ack-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    const first = event(1)
    const second = event(2)
    await journal.export(batch('first', [first]), signal)
    await journal.export(batch('second', [second]), signal)
    await journal.shutdown(signal)
    await journal.acknowledgeEvents([first.eventId])
    await expect(journal.acknowledgeBatch('second')).resolves.toBe(1)
    await expect(journal.acknowledgeBatch('second')).resolves.toBe(0)
    expect((await journal.stats()).unacknowledgedEvents).toBe(0)
    expect((await journal.recover()).records.map(record => record.event.eventId))
      .toEqual([first.eventId, second.eventId])
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('reclaims runtime batch receipts only after every payload in the batch expires', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-batch-retention-test-'))
  const signal = new AbortController().signal
  const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({
    rootDir: root, mode: 'operational', maxSegmentBytes: 1, acknowledgedRetentionMs: 1,
    now: () => new Date(Date.now() + 60_000),
  }))
  try {
    await journal.ready(signal)
    const first = { id: 'first', resource: event(0).resource, events: [event(1), event(2)], runRecords: [] }
    await journal.export(first, signal)
    const batches = Reflect.get(journal, 'batches') as Map<string, readonly string[]>
    expect(batches.has('first')).toBe(true)
    await journal.export(first, signal)
    await expect(journal.export({ ...first, events: [event(3)] }, signal)).rejects.toThrow(/different items/)
    await journal.export({ ...first, id: 'second', events: [event(4)] }, signal)
    expect(batches.has('first')).toBe(false)
    expect(batches.has('second')).toBe(true)
    await journal.shutdown(signal)
    for (const name of ['payloads', 'pending', 'batches', 'accepted']) {
      expect(Reflect.get(journal, name).size).toBe(0)
    }
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps advanced batch receipts until all of their event acknowledgments commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-batch-retention-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'operational' })
  const signal = new AbortController().signal
  try {
    await journal.ready()
    const events = [event(1), event(2)]
    const batch = { schemaVersion: 1 as const, batchId: 'receipt', createdAt: new Date().toISOString(), events }
    await journal.export(batch, signal)
    const batches = Reflect.get(journal, 'batchEvents') as Map<string, unknown>
    await journal.acknowledgeEvents([events[0]!.eventId])
    expect(batches.has(batch.batchId)).toBe(true)
    await journal.export(batch, signal)
    await expect(journal.export({ ...batch, events: [event(3)] }, signal)).rejects.toThrow(/different events/)
    await journal.acknowledgeEvents([events[1]!.eventId])
    expect(batches.has(batch.batchId)).toBe(false)
    await journal.stage(event(4))
    await journal.shutdown(signal)
    expect(Reflect.get(journal, 'pendingStages').size).toBe(0)
    expect((await journal.recover()).records).toHaveLength(3)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})
