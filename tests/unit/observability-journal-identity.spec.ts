import { mkdtemp, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JsonlObservationJournalExporter } from '../../packages/observability-node/src/journal.ts'
import { batch, event, holdJournalSync } from './observability-journal-fixtures.ts'

import { createOperationId, type ObservationEvent } from '@alvin0/ai-agent-sdk-core'

it('rejects a non-string runtime identity without corrupting a valid neighboring record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-malformed-identity-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    const valid = event(1)
    await journal.export(batch('valid', [valid]), signal)
    const malformed = { ...event(2), eventId: [createOperationId()] } as unknown as ObservationEvent
    expect(() => journal.stage(malformed)).toThrow(/invalid journal event/)
    await expect(journal.export(batch('invalid', [malformed]), signal)).rejects.toThrow(/invalid journal event/)
    const recovered = await journal.recover()
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.records.map(record => record.event)).toEqual([valid])
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('captures event and acknowledgment identities before caller mutations can affect queued writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-mutable-input-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    const direct = { ...event(1), data: { content: 'direct original' } }
    const originalDirect = structuredClone(direct)
    const staged = journal.stage(direct)
    direct.eventId = createOperationId()
    direct.priority = 'critical'
    direct.data.content = 'direct changed'
    await staged
    const acknowledgedIds = [originalDirect.eventId]
    const acknowledged = journal.acknowledgeEvents(acknowledgedIds)
    acknowledgedIds.splice(0, 1, createOperationId())
    await acknowledged
    const recovered = await journal.recover()
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.records.map(record => record.event)).toEqual([originalDirect])
    expect((await journal.stats()).unacknowledgedEvents).toBe(0)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('captures batch identities and contents before caller mutations can affect queued writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-mutable-batch-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    const exported = { ...event(2), data: { content: 'batch original' } }
    const originalExported = structuredClone(exported)
    const events = [exported]
    const input = batch('original-batch', events)
    const pending = journal.export(input, signal)
    input.batchId = 'mutated-batch'
    events.splice(0, 1, { ...event(3), data: { content: 'replacement' } })
    exported.eventId = createOperationId()
    exported.data.content = 'batch changed'

    await expect(pending).resolves.toMatchObject({ batchId: 'original-batch', accepted: true })
    await expect(journal.acknowledgeBatch('original-batch')).resolves.toBe(1)
    await expect(journal.acknowledgeBatch('mutated-batch')).resolves.toBe(0)
    const recovered = await journal.recover()
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.records.map(record => record.event)).toEqual([originalExported])
    expect((await journal.stats()).unacknowledgedEvents).toBe(0)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('validates payloads for sequential and concurrent retries of the same active batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-concurrent-batch-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const signal = new AbortController().signal
  try {
    const original = event(1)
    const originalBatch = batch('concurrent', [original])
    const first = journal.export(originalBatch, signal)
    const identical = journal.export(originalBatch, signal)
    await expect(journal.export(batch('concurrent', [event(2)]), signal)).rejects.toThrow(/different events/)
    await expect(journal.export(batch('concurrent', [{ ...original, data: { content: 'changed' } }]), signal))
      .rejects.toThrow(/different events/)
    await Promise.all([first, identical])
    await expect(journal.export(batch('concurrent', [{ ...original, data: { content: 'changed' } }]), signal))
      .rejects.toThrow(/different events/)
    expect((await journal.recover()).records.map(record => record.event)).toEqual([original])
    await journal.shutdown(signal)
    await expect(journal.export(originalBatch, signal)).rejects.toThrow(/closed/)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it.each([0, 1])('isolates caller %s cancellation while identical exports share durable writes', async canceled => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-export-cancellation-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const controllers = [new AbortController(), new AbortController()]
  let heldSync: ReturnType<typeof holdJournalSync> | undefined
  try {
    await journal.ready()
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    heldSync = holdJournalSync(handle)
    const original = event(1)
    const originalBatch = batch('shared', [original])
    const pending = controllers.map(controller => journal.export(originalBatch, controller.signal))
    const outcomes = Promise.allSettled(pending)
    let otherSettled = false
    void pending[1 - canceled]!.then(() => { otherSettled = true }, () => { otherSettled = true })
    await heldSync.started
    controllers[canceled]!.abort(new Error('caller stopped'))
    await expect(pending[canceled]).rejects.toThrow('caller stopped')
    expect(otherSettled).toBe(false)
    heldSync.release()
    const results = await outcomes
    expect(results[canceled]!.status).toBe('rejected')
    expect(results[1 - canceled]!.status).toBe('fulfilled')
    await expect(journal.export(originalBatch, new AbortController().signal)).resolves.toMatchObject({ accepted: true })
    expect((await journal.recover()).records.map(record => record.event)).toEqual([original])
  } finally {
    heldSync?.release()
    await journal.shutdown(new AbortController().signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a pre-aborted export before staging its records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'advanced-pre-aborted-export-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'audit' })
  const preAborted = new AbortController()
  preAborted.abort(new Error('already stopped'))
  try {
    await expect(journal.export(batch('pre-aborted', [event(1)]), preAborted.signal)).rejects.toThrow('already stopped')
    expect((await journal.recover()).records).toEqual([])
  } finally {
    await journal.shutdown(new AbortController().signal)
    await rm(root, { recursive: true, force: true })
  }
})
