import { randomBytes } from 'node:crypto'
import {
  chmod,
  lstat,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  deepFreeze,
  type ObservationBoundary,
  type ObservationEvent,
} from '@ai-agent-sdk/core'
import type { ExportAck, ObservationBatch, ObservationExporter } from '@ai-agent-sdk/core/observability'
import {
  JOURNAL_DEFAULTS,
  JOURNAL_FILES,
  JOURNAL_LIMITS,
  positiveSafeInteger,
  safeSegmentId,
} from './journal/config.ts'
import { journalFailure } from './journal/errors.ts'
import { journalChecksum, validObservationEvent } from './journal/frame.ts'
import { atomicWriteJson, ensureSafeRoot, openExclusiveFile } from './common/safe-filesystem.ts'
import type { JsonlObservationJournalOptions } from './journal/types.ts'

export type { JournalDurabilityMode, JsonlObservationJournalOptions } from './journal/types.ts'

export interface JournalRecoveryRecord {
  readonly segment: string
  readonly line: number
  readonly event: ObservationEvent
  readonly payloadJson: string
}

export interface JournalRecoveryResult {
  readonly records: readonly JournalRecoveryRecord[]
  readonly quarantinedSegments: readonly string[]
  readonly truncatedSegments: readonly string[]
}

export interface JournalStats {
  readonly segmentCount: number
  readonly retainedBytes: number
  readonly unacknowledgedEvents: number
  readonly currentSegment?: string
}

interface CursorFile {
  readonly schemaVersion: 1
  readonly acknowledgedEventIds: readonly string[]
}

interface SegmentState {
  readonly name: string
  readonly day: string
  readonly handle: FileHandle
  bytes: number
  readonly eventIds: string[]
}

interface PendingStage {
  readonly payloadJson: string
  readonly promise: Promise<void>
}

function journalLine(event: ObservationEvent, payloadJson: string): string {
  return `${JSON.stringify({ schemaVersion: 1, eventId: event.eventId, payloadJson, sha256: journalChecksum(payloadJson) })}\n`
}

function dateDay(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/** Append-only Node journal whose local durability is measured with fdatasync. */
export class JsonlObservationJournalExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  private readonly options: Required<Omit<JsonlObservationJournalOptions, 'id' | 'rootDir' | 'mode'>>
    & Pick<JsonlObservationJournalOptions, 'mode'>
  private readonly rootPromise: Promise<string>
  private current: SegmentState | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private readonly pendingStages = new Map<string, PendingStage>()
  private readonly batchEvents = new Map<string, readonly string[]>()
  private readonly acknowledged = new Set<string>()
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private unsyncedRecords = 0
  private unsyncedCritical = 0
  private closing = false

  constructor(options: JsonlObservationJournalOptions) {
    if (typeof options !== 'object' || options === null) throw new TypeError('journal options are required')
    if (!['operational', 'reliable', 'audit'].includes(options.mode)) throw new TypeError('journal mode is invalid')
    this.id = options.id ?? 'journal'
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(this.id)) throw new TypeError('journal id is invalid')
    this.supportedBoundaries = Object.freeze(options.mode === 'operational' ? ['none'] : ['local-durable'])
    this.options = {
      mode: options.mode,
      maxSegmentBytes: positiveSafeInteger(options.maxSegmentBytes ?? JOURNAL_DEFAULTS.maxSegmentBytes, 'maxSegmentBytes'),
      maxRetainedBytes: positiveSafeInteger(options.maxRetainedBytes ?? JOURNAL_DEFAULTS.maxRetainedBytes, 'maxRetainedBytes'),
      acknowledgedRetentionMs: positiveSafeInteger(
        options.acknowledgedRetentionMs ?? JOURNAL_DEFAULTS.acknowledgedRetentionMs, 'acknowledgedRetentionMs',
      ),
      syncIntervalMs: positiveSafeInteger(options.syncIntervalMs ?? JOURNAL_DEFAULTS.syncIntervalMs, 'syncIntervalMs'),
      syncRecordCount: positiveSafeInteger(options.syncRecordCount ?? JOURNAL_DEFAULTS.syncRecordCount, 'syncRecordCount'),
      now: options.now ?? (() => new Date()),
      segmentId: options.segmentId ?? (() => randomBytes(12).toString('hex')),
    }
    this.rootPromise = this.initialize(options.rootDir)
    void this.rootPromise.catch(() => undefined)
  }

  async ready(): Promise<void> {
    await this.rootPromise
  }

  stage(event: ObservationEvent): Promise<void> {
    if (this.closing) throw journalFailure('io', 'observation journal is closed')
    const payloadJson = JSON.stringify(event)
    const existing = this.pendingStages.get(event.eventId)
    if (existing !== undefined) {
      if (existing.payloadJson !== payloadJson) throw journalFailure('corrupt', 'duplicate journal eventId has different data')
      return existing.promise
    }
    const promise = this.enqueueWrite(async () => {
      const root = await this.rootPromise
      const line = journalLine(event, payloadJson)
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > JOURNAL_LIMITS.recoverySegmentBytes) throw journalFailure(
        'io', 'journal record exceeds the recovery bound',
      )
      await this.ensureCapacity(root, lineBytes, event.priority)
      await this.rotateIfNeeded(root, lineBytes)
      const segment = this.current
      if (segment === undefined) throw journalFailure('io', 'journal segment was not opened')
      await segment.handle.writeFile(line, 'utf8')
      segment.bytes += lineBytes
      segment.eventIds.push(event.eventId)
      this.unsyncedRecords++
      if (event.priority === 'critical') this.unsyncedCritical++
      if (this.options.mode === 'audit') await this.syncCurrent()
      else if (this.options.mode === 'reliable') this.scheduleReliableSync()
    })
    this.pendingStages.set(event.eventId, { payloadJson, promise })
    void promise.catch(() => undefined)
    return promise
  }

  async export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck> {
    if (signal.aborted) throw signal.reason ?? new Error('journal export aborted')
    const existingBatch = this.batchEvents.get(batch.batchId)
    if (existingBatch !== undefined) {
      const eventIds = batch.events.map(event => event.eventId)
      if (eventIds.length !== existingBatch.length
        || eventIds.some((eventId, index) => eventId !== existingBatch[index])) {
        throw journalFailure('corrupt', 'duplicate journal batchId has different events')
      }
      return deepFreeze({ batchId: batch.batchId, accepted: true, retryable: false })
    }
    await Promise.all(batch.events.map(event => this.stage(event)))
    if (signal.aborted) throw signal.reason ?? new Error('journal export aborted')
    if (this.options.mode !== 'operational') await this.enqueueWrite(async () => { await this.syncCurrent() })
    this.batchEvents.set(batch.batchId, Object.freeze(batch.events.map(event => event.eventId)))
    for (const event of batch.events) this.pendingStages.delete(event.eventId)
    return deepFreeze({ batchId: batch.batchId, accepted: true, retryable: false })
  }

  async acknowledgeBatch(batchId: string): Promise<number> {
    const eventIds = this.batchEvents.get(batchId)
    if (eventIds === undefined) return 0
    await this.acknowledgeEvents(eventIds)
    this.batchEvents.delete(batchId)
    return eventIds.length
  }

  async acknowledgeEvents(eventIds: readonly string[]): Promise<void> {
    if (!Array.isArray(eventIds) || eventIds.some(
      eventId => typeof eventId !== 'string' || !/^[0-9a-f]{32}$/.test(eventId) || /^0+$/.test(eventId),
    )) throw new TypeError('journal acknowledgments require valid event IDs')
    await this.enqueueWrite(async () => {
      const root = await this.rootPromise
      const previous = new Set(this.acknowledged)
      for (const eventId of eventIds) this.acknowledged.add(eventId)
      try { await this.persistCursor(root) }
      catch (error) {
        this.acknowledged.clear()
        for (const eventId of previous) this.acknowledged.add(eventId)
        throw error
      }
      await this.cleanupNow(root)
    })
  }

  async recover(): Promise<JournalRecoveryResult> {
    let result: JournalRecoveryResult | undefined
    await this.enqueueWrite(async () => {
      result = await recoverJournal(await this.rootPromise)
    })
    if (result === undefined) throw journalFailure('io', 'journal recovery did not complete')
    return result
  }

  async cleanup(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.cleanupNow(await this.rootPromise)
    })
  }

  private async cleanupNow(root: string): Promise<void> {
    const recovered = await recoverJournal(root)
    const bySegment = new Map<string, JournalRecoveryRecord[]>()
    for (const record of recovered.records) {
      const records = bySegment.get(record.segment) ?? []
      records.push(record)
      bySegment.set(record.segment, records)
    }
    const now = this.options.now().getTime()
    const candidates: Array<{ name: string; bytes: number; mtimeMs: number; acknowledged: boolean }> = []
    for (const [name, records] of bySegment) {
      if (name === this.current?.name) continue
      const info = await stat(join(root, name))
      candidates.push({
        name, bytes: info.size, mtimeMs: info.mtimeMs,
        acknowledged: records.every(record => this.acknowledged.has(record.event.eventId)),
      })
    }
    let retained = candidates.reduce((sum, item) => sum + item.bytes, this.current?.bytes ?? 0)
    const deletedAcknowledged = new Set<string>()
    for (const candidate of candidates.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (!candidate.acknowledged) continue
      if (now - candidate.mtimeMs < this.options.acknowledgedRetentionMs
        && retained <= this.options.maxRetainedBytes) continue
      await unlink(join(root, candidate.name))
      retained -= candidate.bytes
      for (const record of bySegment.get(candidate.name) ?? []) deletedAcknowledged.add(record.event.eventId)
    }
    if (deletedAcknowledged.size > 0) {
      for (const eventId of deletedAcknowledged) this.acknowledged.delete(eventId)
      await this.persistCursor(root)
    }
    if (retained > this.options.maxRetainedBytes) throw journalFailure(
      'io', 'journal retention cap contains unacknowledged records',
    )
  }

  async stats(): Promise<JournalStats> {
    let result: JournalStats | undefined
    await this.enqueueWrite(async () => {
      const root = await this.rootPromise
      const files = (await readdir(root)).filter(name => name.endsWith('.jsonl'))
      let retainedBytes = 0
      for (const name of files) retainedBytes += (await stat(join(root, name))).size
      const recovered = await recoverJournal(root)
      result = deepFreeze({
        segmentCount: files.length,
        retainedBytes,
        unacknowledgedEvents: recovered.records.filter(record => !this.acknowledged.has(record.event.eventId)).length,
        ...this.current === undefined ? {} : { currentSegment: this.current.name },
      })
    })
    if (result === undefined) throw journalFailure('io', 'journal stats did not complete')
    return result
  }

  async shutdown(_signal: AbortSignal): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.syncTimer !== undefined) clearTimeout(this.syncTimer)
    await Promise.allSettled([...this.pendingStages.values()].map(stage => stage.promise))
    await this.enqueueWrite(async () => {
      await this.syncCurrent()
      await this.current?.handle.close()
      this.current = undefined
    })
  }

  private async initialize(rootInput: string): Promise<string> {
    const root = await ensureSafeRoot(rootInput)
    await this.loadCursor(root)
    await recoverJournal(root)
    await this.openSegment(root)
    return root
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeTail.then(operation)
    this.writeTail = result.catch(() => undefined)
    return result
  }

  private async openSegment(root: string): Promise<void> {
    const now = this.options.now()
    const day = dateDay(now)
    const id = safeSegmentId(this.options.segmentId())
    const name = `${day}-${process.pid}-${id}.jsonl`
    const handle = await openExclusiveFile(root, name)
    this.current = { name, day, handle, bytes: 0, eventIds: [] }
  }

  private async rotateIfNeeded(root: string, incomingBytes: number): Promise<void> {
    const current = this.current
    if (current === undefined) {
      await this.openSegment(root)
      return
    }
    const day = dateDay(this.options.now())
    if (current.day === day && (current.bytes === 0 || current.bytes + incomingBytes <= this.options.maxSegmentBytes)) return
    await this.syncCurrent()
    await current.handle.close()
    this.current = undefined
    await this.openSegment(root)
  }

  private scheduleReliableSync(): void {
    if (this.unsyncedCritical >= this.options.syncRecordCount) {
      if (this.syncTimer !== undefined) clearTimeout(this.syncTimer)
      this.syncTimer = undefined
      void this.enqueueWrite(async () => { await this.syncCurrent() }).catch(() => undefined)
      return
    }
    if (this.syncTimer !== undefined) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.enqueueWrite(async () => { await this.syncCurrent() }).catch(() => undefined)
    }, this.options.syncIntervalMs)
    this.syncTimer.unref?.()
  }

  private async syncCurrent(): Promise<void> {
    if (this.current === undefined || this.unsyncedRecords === 0) return
    await this.current.handle.datasync()
    this.unsyncedRecords = 0
    this.unsyncedCritical = 0
  }

  private async ensureCapacity(root: string, incomingBytes: number, priority: ObservationEvent['priority']): Promise<void> {
    const files = (await readdir(root)).filter(name => name.endsWith('.jsonl'))
    let total = 0
    for (const name of files) total += (await stat(join(root, name))).size
    if (total + incomingBytes <= this.options.maxRetainedBytes) return
    await this.cleanupNow(root)
    total = 0
    for (const name of files) {
      const path = join(root, name)
      total += await stat(path).then(value => value.size, () => 0)
    }
    if (total + incomingBytes > this.options.maxRetainedBytes) throw journalFailure(
      'io', priority === 'critical'
        ? 'journal capacity contains unacknowledged critical records'
        : 'journal capacity is exhausted',
    )
  }

  private async loadCursor(root: string): Promise<void> {
    let raw: string
    try {
      const path = join(root, JOURNAL_FILES.advancedCursor)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > JOURNAL_LIMITS.cursorBytes) throw new Error('unsafe cursor')
      raw = await readFile(path, 'utf8')
    }
    catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return
      throw journalFailure('io', 'journal cursor read failed', error)
    }
    try {
      const value = JSON.parse(raw) as CursorFile
      if (value.schemaVersion !== 1 || !Array.isArray(value.acknowledgedEventIds)
        || value.acknowledgedEventIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id))) {
        throw new Error('invalid cursor')
      }
      for (const id of value.acknowledgedEventIds) this.acknowledged.add(id)
    } catch (error) {
      throw journalFailure('corrupt', 'journal cursor is corrupt', error)
    }
  }

  private async persistCursor(root: string): Promise<void> {
    const value = {
      schemaVersion: 1,
      acknowledgedEventIds: [...this.acknowledged].sort(),
    } satisfies CursorFile
    if (Buffer.byteLength(JSON.stringify(value)) > JOURNAL_LIMITS.cursorBytes) throw journalFailure(
      'io', 'journal cursor exceeds its persistence bound',
    )
    await atomicWriteJson(root, JOURNAL_FILES.advancedCursor, value)
  }
}

export async function recoverJournal(rootInput: string): Promise<JournalRecoveryResult> {
  const root = await ensureSafeRoot(rootInput)
  const names = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
  const records: JournalRecoveryRecord[] = []
  const quarantinedSegments: string[] = []
  const truncatedSegments: string[] = []
  const eventIds = new Set<string>()
  for (const name of names) {
    const path = join(root, name)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw journalFailure('io', 'journal segment is not a regular file')
    if (info.size > JOURNAL_LIMITS.recoverySegmentBytes) throw journalFailure('corrupt', 'journal segment exceeds recovery bound')
    await chmod(path, 0o600)
    let text = await readFile(path, 'utf8')
    if (text.length > 0 && !text.endsWith('\n')) {
      const boundary = text.lastIndexOf('\n') + 1
      await truncate(path, Buffer.byteLength(text.slice(0, boundary)))
      text = text.slice(0, boundary)
      truncatedSegments.push(name)
    }
    const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n')
    const segmentEventIds: string[] = []
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ''
      try {
        const envelope = JSON.parse(line) as Record<string, unknown>
        if (envelope.schemaVersion !== 1 || typeof envelope.eventId !== 'string'
          || typeof envelope.payloadJson !== 'string' || typeof envelope.sha256 !== 'string'
          || envelope.sha256 !== journalChecksum(envelope.payloadJson)) throw new Error('invalid frame')
        const event = JSON.parse(envelope.payloadJson) as unknown
        if (!validObservationEvent(event, envelope.eventId) || eventIds.has(envelope.eventId)) throw new Error('invalid event')
        eventIds.add(envelope.eventId)
        segmentEventIds.push(envelope.eventId)
        records.push(deepFreeze({ segment: name, line: index + 1, event, payloadJson: envelope.payloadJson }))
      } catch (error) {
        if (index === lines.length - 1) {
          const quarantine = `${name}.corrupt-${Date.now()}`
          await rename(path, join(root, quarantine))
          quarantinedSegments.push(quarantine)
          for (let recordIndex = records.length - 1; recordIndex >= 0; recordIndex--) {
            if (records[recordIndex]?.segment === name) records.splice(recordIndex, 1)
          }
          for (const eventId of segmentEventIds) eventIds.delete(eventId)
          break
        }
        throw journalFailure('corrupt', `journal segment ${name} has mid-file corruption`, error)
      }
    }
  }
  return deepFreeze({ records, quarantinedSegments, truncatedSegments })
}
