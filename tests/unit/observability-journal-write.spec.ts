import { mkdtemp, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JsonlObservationJournalExporter } from '../../packages/observability-node/src/journal.ts'
import { batch, event } from './observability-journal-fixtures.ts'

it('rolls a partial append back before queued writes and a retry append complete frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-partial-write-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    const before = event(1)
    const retried = event(2)
    const after = event(3)
    await journal.export(batch('before', [before]), signal)
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    const write = handle.writeFile.bind(handle)
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
      await write(String(data).slice(0, 24), 'utf8')
      throw new Error('partial append failure')
    })
    const failed = journal.export(batch('retried', [retried]), signal)
    const queued = journal.export(batch('after', [after]), signal)
    await expect(failed).rejects.toThrow('partial append failure')
    await queued
    await journal.export(batch('retried', [retried]), signal)
    const recovered = await journal.recover()
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.truncatedSegments).toEqual([])
    expect(recovered.records.map(record => record.event)).toEqual([before, after, retried])
  } finally {
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it('blocks queued and future writes when a failed append cannot be rolled back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-failed-rollback-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    await journal.export(batch('before', [event(1)]), signal)
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    const write = handle.writeFile.bind(handle)
    const writes = vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
      await write(String(data).slice(0, 24), 'utf8')
      throw new Error('partial append failure')
    })
    vi.spyOn(handle, 'truncate').mockRejectedValueOnce(new Error('rollback failed'))
    const failed = journal.export(batch('failed', [event(2)]), signal)
    const queued = journal.export(batch('queued', [event(3)]), signal)
    const outcomes = await Promise.allSettled([failed, queued])
    expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true)
    await expect(journal.export(batch('future', [event(4)]), signal)).rejects.toThrow(/rollback failed/)
    expect(writes).toHaveBeenCalledTimes(1)
  } finally {
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it('retries a capacity-rejected payload after acknowledgment frees retained space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-capacity-retry-test-'))
  let segment = 0
  const journal = new JsonlObservationJournalExporter({
    rootDir: root, mode: 'operational', maxSegmentBytes: 1, maxRetainedBytes: 3_000, acknowledgedRetentionMs: 1,
    now: () => new Date(Date.now() + 60_000), segmentId: () => `capacityretry${++segment}`,
  })
  const signal = new AbortController().signal
  try {
    const first = { ...event(1), data: { content: 'a'.repeat(500) } }
    const marker = event(2)
    const rejected = { ...event(3), data: { content: 'b'.repeat(1_000) } }
    await journal.export(batch('first', [first]), signal)
    await journal.stage(marker)
    const retried = batch('retried', [rejected])
    await expect(journal.export(retried, signal)).rejects.toThrow(/capacity/)
    await journal.acknowledgeEvents([first.eventId])
    await expect(journal.export(retried, signal)).resolves.toMatchObject({ accepted: true })
    expect((await journal.recover()).records.map(record => record.event)).toEqual([marker, rejected])
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['audit', 'reliable'] as const)('retries a %s sync failure without appending a duplicate', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-sync-retry-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode })
  const signal = new AbortController().signal
  try {
    await journal.ready()
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    const sync = vi.spyOn(handle, 'datasync').mockRejectedValueOnce(new Error('transient sync failure'))
    const original = event(1)
    const retried = batch('retry-sync', [original])
    await expect(journal.export(retried, signal)).rejects.toThrow('transient sync failure')
    expect(sync).toHaveBeenCalledTimes(1)
    await expect(journal.export(retried, signal)).resolves.toMatchObject({ accepted: true })
    expect(sync).toHaveBeenCalledTimes(2)
    expect((await journal.recover()).records.map(record => record.event)).toEqual([original])
  } finally {
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
