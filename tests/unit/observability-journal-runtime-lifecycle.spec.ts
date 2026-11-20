import { mkdtemp, readFile, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createCoreSpan, createOperationId, type ObservationEvent, type RunTerminalRecord,
} from '@alvin0/ai-agent-sdk-core'
import {
  jsonlObservationExporter, recoverRuntimeObservationJournal,
} from '../../packages/observability-node/src/journal/runtime-exporter.ts'
import { RuntimeJsonlJournal } from '../../packages/observability-node/src/journal/runtime-store.ts'
import { captureRuntimeJournalOptions } from '../../packages/observability-node/src/journal/runtime-options.ts'
import { captureRuntimeJournalItem } from '../../packages/observability-node/src/journal/runtime-frame.ts'

const signal = new AbortController().signal

function event(sequence: number): ObservationEvent {
  return { schemaVersion: 1, eventId: createOperationId(), sequence, name: 'sdk.model.call',
    phase: 'point', occurredAt: new Date().toISOString(), monotonicMs: 0, priority: 'normal',
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: 'test', runtime: 'node' },
    correlation: createCoreSpan({ name: 'sdk.model.call', runId: 'runtime-journal',
      startedAt: new Date().toISOString(), monotonicMs: 0 }).correlation, data: {} }
}

function batch(id: string, events: readonly ObservationEvent[]) {
  return { id, resource: event(1).resource, events, runRecords: [] }
}

it('rejects a batch retry with the same event identity and different payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-payload-retry-'))
  const exporter = jsonlObservationExporter({ rootDir: root, mode: 'audit' })
  try {
    await exporter.ready?.(signal)
    const original = event(1)
    await exporter.export(batch('same', [original]), signal)
    await expect(exporter.export(batch('same', [{ ...original, data: { changed: true } }]), signal))
      .rejects.toThrow(/different (items|data)/)
    await expect(exporter.export(batch('same', [original]), signal)).resolves.toMatchObject({ batchId: 'same' })
  } finally {
    await exporter.shutdown?.(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('reserves a batch identity before concurrent conflicting exports can be accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-concurrent-batch-'))
  const exporter = jsonlObservationExporter({ rootDir: root, mode: 'audit' })
  try {
    await exporter.ready?.(signal)
    const original = event(1)
    const outcomes = await Promise.allSettled([
      exporter.export(batch('same', [original]), signal),
      exporter.export(batch('same', [event(2)]), signal),
    ])
    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    expect((await recoverRuntimeObservationJournal(root)).records.map(record => record.item)).toEqual([original])
  } finally {
    await exporter.shutdown?.(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('captures stage identities and batch acknowledgments before caller mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-mutable-input-'))
  const exporter = jsonlObservationExporter({ rootDir: root, mode: 'audit' })
  try {
    await exporter.ready?.(signal)
    const direct = { ...event(1), data: { text: 'original staged data' } }
    const originalDirect = structuredClone(direct)
    const staged = exporter.stage?.(direct)
    direct.eventId = createOperationId()
    direct.data.text = 'mutated staged data'
    await staged

    const delivered = { ...event(2), data: { text: 'original batch data' } }
    const originalDelivered = structuredClone(delivered)
    const events: ObservationEvent[] = [delivered]
    const input = batch('original-batch', events)
    const exported = exporter.export(input, signal)
    input.id = 'changed-batch'
    events.splice(0, 1, event(3))
    delivered.eventId = createOperationId()
    delivered.data.text = 'mutated batch data'
    await expect(exported).resolves.toEqual({ batchId: 'original-batch',
      acceptedEventIds: [originalDelivered.eventId], acceptedRunIds: [] })
    const recovered = await recoverRuntimeObservationJournal(root)
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.records.map(record => record.item)).toEqual([originalDirect, originalDelivered])
  } finally {
    await exporter.shutdown?.(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('waits for admitted exports on every shutdown call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-shutdown-export-'))
  const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'operational' }))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  try {
    await journal.ready(signal)
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    const sync = handle.datasync.bind(handle)
    vi.spyOn(handle, 'datasync').mockImplementationOnce(async () => { await blocked; await sync() })
    const original = event(1)
    const exported = journal.export(batch('active', [original]), signal)
    const closed = journal.shutdown(signal)
    let repeatedSettled = false
    const repeated = journal.shutdown(signal).then(() => { repeatedSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(repeatedSettled).toBe(false)
    release()
    await expect(exported).resolves.toMatchObject({ batchId: 'active' })
    await Promise.all([closed, repeated])
    expect((await recoverRuntimeObservationJournal(root)).records.map(record => record.item)).toEqual([original])
  } finally {
    release()
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])('reclaims expired accepted capacity before writing (retry %s)', async retry => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-capacity-retry-'))
  let now = Date.now()
  const first = { ...event(1), data: { text: 'a'.repeat(500) } }
  const second = { ...event(2), data: { text: 'b'.repeat(1_000) } }
  const maxRetainedBytes = Buffer.byteLength(captureRuntimeJournalItem(second).line) + 100
  const exporter = jsonlObservationExporter({ rootDir: root, mode: 'operational', maxSegmentBytes: 1,
    maxRetainedBytes, acknowledgedRetentionMs: 1_000, now: () => new Date(now) })
  try {
    await exporter.ready?.(signal)
    await exporter.export(batch('first', [first]), signal)
    if (retry) await expect(exporter.export(batch('second', [second]), signal)).rejects.toThrow(/capacity/)
    now += 60_000
    await expect(exporter.export(batch('second', [second]), signal)).resolves.toMatchObject({ batchId: 'second' })
    expect((await recoverRuntimeObservationJournal(root)).records.map(record => record.item)).toEqual([second])
  } finally {
    await exporter.shutdown?.(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the runtime journal closed to writes after an append failure and preserves earlier frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-failed-append-'))
  const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'audit' }))
  try {
    await journal.ready(signal)
    const original = event(1)
    await journal.export(batch('before', [original]), signal)
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    const write = handle.writeFile.bind(handle)
    const writes = vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
      await write(String(data).slice(0, 24), 'utf8')
      throw new Error('partial runtime append failure')
    })
    const outcomes = await Promise.allSettled([
      journal.export(batch('failed', [event(2)]), signal),
      journal.export(batch('queued', [event(3)]), signal),
    ])
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
    await expect(journal.export(batch('future', [event(4)]), signal)).rejects.toThrow(/failed/)
    expect(writes).toHaveBeenCalledTimes(1)
    const recovered = await recoverRuntimeObservationJournal(root)
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.truncatedSegments).toEqual([])
    expect(recovered.records.map(record => record.item)).toEqual([original])
  } finally {
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([0, 1])('keeps an identical active export durable when waiter %s aborts', async abortedIndex => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-caller-abort-'))
  const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'operational' }))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  try {
    await journal.ready(signal)
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    const write = handle.writeFile.bind(handle)
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => { await blocked; await write(data, 'utf8') })
    const original = event(1)
    const input = batch('shared', [original])
    const callers = [new AbortController(), new AbortController()]
    const exported = callers.map(caller => journal.export(input, caller.signal))
    const cancelled = expect(exported[abortedIndex]).rejects.toThrow('caller cancelled')
    callers[abortedIndex]!.abort(new Error('caller cancelled'))
    await cancelled
    release()
    await expect(exported[1 - abortedIndex]).resolves.toMatchObject({ batchId: 'shared',
      acceptedEventIds: [original.eventId] })
    const cursor = JSON.parse(await readFile(join(root, 'runtime-delivery', 'cursor.json'), 'utf8'))
    expect(cursor.acceptedItemKeys).toEqual([`event:${original.eventId}`])
    expect((await recoverRuntimeObservationJournal(root)).records.map(record => record.item)).toEqual([original])
  } finally {
    release()
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it('allows a lone cancelled export to retry its staged payload without premature acknowledgment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-lone-abort-'))
  const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'operational' }))
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  try {
    await journal.ready(signal)
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    const write = handle.writeFile.bind(handle)
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => { await blocked; await write(data, 'utf8') })
    const original = event(1)
    const input = batch('retried', [original])
    const caller = new AbortController()
    const exported = journal.export(input, caller.signal)
    caller.abort(new Error('caller cancelled'))
    await expect(exported).rejects.toThrow('caller cancelled')
    await expect(journal.export(batch('retried', [{ ...original, data: { changed: true } }]), signal))
      .rejects.toThrow(/different items/)
    const retried = journal.export(input, signal)
    await expect(readFile(join(root, 'runtime-delivery', 'cursor.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    release()
    await expect(retried).resolves.toMatchObject({ acceptedEventIds: [original.eventId] })
    expect((await recoverRuntimeObservationJournal(root)).records.map(record => record.item)).toEqual([original])
  } finally {
    release()
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a terminal record with a non-string run identity before appending it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-terminal-identity-'))
  const exporter = jsonlObservationExporter({ rootDir: root, mode: 'audit' })
  try {
    await exporter.ready?.(signal)
    const valid = event(1)
    await exporter.export(batch('valid', [valid]), signal)
    const malformed = { kind: 'run-terminal-record', runId: ['bad-id'], traceId: valid.correlation.traceId,
      status: 'success', startedAt: valid.occurredAt, endedAt: valid.occurredAt, durationMs: 0,
      usage: {}, modelCalls: [], toolSourceSnapshots: [], operationCounts: {}, errors: [],
    } as unknown as RunTerminalRecord
    expect(() => exporter.stage?.(malformed)).toThrow(/invalid runtime journal item/)
    await expect(exporter.export({ ...batch('invalid', []), runRecords: [malformed] }, signal))
      .rejects.toThrow(/invalid runtime journal item/)
    const recovered = await recoverRuntimeObservationJournal(root)
    expect(recovered.quarantinedSegments).toEqual([])
    expect(recovered.records.map(record => record.item)).toEqual([valid])
  } finally {
    await exporter.shutdown?.(signal)
    await rm(root, { recursive: true, force: true })
  }
})
