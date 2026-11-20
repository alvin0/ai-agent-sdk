import { readRuntimeJournal, recoverRuntimeJournal } from './runtime-recovery.ts'
export { recoverRuntimeJournal, type RuntimeJournalRecoveryResult } from './runtime-recovery.ts'
import { randomBytes } from 'node:crypto'
import {
  lstat,
  readFile,
  readdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ObservationDeliveryAck,
  ObservationDeliveryBatch,
  ObservationExportItem,
} from '@alvin0/ai-agent-sdk-core/observability'
import { atomicWriteJson, ensureSafeRoot, openExclusiveFile } from '../common/safe-filesystem.ts'
import { JOURNAL_FILES, JOURNAL_LIMITS, safeSegmentId } from './config.ts'
import { journalFailure } from './errors.ts'
import {
  captureRuntimeJournalItem,
  type CapturedRuntimeItem,
  type RuntimeJournalRecord,
} from './runtime-frame.ts'
import type { RuntimeJournalOptions } from './runtime-options.ts'
import { appendJournalLine } from './write.ts'
import {
  captureRuntimeJournalBatch, waitForRuntimeJournalExport, type RuntimeBatchReceipt,
} from './runtime-batch.ts'

interface RuntimeCursor {
  readonly schemaVersion: 1
  readonly acceptedItemKeys: readonly string[]
}

interface RuntimeSegment {
  readonly name: string
  readonly day: string
  readonly handle: FileHandle
  bytes: number
}

interface PendingItem {
  readonly payloadJson: string
  readonly promise: Promise<void>
}

export class RuntimeJsonlJournal {
  private root: string | undefined
  private current: RuntimeSegment | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private readonly payloads = new Map<string, string>()
  private readonly pending = new Map<string, PendingItem>()
  private readonly batches = new Map<string, RuntimeBatchReceipt>()
  private readonly accepted = new Set<string>()
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private unsyncedRecords = 0
  private unsyncedCritical = 0
  private failed: unknown
  private closing = false
  private shutdownTask: Promise<void> | undefined

  constructor(private readonly options: RuntimeJournalOptions) {}

  async ready(signal: AbortSignal): Promise<void> {
    abortIfRequested(signal)
    if (this.root !== undefined) return
    const parent = await ensureSafeRoot(this.options.rootDir)
    abortIfRequested(signal)
    const root = await ensureSafeRoot(join(parent, JOURNAL_FILES.runtimeDirectory))
    abortIfRequested(signal)
    await this.loadCursor(root)
    const recovered = await recoverRuntimeJournal(root)
    for (const record of recovered.records) {
      const previous = this.payloads.get(record.key)
      if (previous !== undefined && previous !== record.payloadJson) {
        throw journalFailure('corrupt', 'duplicate runtime journal item has different data')
      }
      this.payloads.set(record.key, record.payloadJson)
    }
    for (const key of [...this.accepted]) if (!this.payloads.has(key)) this.accepted.delete(key)
    abortIfRequested(signal)
    await this.openSegment(root)
    if (signal.aborted) {
      await this.current?.handle.close().catch(() => undefined)
      this.current = undefined
      abortIfRequested(signal)
    }
    this.root = root
  }

  stage(item: ObservationExportItem): Promise<void> {
    this.ensureAvailable()
    return this.stageCaptured(captureRuntimeJournalItem(item))
  }

  private stageCaptured(identity: CapturedRuntimeItem): Promise<void> {
    const { payloadJson, line, priority } = identity
    const persisted = this.payloads.get(identity.key)
    if (persisted !== undefined) {
      if (persisted !== payloadJson)
        throw journalFailure('corrupt', 'duplicate runtime journal item has different data')
      return Promise.resolve()
    }
    const existing = this.pending.get(identity.key)
    if (existing !== undefined) {
      if (existing.payloadJson !== payloadJson)
        throw journalFailure('corrupt', 'duplicate runtime journal item has different data')
      return existing.promise
    }
    let capacityRejected = false
    const promise = this.enqueue(async () => {
      const root = this.requiredRoot()
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > JOURNAL_LIMITS.recoverySegmentBytes) {
        throw journalFailure('io', 'runtime journal record exceeds the recovery bound')
      }
      await this.rotateIfNeeded(root, lineBytes)
      if (!await this.ensureCapacity(root, lineBytes)) {
        capacityRejected = true
        throw journalFailure('io', priority === 'critical'
          ? 'runtime journal capacity contains unacknowledged critical records'
          : 'runtime journal capacity is exhausted')
      }
      if (this.current === undefined) throw journalFailure('io', 'runtime journal segment was not opened')
      await appendJournalLine(this.current, line, error => { this.failed = error })
      this.current.bytes += lineBytes
      this.payloads.set(identity.key, payloadJson)
      this.unsyncedRecords++
      if (priority === 'critical') this.unsyncedCritical++
      if (this.options.mode === 'audit') await this.syncCurrent()
      else if (this.options.mode === 'reliable') this.scheduleReliableSync()
    })
    this.pending.set(identity.key, { payloadJson, promise })
    void promise.then(
      () => { this.pending.delete(identity.key) },
      error => {
        this.pending.delete(identity.key)
        if (!capacityRejected) this.failed = error
      },
    )
    return promise
  }

  async export(batch: ObservationDeliveryBatch, signal: AbortSignal): Promise<ObservationDeliveryAck> {
    this.ensureAvailable()
    abortIfRequested(signal)
    const { batchId, items, keys, payloadHash, acknowledgment } = captureRuntimeJournalBatch(batch)
    const previous = this.batches.get(batchId)
    if (previous !== undefined) {
      if (previous.payloadHash !== payloadHash)
        throw journalFailure('corrupt', 'duplicate runtime journal batch has different items')
      if (!previous.controller.signal.aborted) return waitForRuntimeJournalExport(previous, signal)
    }
    const controller = new AbortController()
    const delivered = previous === undefined
      ? this.deliver(items, keys, controller.signal)
      : previous.promise.catch(() => undefined).then(() => this.deliver(items, keys, controller.signal))
    const promise = delivered.then(() => acknowledgment)
    const receipt: RuntimeBatchReceipt = { keys, payloadHash, promise, controller, waiters: 0, delivered: false }
    this.batches.set(batchId, receipt)
    void promise.then(() => {
      receipt.delivered = true
      if (receipt.keys.length > 0 && receipt.keys.every(key => !this.payloads.has(key))
        && this.batches.get(batchId) === receipt) this.batches.delete(batchId)
    }, () => {
      if (this.batches.get(batchId) === receipt) this.batches.delete(batchId)
    })
    return waitForRuntimeJournalExport(receipt, signal)
  }

  private async deliver(
    items: readonly CapturedRuntimeItem[], keys: readonly string[], signal: AbortSignal,
  ): Promise<void> {
    await Promise.all(items.map(item => this.stageCaptured(item)))
    abortIfRequested(signal)
    await this.enqueue(async () => {
      await this.syncCurrent()
      const before = new Set(this.accepted)
      for (const key of keys) this.accepted.add(key)
      try {
        await this.persistCursor(this.requiredRoot())
        await this.cleanupNow(this.requiredRoot())
      } catch (error) {
        this.accepted.clear()
        for (const key of before) this.accepted.add(key)
        throw error
      }
    })
    abortIfRequested(signal)
  }

  shutdown(signal: AbortSignal): Promise<void> {
    if (this.shutdownTask !== undefined) return this.shutdownTask
    this.closing = true
    if (this.syncTimer !== undefined) clearTimeout(this.syncTimer)
    this.shutdownTask = this.close(signal)
    return this.shutdownTask
  }

  private async close(signal: AbortSignal): Promise<void> {
    await Promise.allSettled([
      ...[...this.pending.values()].map(value => value.promise),
      ...[...this.batches.values()].map(value => value.promise),
    ])
    await this.enqueue(async () => {
      try {
        abortIfRequested(signal)
        await this.syncCurrent()
      } finally {
        if (this.syncTimer !== undefined) clearTimeout(this.syncTimer)
        const current = this.current
        this.current = undefined
        try { await current?.handle.close() }
        finally {
          this.payloads.clear()
          this.pending.clear()
          this.batches.clear()
          this.accepted.clear()
        }
      }
    }, true)
  }

  private ensureAvailable(): void {
    if (this.root === undefined) throw journalFailure('io', 'runtime observation journal is not ready')
    if (this.closing) throw journalFailure('io', 'runtime observation journal is closed')
    if (this.failed !== undefined) throw journalFailure('io', 'runtime observation journal has failed', this.failed)
  }

  private requiredRoot(): string {
    if (this.root === undefined) throw journalFailure('io', 'runtime observation journal is not ready')
    return this.root
  }

  private enqueue(operation: () => Promise<void>, allowFailure = false): Promise<void> {
    const result = this.writeTail.then(() => {
      if (!allowFailure && this.failed !== undefined)
        throw journalFailure('io', 'runtime observation journal has failed', this.failed)
      return operation()
    })
    this.writeTail = result.catch(() => undefined)
    return result
  }

  private async openSegment(root: string): Promise<void> {
    const now = validNow(this.options.now())
    const day = now.toISOString().slice(0, 10)
    const id = safeSegmentId(this.options.segmentId())
    const name = `${day}-${process.pid}-${id}-${randomBytes(4).toString('hex')}.jsonl`
    this.current = { name, day, handle: await openExclusiveFile(root, name), bytes: 0 }
  }

  private async rotateIfNeeded(root: string, incomingBytes: number): Promise<void> {
    const current = this.current
    if (current === undefined) return this.openSegment(root)
    const day = validNow(this.options.now()).toISOString().slice(0, 10)
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
      void this.enqueue(() => this.syncCurrent()).catch(error => { this.failed = error })
      return
    }
    if (this.syncTimer !== undefined) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.enqueue(() => this.syncCurrent()).catch(error => { this.failed = error })
    }, this.options.syncIntervalMs)
    this.syncTimer.unref?.()
  }

  private async syncCurrent(): Promise<void> {
    if (this.current === undefined || this.unsyncedRecords === 0) return
    await this.current.handle.datasync()
    this.unsyncedRecords = 0
    this.unsyncedCritical = 0
  }

  private async ensureCapacity(root: string, incomingBytes: number): Promise<boolean> {
    let total = await retainedBytes(root)
    if (total + incomingBytes <= this.options.maxRetainedBytes) return true
    await this.cleanupNow(root)
    total = await retainedBytes(root)
    return total + incomingBytes <= this.options.maxRetainedBytes
  }

  private async cleanupCandidates(root: string) {
    const recovered = await readRuntimeJournal(root)
    const bySegment = new Map<string, RuntimeJournalRecord[]>()
    for (const record of recovered.records) {
      const records = bySegment.get(record.segment) ?? []
      records.push(record)
      bySegment.set(record.segment, records)
    }
    const candidates: Array<{ name: string; bytes: number; mtimeMs: number; accepted: boolean }> = []
    for (const [name, records] of bySegment) {
      if (name === this.current?.name) continue
      const info = await stat(join(root, name))
      candidates.push({ name, bytes: info.size, mtimeMs: info.mtimeMs,
        accepted: records.every(record => this.accepted.has(record.key)) })
    }
    return { bySegment, candidates }
  }

  private shouldDeleteSegment(candidate: { accepted: boolean; mtimeMs: number }, now: number, retained: number) {
    if (!candidate.accepted) return false
    return !(now - candidate.mtimeMs < this.options.acknowledgedRetentionMs
      && retained <= this.options.maxRetainedBytes)
  }

  private async cleanupNow(root: string): Promise<void> {
    const { bySegment, candidates } = await this.cleanupCandidates(root)
    let retained = candidates.reduce((sum, value) => sum + value.bytes, this.current?.bytes ?? 0)
    let cursorChanged = false
    const now = validNow(this.options.now()).getTime()
    for (const candidate of candidates.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (!this.shouldDeleteSegment(candidate, now, retained)) continue
      await unlink(join(root, candidate.name))
      retained -= candidate.bytes
      for (const record of bySegment.get(candidate.name) ?? []) {
        this.payloads.delete(record.key)
        if (this.accepted.delete(record.key)) cursorChanged = true
      }
    }
    if (cursorChanged) {
      this.reclaimBatchReceipts()
      await this.persistCursor(root)
    }
    if (retained > this.options.maxRetainedBytes) {
      throw journalFailure('io', 'runtime journal retention cap contains unacknowledged records')
    }
  }

  private reclaimBatchReceipts(): void {
    for (const [batchId, receipt] of this.batches) {
      if (receipt.delivered && receipt.keys.length > 0
        && receipt.keys.every(key => !this.payloads.has(key))) this.batches.delete(batchId)
    }
  }

  private async loadCursor(root: string): Promise<void> {
    try {
      const path = join(root, JOURNAL_FILES.runtimeCursor)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > JOURNAL_LIMITS.cursorBytes)
        throw new Error('unsafe cursor')
      const parsed = JSON.parse(await readFile(path, 'utf8')) as RuntimeCursor
      assertCursor(parsed)
      for (const key of parsed.acceptedItemKeys) this.accepted.add(key)
    } catch (error) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') return
      throw journalFailure('corrupt', 'runtime journal cursor is corrupt', error)
    }
  }

  private async persistCursor(root: string): Promise<void> {
    const value = { schemaVersion: 1, acceptedItemKeys: [...this.accepted].sort() } satisfies RuntimeCursor
    if (Buffer.byteLength(JSON.stringify(value)) > JOURNAL_LIMITS.cursorBytes) {
      throw journalFailure('io', 'runtime journal cursor exceeds its persistence bound')
    }
    await atomicWriteJson(root, JOURNAL_FILES.runtimeCursor, value)
  }
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('runtime observation journal aborted')
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()))
    throw new TypeError('journal now must return a valid Date')
  return value
}

async function retainedBytes(root: string): Promise<number> {
  const names = (await readdir(root)).filter(name => name.endsWith('.jsonl'))
  let total = 0
  for (const name of names) total += await stat(join(root, name)).then(value => value.size, () => 0)
  return total
}


function assertCursor(parsed: RuntimeCursor): void {
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.acceptedItemKeys)
    || parsed.acceptedItemKeys.some(key => typeof key !== 'string' || key.length === 0 || key.length > 256)) {
    throw new Error('invalid cursor')
  }
}
