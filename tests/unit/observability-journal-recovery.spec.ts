import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JsonlObservationJournalExporter } from '../../packages/observability-node/src/journal.ts'
import {
  RuntimeJsonlJournal, recoverRuntimeJournal,
} from '../../packages/observability-node/src/journal/runtime-store.ts'
import { captureRuntimeJournalOptions } from '../../packages/observability-node/src/journal/runtime-options.ts'
import { event } from './observability-journal-fixtures.ts'

it('checks only the completed receipt when no retained payload has expired', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-receipt-reclamation-'))
  const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'reliable' }))
  const signal = new AbortController().signal
  try {
    await journal.ready(signal)
    const retained = event(1)
    const batch = { id: 'seed', resource: retained.resource, events: [retained], runRecords: [] }
    for (let index = 0; index < 32; index++) await journal.export({ ...batch, id: `seed-${index}` }, signal)
    const payloads = Reflect.get(journal, 'payloads') as Map<string, string>
    const has = vi.spyOn(payloads, 'has')
    await journal.export({ ...batch, id: 'measured' }, signal)
    expect(has).toHaveBeenCalledTimes(1)
    await expect(journal.export({ ...batch, id: 'seed-0' }, signal)).resolves.toMatchObject({ batchId: 'seed-0' })
    expect(has).toHaveBeenCalledTimes(1)
  } finally {
    await journal.shutdown(signal)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['advanced', 'runtime'] as const)('publishes deeply frozen %s recovery records', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'journal-frozen-recovery-'))
  const signal = new AbortController().signal
  const journal = kind === 'runtime'
    ? new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'reliable' }))
    : new JsonlObservationJournalExporter({ rootDir: root, mode: 'reliable' })
  try {
    await journal.ready(signal)
    const input = { ...event(1), data: { content: { nested: ['retained'] } } }
    await journal.stage(input)
    await journal.shutdown(signal)
    const recovered = kind === 'runtime' ? await recoverRuntimeJournal(join(root, 'runtime-delivery'))
      : await (journal as JsonlObservationJournalExporter).recover()
    expect(Object.isFrozen(recovered)).toBe(true)
    expect(Object.isFrozen(recovered.records)).toBe(true)
    const record = recovered.records[0]!
    const item = 'item' in record ? record.item : record.event
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(item)).toBe(true)
    expect('data' in item && Object.isFrozen(item.data.content)).toBe(true)
    expect(item).toEqual(input)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})

it('checks retained frame corruption before acknowledging the next runtime delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-retention-integrity-'))
  const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'reliable' }))
  const signal = new AbortController().signal
  try {
    await journal.ready(signal)
    const first = event(1)
    await journal.export({ id: 'first', resource: first.resource, events: [first], runRecords: [] }, signal)
    const name = Reflect.get(journal, 'current').name as string
    const path = join(root, 'runtime-delivery', name)
    const frame = JSON.parse((await readFile(path, 'utf8')).trim())
    await writeFile(path, `${JSON.stringify({ ...frame, sha256: '0'.repeat(64) })}\n`)
    const second = event(2)
    await expect(journal.export({ id: 'second', resource: second.resource, events: [second], runRecords: [] }, signal))
      .rejects.toThrow(/mid-file corruption/)
  } finally {
    await journal.shutdown(signal)
    await rm(root, { recursive: true, force: true })
  }
})
