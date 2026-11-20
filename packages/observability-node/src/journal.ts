import { recoverJournal  } from './journal/recovery.ts'
import { journalLimits   } from './journal/runtime-options.ts'
import {
  lstat,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { join   } from 'node:path'
import {
  deepFreeze,
  type ObservationBoundary,
  type ObservationEvent,
} from '@alvin0/ai-agent-sdk-core'
import type { ExportAck, ObservationBatch, ObservationExporter   } from '@alvin0/ai-agent-sdk-core/observability'
import {
  JOURNAL_FILES,
  JOURNAL_LIMITS,
  safeSegmentId,
} from './journal/config.ts'
import { journalFailure   } from './journal/errors.ts'
import {
  assertJournalCursor, captureJournalAcknowledgments, captureJournalEvent,
  dateDay, journalChecksum, journalLine,
} from './journal/frame.ts'
import { captureJournalBatch, reclaimAcknowledgedBatches, waitForJournalExport } from './journal/batch.ts'
import { appendJournalLine } from './journal/write.ts'
import { journalRetentionCandidates } from './journal/retention.ts'
import { atomicWriteJson, ensureSafeRoot, openExclusiveFile   } from './common/safe-filesystem.ts'
import type {
  CapturedJournalEvent, CursorFile, JournalBatchReceipt, JournalRecoveryResult,
  JournalStats, JsonlObservationJournalOptions, PendingStage, SegmentState,
} from './journal/types.ts'

export type { JournalDurabilityMode, JsonlObservationJournalOptions } from './journal/types.ts'

export type { JournalRecoveryRecord, JournalRecoveryResult, JournalStats } from './journal/types.ts'

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
  private readonly retainedPayloadHashes = new Map<string, string>()
  private readonly batchEvents = new Map<string, JournalBatchReceipt>()
  private readonly acknowledged = new Set<string>()
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private unsyncedRecords = 0
  private unsyncedCritical = 0
  private closing = false
  private shutdownPromise: Promise<void> | undefined
  private failed: Error | undefined

  constructor(options: JsonlObservationJournalOptions) {
    if (typeof options !== 'object' || options === null) throw new TypeError('journal options are required')
    if (!['operational', 'reliable', 'audit'].includes(options.mode)) throw new TypeError('journal mode is invalid')
    this.id = options.id ?? 'journal'
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(this.id)) throw new TypeError('journal id is invalid')
    this.supportedBoundaries = Object.freeze(options.mode === 'operational' ? ['none'] : ['local-durable'])
    this.options = { mode: options.mode, ...journalLimits(options) }
    this.rootPromise = this.initialize(options.rootDir)
    void this.rootPromise.catch(() => undefined)
  }

  async ready(): Promise<void> {
    await this.rootPromise
  }

  stage(event: ObservationEvent): Promise<void> {
    if (this.closing) throw journalFailure('io', 'observation journal is closed')
    return this.stageCaptured(captureJournalEvent(event))
  }

  private stageCaptured(event: CapturedJournalEvent): Promise<void> {
    if (this.failed !== undefined) throw this.failed
    const { payloadJson, payloadHash } = event
    const existing = this.pendingStages.get(event.eventId)
    if (existing !== undefined) {
      if (existing.payloadJson !== payloadJson)
        throw journalFailure('corrupt', 'duplicate journal eventId has different data')
      return existing.promise
    }
    const promise = this.enqueueWrite(async () => {
      const root = await this.rootPromise
      if (this.failed !== undefined) throw this.failed
      const retainedHash = this.retainedPayloadHashes.get(event.eventId)
      if (retainedHash !== undefined) {
        if (retainedHash !== payloadHash) {
          throw journalFailure('corrupt', 'duplicate journal eventId has different data')
        }
        if (this.options.mode === 'audit') await this.syncCurrent()
        return
      }
      const line = journalLine(event.eventId, payloadJson, payloadHash)
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > JOURNAL_LIMITS.recoverySegmentBytes) throw journalFailure(
        'io', 'journal record exceeds the recovery bound',
      )
      await this.ensureCapacity(root, lineBytes, event.priority)
      await this.rotateIfNeeded(root, lineBytes)
      const segment = this.current
      if (segment === undefined) throw journalFailure('io', 'journal segment was not opened')
      await appendJournalLine(segment, line, error => { this.failed = error })
      this.retainedPayloadHashes.set(event.eventId, payloadHash)
      segment.bytes += lineBytes
      this.unsyncedRecords++
      if (event.priority === 'critical') this.unsyncedCritical++
      if (this.options.mode === 'audit') await this.syncCurrent()
      else if (this.options.mode === 'reliable') this.scheduleReliableSync()
    })
    this.pendingStages.set(event.eventId, { payloadJson, promise })
    void promise.catch(() => {
      if (this.pendingStages.get(event.eventId)?.promise === promise) {
        this.pendingStages.delete(event.eventId)
      }
    })
    return promise
  }

  async export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck> {
    if (this.closing) throw journalFailure('io', 'observation journal is closed')
    if (this.failed !== undefined) throw this.failed
    if (signal.aborted) throw signal.reason ?? new Error('journal export aborted')
    const captured = captureJournalBatch(batch)
    const existingBatch = this.batchEvents.get(captured.batchId)
    if (existingBatch !== undefined) {
      if (captured.payloadHash !== existingBatch.payloadHash) {
        throw journalFailure('corrupt', 'duplicate journal batchId has different events')
      }
      return waitForJournalExport(existingBatch.promise, signal)
    }
    const promise = (async () => {
      await Promise.all(captured.events.map(event => this.stageCaptured(event)))
      if (this.options.mode !== 'operational') await this.enqueueWrite(async () => { await this.syncCurrent() })
      for (const event of captured.events) this.pendingStages.delete(event.eventId)
      return deepFreeze({ batchId: captured.batchId, accepted: true, retryable: false })
    })()
    const receipt = { eventIds: captured.eventIds, payloadHash: captured.payloadHash, promise, delivered: false }
    this.batchEvents.set(captured.batchId, receipt)
    void promise.then(() => { receipt.delivered = true }, () => {
      if (this.batchEvents.get(captured.batchId) === receipt) this.batchEvents.delete(captured.batchId)
    })
    return waitForJournalExport(promise, signal)
  }

  async acknowledgeBatch(batchId: string): Promise<number> {
    const receipt = this.batchEvents.get(batchId)
    if (receipt === undefined) return 0
    await receipt.promise
    await this.acknowledgeEvents(receipt.eventIds)
    if (this.batchEvents.get(batchId) === receipt) this.batchEvents.delete(batchId)
    return receipt.eventIds.length
  }

  async acknowledgeEvents(eventIds: readonly string[]): Promise<void> {
    const capturedIds = captureJournalAcknowledgments(eventIds)
    await this.enqueueWrite(async () => {
      const root = await this.rootPromise
      const previous = new Set(this.acknowledged)
      for (const eventId of capturedIds) {
        if (this.retainedPayloadHashes.has(eventId)) this.acknowledged.add(eventId)
      }
      try { await this.persistCursor(root) }
      catch (error) {
        this.acknowledged.clear()
        for (const eventId of previous) this.acknowledged.add(eventId)
        throw error
      }
      reclaimAcknowledgedBatches(this.batchEvents, this.acknowledged, this.retainedPayloadHashes)
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

  private async cleanupCandidates(root: string, now: number, reclaimCurrent?: boolean) {
    const { bySegment, candidates } = await journalRetentionCandidates(root, this.acknowledged)
    const current = this.current
    const candidate = candidates.find(item => item.name === current?.name)
    if (reclaimCurrent && current !== undefined && candidate !== undefined
      && this.shouldDeleteSegment(candidate, now, 0)) {
      await this.syncCurrent()
      await current.handle.close()
      this.current = undefined
    }
    return { bySegment, candidates: candidates.filter(item => item.name !== this.current?.name) }
  }

  private shouldDeleteSegment(candidate: { acknowledged: boolean; mtimeMs: number }, now: number, retained: number) {
    if (!candidate.acknowledged) return false
    return !(now - candidate.mtimeMs < this.options.acknowledgedRetentionMs
      && retained <= this.options.maxRetainedBytes)
  }

  private async cleanupNow(root: string, reclaimCurrent?: boolean): Promise<void> {
    const now = this.options.now().getTime()
    const { bySegment, candidates } = await this.cleanupCandidates(root, now, reclaimCurrent)
    let retained = candidates.reduce((sum, item) => sum + item.bytes, this.current?.bytes ?? 0)
    const deletedAcknowledged = new Set<string>()
    for (const candidate of candidates.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (!this.shouldDeleteSegment(candidate, now, retained)) continue
      await unlink(join(root, candidate.name))
      retained -= candidate.bytes
      for (const record of bySegment.get(candidate.name) ?? []) deletedAcknowledged.add(record.event.eventId)
    }
    if (deletedAcknowledged.size > 0) {
      for (const eventId of deletedAcknowledged) {
        this.acknowledged.delete(eventId)
        this.retainedPayloadHashes.delete(eventId)
        this.pendingStages.delete(eventId)
      }
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

  shutdown(_signal: AbortSignal): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.closing = true
    if (this.syncTimer !== undefined) clearTimeout(this.syncTimer)
    this.shutdownPromise = Promise.allSettled([...this.pendingStages.values()].map(stage => stage.promise))
      .then(() => this.enqueueWrite(async () => {
        try { await this.syncCurrent() }
        finally {
          if (this.syncTimer !== undefined) clearTimeout(this.syncTimer)
          const current = this.current
          this.current = undefined
          this.pendingStages.clear()
          await current?.handle.close()
        }
      }))
    return this.shutdownPromise
  }

  private async initialize(rootInput: string): Promise<string> {
    const root = await ensureSafeRoot(rootInput)
    await this.loadCursor(root)
    const recovered = await recoverJournal(root)
    for (const record of recovered.records) {
      this.retainedPayloadHashes.set(record.event.eventId, journalChecksum(record.payloadJson))
    }
    const staleAcknowledgments = [...this.acknowledged].filter(id => !this.retainedPayloadHashes.has(id))
    for (const eventId of staleAcknowledgments) this.acknowledged.delete(eventId)
    if (staleAcknowledgments.length > 0) await this.persistCursor(root)
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
    this.current = { name, day, handle, bytes: 0 }
  }

  private async rotateIfNeeded(root: string, incomingBytes: number): Promise<void> {
    const current = this.current
    if (current === undefined) {
      await this.openSegment(root)
      return
    }
    const day = dateDay(this.options.now())
    if (current.day === day
      && (current.bytes === 0 || current.bytes + incomingBytes <= this.options.maxSegmentBytes)) return
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

  private async ensureCapacity(
    root: string, incomingBytes: number, priority: ObservationEvent['priority'],
  ): Promise<void> {
    const files = (await readdir(root)).filter(name => name.endsWith('.jsonl'))
    let total = 0
    for (const name of files) total += (await stat(join(root, name))).size
    if (total + incomingBytes <= this.options.maxRetainedBytes) return
    await this.cleanupNow(root, true)
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
      if (!info.isFile() || info.isSymbolicLink() || info.size > JOURNAL_LIMITS.cursorBytes)
        throw new Error('unsafe cursor')
      raw = await readFile(path, 'utf8')
    }
    catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return
      throw journalFailure('io', 'journal cursor read failed', error)
    }
    try {
      const value = JSON.parse(raw) as CursorFile
      assertJournalCursor(value)
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

export { recoverJournal } from './journal/recovery.ts'
