import { mkdtemp, rm, open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCoreSpan, createOperationId, type ObservationEvent } from '@alvin0/ai-agent-sdk-core'
import { JsonlObservationJournalExporter } from '../../packages/observability-node/src/journal.ts'
import { RuntimeJsonlJournal } from '../../packages/observability-node/src/journal/runtime-store.ts'
import { captureRuntimeJournalOptions } from '../../packages/observability-node/src/journal/runtime-options.ts'
import { createDiagnosticWireLogger } from '../../packages/observability-node/src/diagnostic/wire-logger.ts'
import { holdJournalSync } from './observability-journal-fixtures.ts'

function event(): ObservationEvent {
  return { schemaVersion: 1, eventId: createOperationId(), sequence: 1, name: 'sdk.model.call',
    phase: 'point', occurredAt: new Date().toISOString(), monotonicMs: 0, priority: 'normal',
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: 'test', runtime: 'node' },
    correlation: createCoreSpan({ name: 'sdk.model.call', runId: 'shutdown',
      startedAt: new Date().toISOString(), monotonicMs: 0 }).correlation, data: {} }
}

it.each(['success', 'failure'] as const)('shares %s finalization across simultaneous shutdowns', async outcome => {
  const root = await mkdtemp(join(tmpdir(), 'journal-shared-shutdown-test-'))
  const journal = new JsonlObservationJournalExporter({ rootDir: root, mode: 'operational' })
  const signal = new AbortController().signal
  let heldSync: ReturnType<typeof holdJournalSync> | undefined
  const failure = new Error('shared final sync failure')
  try {
    await journal.stage(event())
    const handle = Reflect.get(journal, 'current').handle as FileHandle
    heldSync = holdJournalSync(handle, outcome === 'failure' ? failure : undefined)
    const close = vi.spyOn(handle, 'close')
    const first = journal.shutdown(signal)
    const second = journal.shutdown(signal)
    expect(second).toBe(first)
    const results = Promise.allSettled([first, second])
    let settled = false
    void results.then(() => { settled = true })
    await heldSync.started
    expect(settled).toBe(false)
    expect(close).not.toHaveBeenCalled()
    heldSync.release()
    const settledResults = await results
    expect(settledResults.map(result => result.status)).toEqual(
      outcome === 'failure' ? ['rejected', 'rejected'] : ['fulfilled', 'fulfilled'],
    )
    expect(settledResults.every(result => result.status !== 'rejected' || result.reason === failure)).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
    expect(journal.shutdown(signal)).toBe(first)
  } finally {
    heldSync?.release()
    await journal.shutdown(signal).catch(() => undefined)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['advanced', 'runtime'] as const)('closes the %s journal handle when its final sync fails', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'journal-shutdown-test-'))
  let handle: FileHandle | undefined
  try {
    const options = { rootDir: root, mode: 'operational' as const }
    const journal = kind === 'advanced' ? new JsonlObservationJournalExporter(options)
      : new RuntimeJsonlJournal(captureRuntimeJournalOptions(options))
    if (journal instanceof RuntimeJsonlJournal) await journal.ready(new AbortController().signal)
    else await journal.ready()
    await journal.stage(event())
    handle = Reflect.get(journal, 'current').handle as FileHandle
    vi.spyOn(handle, 'datasync').mockRejectedValue(new Error('synthetic sync failure'))

    await expect(journal.shutdown(new AbortController().signal)).rejects.toThrow('synthetic sync failure')
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally {
    vi.restoreAllMocks()
    await handle?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('releases a runtime journal handle when shutdown starts with an aborted signal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-aborted-shutdown-test-'))
  let handle: FileHandle | undefined
  try {
    const journal = new RuntimeJsonlJournal(captureRuntimeJournalOptions({ rootDir: root, mode: 'operational' }))
    await journal.ready(new AbortController().signal)
    handle = Reflect.get(journal, 'current').handle as FileHandle
    const controller = new AbortController()
    controller.abort(new Error('host stopped'))

    await expect(journal.shutdown(controller.signal)).rejects.toThrow('host stopped')
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('closes every wire log when one final sync fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-shutdown-test-'))
  const probe = await open(join(root, 'prototype-probe'), 'w')
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  const handles: FileHandle[] = []
  const writeFile = prototype.writeFile
  vi.spyOn(prototype, 'writeFile').mockImplementation(async function (this: FileHandle, ...args) {
    handles.push(this)
    return await writeFile.apply(this, args)
  })
  try {
    const logger = createDiagnosticWireLogger({ rootDir: join(root, 'wire'),
      content: 'full', allowWireBodies: true })
    for (const provider of ['one', 'two']) await logger({ schemaVersion: 1, type: 'request', provider,
      timestamp: new Date().toISOString() })
    vi.spyOn(prototype, 'datasync').mockRejectedValue(new Error('synthetic sync failure'))

    await expect(logger.shutdown()).rejects.toThrow('synthetic sync failure')
    expect(handles).toHaveLength(2)
    for (const handle of handles) await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
  } finally {
    vi.restoreAllMocks()
    for (const handle of handles) await handle.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
