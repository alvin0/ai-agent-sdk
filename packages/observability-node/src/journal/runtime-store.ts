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
import { deepFreeze, type ObservationEvent } from '@ai-agent-sdk/core'
import type {
  ObservationDeliveryAck,
  ObservationDeliveryBatch,
  ObservationExportItem,
} from '@ai-agent-sdk/core/observability'
import { atomicWriteJson, ensureSafeRoot, openExclusiveFile } from '../common/safe-filesystem.ts'
import { JOURNAL_FILES, JOURNAL_LIMITS, safeSegmentId } from './config.ts'
import { journalFailure } from './errors.ts'
import {
  parseRuntimeJournalLine,
  runtimeItemIdentity,
  runtimeJournalLine,
  type RuntimeJournalRecord,
} from './runtime-frame.ts'
import type { RuntimeJournalOptions } from './runtime-options.ts'

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

export interface RuntimeJournalRecoveryResult {
  readonly records: readonly RuntimeJournalRecord[]
  readonly truncatedSegments: readonly string[]
  readonly quarantinedSegments: readonly string[]
}

export class RuntimeJsonlJournal {
  private root: string | undefined
  private current: RuntimeSegment | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private readonly payloads = new Map<string, string>()
  private readonly pending = new Map<string, PendingItem>()
  private readonly batches = new Map<string, readonly string[]>()
  private readonly accepted = new Set<string>()
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private unsyncedRecords = 0
  private unsyncedCritical = 0
  private failed: unknown
  private closing = false

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
    const identity = runtimeItemIdentity(item)
    const payloadJson = JSON.stringify(item)
    const persisted = this.payloads.get(identity.key)
    if (persisted !== undefined) {
      if (persisted !== payloadJson) throw journalFailure('corrupt', 'duplicate runtime journal item has different data')
      return Promise.resolve()
    }
    const existing = this.pending.get(identity.key)
    if (existing !== undefined) {
      if (existing.payloadJson !== payloadJson) throw journalFailure('corrupt', 'duplicate runtime journal item has different data')
      return existing.promise
    }
    const promise = this.enqueue(async () => {
      const root = this.requiredRoot()
      const line = runtimeJournalLine(item, payloadJson)
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > JOURNAL_LIMITS.recoverySegmentBytes) {
        throw journalFailure('io', 'runtime journal record exceeds the recovery bound')
      }
      const priority = identity.kind === 'run-terminal-record' ? 'critical' : (item as ObservationEvent).priority
      await this.ensureCapacity(root, lineBytes, priority)
      await this.rotateIfNeeded(root, lineBytes)
      if (this.current === undefined) throw journalFailure('io', 'runtime journal segment was not opened')
      await this.current.handle.writeFile(line, 'utf8')
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
      error => { this.failed = error },
    )
    return promise
  }

  async export(batch: ObservationDeliveryBatch, signal: AbortSignal): Promise<ObservationDeliveryAck> {
    this.ensureAvailable()
    abortIfRequested(signal)
    const items: readonly ObservationExportItem[] = [...batch.events, ...batch.runRecords]
    const keys = items.map(item => runtimeItemIdentity(item).key)
    const previous = this.batches.get(batch.id)
    if (previous !== undefined) {
      if (!sameList(previous, keys)) throw journalFailure('corrupt', 'duplicate runtime journal batch has different items')
      return deliveryAck(batch)
    }
    await Promise.all(items.map(item => this.stage(item)))
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
    this.batches.set(batch.id, Object.freeze(keys))
    return deliveryAck(batch)
  }

  async shutdown(signal: AbortSignal): Promise<void> {
    if (this.closing) return
    this.closing = true
    if (this.syncTimer !== undefined) clearTimeout(this.syncTimer)
    await Promise.allSettled([...this.pending.values()].map(value => value.promise))
    abortIfRequested(signal)
    await this.enqueue(async () => {
      await this.syncCurrent()
      await this.current?.handle.close()
      this.current = undefined
    })
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

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writeTail.then(operation)
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

  private async ensureCapacity(root: string, incomingBytes: number, priority: string): Promise<void> {
    let total = await retainedBytes(root)
    if (total + incomingBytes <= this.options.maxRetainedBytes) return
    await this.cleanupNow(root)
    total = await retainedBytes(root)
    if (total + incomingBytes > this.options.maxRetainedBytes) throw journalFailure(
      'io',
      priority === 'critical'
        ? 'runtime journal capacity contains unacknowledged critical records'
        : 'runtime journal capacity is exhausted',
    )
  }

  private async cleanupNow(root: string): Promise<void> {
    const recovered = await recoverRuntimeJournal(root)
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
    let retained = candidates.reduce((sum, value) => sum + value.bytes, this.current?.bytes ?? 0)
    let cursorChanged = false
    const now = validNow(this.options.now()).getTime()
    for (const candidate of candidates.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (!candidate.accepted) continue
      if (now - candidate.mtimeMs < this.options.acknowledgedRetentionMs
        && retained <= this.options.maxRetainedBytes) continue
      await unlink(join(root, candidate.name))
      retained -= candidate.bytes
      for (const record of bySegment.get(candidate.name) ?? []) {
        this.payloads.delete(record.key)
        if (this.accepted.delete(record.key)) cursorChanged = true
      }
    }
    if (cursorChanged) await this.persistCursor(root)
    if (retained > this.options.maxRetainedBytes) {
      throw journalFailure('io', 'runtime journal retention cap contains unacknowledged records')
    }
  }

  private async loadCursor(root: string): Promise<void> {
    try {
      const path = join(root, JOURNAL_FILES.runtimeCursor)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > JOURNAL_LIMITS.cursorBytes) throw new Error('unsafe cursor')
      const parsed = JSON.parse(await readFile(path, 'utf8')) as RuntimeCursor
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.acceptedItemKeys)
        || parsed.acceptedItemKeys.some(key => typeof key !== 'string' || key.length === 0 || key.length > 256)) {
        throw new Error('invalid cursor')
      }
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

export async function recoverRuntimeJournal(root: string): Promise<RuntimeJournalRecoveryResult> {
  const names = (await readdir(root)).filter(name => name.endsWith('.jsonl')).sort()
  const records: RuntimeJournalRecord[] = []
  const payloads = new Map<string, string>()
  const truncatedSegments: string[] = []
  const quarantinedSegments: string[] = []
  for (const name of names) {
    const path = join(root, name)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw journalFailure('io', 'runtime journal segment is not a regular file')
    if (info.size > JOURNAL_LIMITS.recoverySegmentBytes) {
      throw journalFailure('corrupt', 'runtime journal segment exceeds recovery bound')
    }
    await chmod(path, 0o600)
    let text = await readFile(path, 'utf8')
    if (text.length > 0 && !text.endsWith('\n')) {
      const boundary = text.lastIndexOf('\n') + 1
      await truncate(path, Buffer.byteLength(text.slice(0, boundary)))
      text = text.slice(0, boundary)
      truncatedSegments.push(name)
    }
    const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n')
    const segmentRecords: RuntimeJournalRecord[] = []
    for (let index = 0; index < lines.length; index++) {
      try {
        const record = parseRuntimeJournalLine(lines[index] ?? '', name, index + 1)
        const previous = payloads.get(record.key)
        if (previous !== undefined && previous !== record.payloadJson) throw new Error('conflicting duplicate item')
        segmentRecords.push(record)
      } catch (error) {
        if (index !== lines.length - 1) {
          throw journalFailure('corrupt', `runtime journal segment ${name} has mid-file corruption`, error)
        }
        const quarantine = `${name}.corrupt-${Date.now()}`
        await rename(path, join(root, quarantine))
        quarantinedSegments.push(quarantine)
        segmentRecords.length = 0
        break
      }
    }
    for (const record of segmentRecords) {
      payloads.set(record.key, record.payloadJson)
      records.push(record)
    }
  }
  return deepFreeze({ records, truncatedSegments, quarantinedSegments })
}

function deliveryAck(batch: ObservationDeliveryBatch): ObservationDeliveryAck {
  return deepFreeze({
    batchId: batch.id,
    acceptedEventIds: batch.events.map(event => event.eventId),
    acceptedRunIds: batch.runRecords.map(record => record.runId),
  })
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('runtime observation journal aborted')
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('journal now must return a valid Date')
  return value
}

async function retainedBytes(root: string): Promise<number> {
  const names = (await readdir(root)).filter(name => name.endsWith('.jsonl'))
  let total = 0
  for (const name of names) total += await stat(join(root, name)).then(value => value.size, () => 0)
  return total
}
