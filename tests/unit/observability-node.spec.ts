import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  appendFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCoreSpan,
  createObservationRunScope,
  createOperationId,
  type ObservationEvent,
  type ObservationPriority,
} from '@ai-agent-sdk/core'
import { createObservability, type ObservationBatch } from '@ai-agent-sdk/core/observability'
import {
  JsonlObservationJournalExporter,
  createDiagnosticWireLogger,
  installNodeObservabilityLifecycle,
  recoverJournal,
} from '@ai-agent-sdk/observability-node'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = resolve(root)
    if (!absolute.startsWith(resolve(tmpdir()))) throw new Error(`refusing to remove ${absolute}`)
    await rm(absolute, { recursive: true, force: true })
  }
})

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ai-agent-sdk-journal-${label}-`))
  roots.push(root)
  return root
}

function event(
  sequence: number,
  priority: ObservationPriority = 'critical',
  runId = 'journal-run',
): ObservationEvent {
  const scope = createObservationRunScope()
  return {
    schemaVersion: 1,
    eventId: createOperationId(),
    sequence,
    name: 'sdk.model.call',
    phase: 'end',
    occurredAt: new Date().toISOString(),
    monotonicMs: scope.monotonicMs(),
    priority,
    resource: { sdkName: 'ai-agent-sdk', sdkVersion: '0.1.0', runtime: 'node' },
    correlation: createCoreSpan({
      name: 'sdk.model.call', runId, startedAt: new Date().toISOString(), monotonicMs: 0,
    }).correlation,
    data: { status: 'success', sequence },
  }
}

function batch(batchId: string, events: readonly ObservationEvent[]): ObservationBatch {
  return { schemaVersion: 1, batchId, createdAt: new Date().toISOString(), events }
}

function permission(mode: number): number {
  return mode & 0o777
}

async function segmentNames(root: string): Promise<string[]> {
  return (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
}

describe('Node observation journal', () => {
  it('writes exact checksum frames with private permissions and proves reliable local durability', async () => {
    const root = await temporaryRoot('frame')
    const journal = new JsonlObservationJournalExporter({
      rootDir: root, mode: 'reliable', segmentId: () => 'frame0001',
    })
    await journal.ready()
    const observation = createObservability({
      mode: 'reliable',
      exporters: [{ exporter: journal, requirement: 'required', boundary: 'local-durable' }],
    })
    const terminal = event(1)
    await expect(observation.checkpoint(terminal)).resolves.toMatchObject({
      durable: true, boundary: 'local-durable',
    })

    const [name] = await segmentNames(root)
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}-\d+-frame0001\.jsonl$/)
    const raw = await readFile(join(root, name!), 'utf8')
    const frame = JSON.parse(raw.trim()) as Record<string, unknown>
    expect(frame).toMatchObject({ schemaVersion: 1, eventId: terminal.eventId })
    expect(frame.payloadJson).toBe(JSON.stringify(terminal))
    expect(frame.sha256).toBe(createHash('sha256').update(String(frame.payloadJson)).digest('hex'))
    expect((await journal.recover()).records.map(record => record.event.eventId)).toEqual([terminal.eventId])
    if (process.platform !== 'win32') {
      expect(permission((await stat(root)).mode)).toBe(0o700)
      expect(permission((await stat(join(root, name!))).mode)).toBe(0o600)
    }
    await observation.shutdown()
  })

  it('uses unique segments and rotates by UTC day or byte bound', async () => {
    const root = await temporaryRoot('rotate')
    let now = new Date('2026-09-01T23:59:59.000Z')
    let id = 0
    const journal = new JsonlObservationJournalExporter({
      rootDir: root,
      mode: 'audit',
      maxSegmentBytes: 1,
      now: () => now,
      segmentId: () => `rotate${(++id).toString().padStart(4, '0')}`,
    })
    await journal.stage(event(1))
    now = new Date('2026-09-02T00:00:01.000Z')
    await journal.stage(event(2))
    expect(await segmentNames(root)).toHaveLength(2)
    expect((await journal.recover()).records).toHaveLength(2)
    await journal.shutdown(new AbortController().signal)

    const second = new JsonlObservationJournalExporter({
      rootDir: root, mode: 'operational', segmentId: () => 'separate01',
    })
    await second.ready()
    expect(await segmentNames(root)).toHaveLength(3)
    await second.shutdown(new AbortController().signal)
  })

  it('truncates only a partial final line and preserves every earlier valid record', async () => {
    const root = await temporaryRoot('tail')
    const journal = new JsonlObservationJournalExporter({
      rootDir: root, mode: 'operational', segmentId: () => 'partial001',
    })
    const first = event(1)
    await journal.stage(first)
    await journal.shutdown(new AbortController().signal)
    const [name] = await segmentNames(root)
    await appendFile(join(root, name!), '{"schemaVersion":1,"eventId":"partial')

    const recovered = await recoverJournal(root)
    expect(recovered.truncatedSegments).toEqual([name])
    expect(recovered.records.map(record => record.event.eventId)).toEqual([first.eventId])
    expect((await readFile(join(root, name!), 'utf8')).endsWith('\n')).toBe(true)
  })

  it('quarantines a corrupt final complete line but rejects mid-file corruption', async () => {
    const finalRoot = await temporaryRoot('final-corrupt')
    const finalJournal = new JsonlObservationJournalExporter({
      rootDir: finalRoot, mode: 'operational', segmentId: () => 'corrupt001',
    })
    await finalJournal.stage(event(1))
    await finalJournal.shutdown(new AbortController().signal)
    const [finalName] = await segmentNames(finalRoot)
    await appendFile(join(finalRoot, finalName!), '{}\n')
    const finalRecovery = await recoverJournal(finalRoot)
    expect(finalRecovery.records).toHaveLength(0)
    expect(finalRecovery.quarantinedSegments[0]).toContain(`${finalName}.corrupt-`)
    expect(await segmentNames(finalRoot)).toEqual([])

    const middleRoot = await temporaryRoot('middle-corrupt')
    const middleJournal = new JsonlObservationJournalExporter({
      rootDir: middleRoot, mode: 'operational', segmentId: () => 'middle0001',
    })
    await middleJournal.stage(event(1, 'critical', 'middle-run'))
    await middleJournal.stage(event(2, 'critical', 'middle-run'))
    await middleJournal.shutdown(new AbortController().signal)
    const [middleName] = await segmentNames(middleRoot)
    const validLines = (await readFile(join(middleRoot, middleName!), 'utf8')).trimEnd().split('\n')
    await writeFile(join(middleRoot, middleName!), `${validLines[0]}\n{}\n${validLines[1]}\n`)
    await expect(recoverJournal(middleRoot)).rejects.toMatchObject({ code: 'OBSERVABILITY_JOURNAL_CORRUPT' })
  })

  it('rejects a symlink journal root rather than following it', async () => {
    const parent = await temporaryRoot('symlink')
    const target = await temporaryRoot('symlink-target')
    const link = join(parent, 'journal-link')
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const journal = new JsonlObservationJournalExporter({
      rootDir: link, mode: 'reliable', segmentId: () => 'symlink001',
    })
    await expect(journal.ready()).rejects.toMatchObject({ code: 'OBSERVABILITY_JOURNAL_IO' })
    expect(await readdir(target)).toEqual([])
  })

  it('persists an atomic cursor, deletes only rotated acknowledged segments, and preserves unacknowledged data', async () => {
    const root = await temporaryRoot('cursor')
    let now = new Date('2030-01-01T00:00:00.000Z')
    let id = 0
    const journal = new JsonlObservationJournalExporter({
      rootDir: root,
      mode: 'reliable',
      acknowledgedRetentionMs: 1,
      now: () => now,
      segmentId: () => `cursor${(++id).toString().padStart(4, '0')}`,
    })
    const acknowledged = event(1, 'critical', 'cursor-run')
    await journal.export(batch('batch-ack', [acknowledged]), new AbortController().signal)
    now = new Date('2030-01-02T00:00:00.000Z')
    const retained = event(2, 'critical', 'cursor-run')
    await journal.stage(retained)
    expect(await segmentNames(root)).toHaveLength(2)
    await expect(journal.acknowledgeBatch('batch-ack')).resolves.toBe(1)
    expect(await segmentNames(root)).toHaveLength(1)
    const cursor = JSON.parse(await readFile(join(root, 'cursor.json'), 'utf8')) as Record<string, unknown>
    expect(cursor).toMatchObject({ schemaVersion: 1 })
    expect(cursor.acknowledgedEventIds).toEqual([])
    if (process.platform !== 'win32') expect(permission((await stat(join(root, 'cursor.json'))).mode)).toBe(0o600)
    expect((await readdir(root)).some(name => name.includes('.tmp-'))).toBe(false)
    expect((await journal.recover()).records.map(record => record.event.eventId)).toEqual([retained.eventId])
    await expect(journal.acknowledgeEvents(['not-an-event-id'])).rejects.toThrow(/valid event IDs/i)
    await journal.shutdown(new AbortController().signal)
  })

  it('fails visibly when the retention cap contains only unacknowledged critical records', async () => {
    const root = await temporaryRoot('capacity')
    const journal = new JsonlObservationJournalExporter({
      rootDir: root,
      mode: 'audit',
      maxRetainedBytes: 1_500,
      maxSegmentBytes: 1_500,
      segmentId: () => 'capacity01',
    })
    let failure: unknown
    for (let sequence = 1; sequence <= 10 && failure === undefined; sequence++) {
      try { await journal.stage(event(sequence, 'critical', 'capacity-run')) }
      catch (error) { failure = error }
    }
    expect(failure).toMatchObject({ code: 'OBSERVABILITY_JOURNAL_IO' })
    expect((await journal.recover()).records.length).toBeGreaterThan(0)
    await journal.shutdown(new AbortController().signal)
  })

  it('fails an audit checkpoint when fdatasync fails instead of claiming durability', async () => {
    const root = await temporaryRoot('sync-fault')
    const journal = new JsonlObservationJournalExporter({
      rootDir: root, mode: 'audit', segmentId: () => 'syncfault1',
    })
    await journal.ready()
    const probe = await open(join(root, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as { datasync(): Promise<void> }
    await probe.close()
    const sync = vi.spyOn(prototype, 'datasync').mockRejectedValueOnce(Object.assign(
      new Error('injected fdatasync failure'), { code: 'EIO' },
    ))
    try {
      const observation = createObservability({
        mode: 'audit',
        exporters: [{ exporter: journal, requirement: 'required', boundary: 'local-durable' }],
      })
      await expect(observation.checkpoint(event(1, 'critical', 'sync-fault-run'))).resolves.toMatchObject({
        status: 'rejected', durable: false, reason: 'exporter-unavailable',
      })
      expect(observation.health()).toMatchObject({ state: 'failed', exporterFailures: 1 })
    } finally {
      sync.mockRestore()
      await journal.shutdown(new AbortController().signal)
    }
  })

  it('syncs non-critical audit records and treats an identical batch retry idempotently', async () => {
    const root = await temporaryRoot('audit-normal')
    const journal = new JsonlObservationJournalExporter({
      rootDir: root, mode: 'audit', segmentId: () => 'auditnormal1',
    })
    await journal.ready()
    const probe = await open(join(root, 'probe'), 'w')
    const prototype = Object.getPrototypeOf(probe) as { datasync(): Promise<void> }
    await probe.close()
    const sync = vi.spyOn(prototype, 'datasync')
    try {
      const normal = event(1, 'normal', 'audit-normal-run')
      const retried = batch('audit-normal-batch', [normal])
      await journal.export(retried, new AbortController().signal)
      await journal.export(retried, new AbortController().signal)
      expect(sync).toHaveBeenCalled()
      expect((await journal.recover()).records.map(record => record.event.eventId)).toEqual([normal.eventId])
    } finally {
      sync.mockRestore()
      await journal.shutdown(new AbortController().signal)
    }
  })
})

describe('Node observation lifecycle and wire diagnostics', () => {
  it('installs no hooks until explicitly requested and disposes them idempotently', async () => {
    const target = new EventEmitter()
    const shutdown = vi.fn(async () => ({
      complete: true, exportedEvents: 0, pendingEvents: 0, rejectedCritical: 0, timedOut: false,
    }))
    expect(target.listenerCount('SIGTERM')).toBe(0)
    const dispose = installNodeObservabilityLifecycle({ shutdown }, { target, signals: ['SIGTERM'] })
    expect(target.listenerCount('beforeExit')).toBe(1)
    expect(target.listenerCount('SIGINT')).toBe(0)
    expect(target.listenerCount('SIGTERM')).toBe(1)
    target.emit('SIGTERM')
    await Promise.resolve()
    expect(shutdown).toHaveBeenCalledTimes(1)
    dispose()
    dispose()
    expect(target.listenerCount('SIGTERM')).toBe(0)
  })

  it('requires double opt-in for exact wire bodies and writes to a private provider route', async () => {
    const root = await temporaryRoot('wire')
    expect(() => createDiagnosticWireLogger({
      rootDir: root, content: 'metadata', allowWireBodies: true,
    })).toThrow(/content: 'full'/i)
    expect(() => createDiagnosticWireLogger({
      rootDir: root, content: 'full', allowWireBodies: false,
    })).toThrow(/allowWireBodies/i)

    const logger = createDiagnosticWireLogger({
      rootDir: root,
      content: 'full',
      allowWireBodies: true,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    })
    await logger({
      schemaVersion: 1,
      type: 'provider-request',
      provider: '../unsafe-provider',
      timestamp: 'replaced',
      body: { prompt: 'explicit-wire-content' },
    })
    await logger.shutdown()
    const providerRoot = join(root, '__unsafe-provider', 'wire')
    const [name] = await readdir(providerRoot)
    const saved = await readFile(join(providerRoot, name!), 'utf8')
    expect(saved).toContain('explicit-wire-content')
    expect(saved).toContain('2030-01-02T03:04:05.000Z')
    if (process.platform !== 'win32') expect(permission((await lstat(join(providerRoot, name!))).mode)).toBe(0o600)
  })
})
