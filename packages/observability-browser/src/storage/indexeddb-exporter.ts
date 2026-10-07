import { deepFreeze, type ObservationBoundary, type ObservationEvent  } from '@alvin0/ai-agent-sdk-core'
import type {
  ExportAck,
  ObservationBatch,
  ObservationExporter,
  ObservationExportItem,
} from '@alvin0/ai-agent-sdk-core/observability'

import {
  EVENTS_STORE,
  BATCHES_STORE,
  META_STORE,
  USAGE_KEY,
  DEFAULT_DATABASE_NAME,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_OPEN_TIMEOUT_MS,
  BROWSER_OBSERVATION_ERROR_CODES,
  BrowserObservationError,
  type IndexedDbObservationExporterOptions,
  type BrowserQueueStats,
  type UsageRecord,
  type EventRecord,
  type BatchRecord,
  type PendingStage,
  positiveSafeInteger,
  safeDatabaseName,
  requestValue,
  transactionDone,
  mapDatabaseError,
  raceAbort,
  openDatabase,
  defaultUsage,
  serializedBytes,
  type ItemIdentity,
  itemIdentity,
  requiredFactory,
  validateDuplicate,
  validateExistingBatch,
} from './indexeddb-support.ts'
export { BrowserObservationError, BROWSER_OBSERVATION_ERROR_CODES } from './indexeddb-support.ts'
export type { BrowserObservationErrorCode, IndexedDbObservationExporterOptions, BrowserQueueStats }
  from './indexeddb-support.ts'

/** Browser-local durable exporter backed by IndexedDB schema version 1. */
export class IndexedDbObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[] = Object.freeze(['local-durable'])
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly databasePromise: Promise<IDBDatabase>
  private database: IDBDatabase | undefined
  private readonly pendingStages = new Map<string, PendingStage>()
  private closing = false

  constructor(options: IndexedDbObservationExporterOptions = {}) {
    this.id = options.id ?? 'indexeddb'
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/.test(this.id)) {
      throw new TypeError('IndexedDB observation exporter id must be a safe 1-64 character identifier')
    }
    this.maxEvents = positiveSafeInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, 'maxEvents')
    this.maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes')
    const factory = requiredFactory(options)
    const databaseName = safeDatabaseName(options.databaseName ?? DEFAULT_DATABASE_NAME)
    const timeoutMs = positiveSafeInteger(options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS, 'openTimeoutMs')
    this.databasePromise = openDatabase(factory, databaseName, timeoutMs).then(database => {
      if (this.closing) {
        database.close()
        throw new BrowserObservationError(
          BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'browser observation exporter is closed',
        )
      }
      this.database = database
      return database
    })
    void this.databasePromise.catch(() => undefined)
  }

  async ready(): Promise<void> {
    await this.databasePromise
  }

  stage(event: ObservationEvent): Promise<void> {
    return this.stageItem(event)
  }

  protected stageItem(item: ObservationExportItem): Promise<void> {
    if (this.closing) throw new BrowserObservationError(
      BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'browser observation exporter is closed',
    )
    const identity = itemIdentity(item)
    const payloadJson = JSON.stringify(item)
    const existing = this.pendingStages.get(identity.id)
    if (existing !== undefined) {
      if (existing.payloadJson !== payloadJson) throw new BrowserObservationError(
        BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'duplicate browser observation identity has different data',
      )
      return existing.promise
    }
    const start = (database: IDBDatabase) => this.writeItem(database, item, identity, payloadJson)
    const promise = this.database === undefined ? this.databasePromise.then(start) : start(this.database)
    this.pendingStages.set(identity.id, { payloadJson, promise })
    void promise.catch(() => undefined)
    return promise
  }

  async export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck> {
    await this.exportItems(batch.batchId, batch.createdAt, batch.events, signal)
    return deepFreeze({ batchId: batch.batchId, accepted: true, retryable: false })
  }

  protected async exportItems(
    batchId: string,
    createdAt: string,
    items: readonly ObservationExportItem[],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw signal.reason ?? new DOMException('browser observation export aborted', 'AbortError')
    await raceAbort(Promise.all(items.map(item => this.stageItem(item))).then(() => undefined), signal)
    const database = await raceAbort(this.databasePromise, signal)
    await raceAbort(this.assignBatch(database, batchId, createdAt, items), signal)
    for (const item of items) this.pendingStages.delete(itemIdentity(item).id)
  }

  async recoverEvents(): Promise<readonly ObservationEvent[]> {
    const database = await this.databasePromise
    const transaction = database.transaction(EVENTS_STORE, 'readonly')
    const done = transactionDone(transaction)
    const records = await requestValue<EventRecord[]>(transaction.objectStore(EVENTS_STORE).index('order').getAll())
    await done
    return deepFreeze(records
      .filter(record => record.itemKind === undefined || record.itemKind === 'event')
      .map(record => JSON.parse(record.payloadJson) as ObservationEvent))
  }

  async acknowledgeBatch(batchId: string): Promise<number> {
    if (typeof batchId !== 'string' || batchId.length === 0) throw new TypeError('batchId must be non-empty')
    const database = await this.databasePromise
    const transaction = database.transaction([EVENTS_STORE, BATCHES_STORE, META_STORE], 'readwrite')
    const done = transactionDone(transaction)
    try {
      const events = transaction.objectStore(EVENTS_STORE)
      const batches = transaction.objectStore(BATCHES_STORE)
      const meta = transaction.objectStore(META_STORE)
      const batch = await requestValue<BatchRecord | undefined>(batches.get(batchId))
      if (batch === undefined) {
        await done
        return 0
      }
      const usage = (await requestValue<UsageRecord | undefined>(meta.get(USAGE_KEY))) ?? defaultUsage()
      let removed = 0
      for (const eventId of batch.eventIds) {
        const record = await requestValue<EventRecord | undefined>(events.index('eventId').get(eventId))
        if (record === undefined || record.batchId !== batchId) continue
        events.delete([record.runId, record.sequence])
        usage.eventCount--
        usage.totalBytes -= record.bytes
        removed++
      }
      batches.delete(batchId)
      meta.put(usage)
      await done
      return removed
    } catch (error) {
      try { transaction.abort() } catch { /* already completed */ }
      await done.catch(() => undefined)
      throw mapDatabaseError(error, 'browser observation acknowledgment failed')
    }
  }

  async stats(): Promise<BrowserQueueStats> {
    const database = await this.databasePromise
    const transaction = database.transaction([META_STORE, BATCHES_STORE], 'readonly')
    const done = transactionDone(transaction)
    const usage = (await requestValue<UsageRecord | undefined>(transaction.objectStore(META_STORE).get(USAGE_KEY)))
      ?? defaultUsage()
    const batchCount = await requestValue(transaction.objectStore(BATCHES_STORE).count())
    await done
    return deepFreeze({ eventCount: usage.eventCount, totalBytes: usage.totalBytes, batchCount })
  }

  async pendingBatchIds(): Promise<readonly string[]> {
    const database = await this.databasePromise
    const transaction = database.transaction(BATCHES_STORE, 'readonly')
    const done = transactionDone(transaction)
    const records = await requestValue<BatchRecord[]>(transaction.objectStore(BATCHES_STORE).index('order').getAll())
    await done
    return Object.freeze(records.map(record => record.batchId))
  }

  async shutdown(_signal: AbortSignal): Promise<void> {
    if (this.closing) return
    this.closing = true
    await Promise.allSettled([...this.pendingStages.values()].map(stage => stage.promise))
    const database = await this.databasePromise.catch(() => undefined)
    database?.close()
    this.database = undefined
  }

  private async writeItem(
    database: IDBDatabase,
    _item: ObservationExportItem,
    identity: ItemIdentity,
    payloadJson: string,
  ): Promise<void> {
    const transaction = database.transaction([EVENTS_STORE, BATCHES_STORE, META_STORE], 'readwrite')
    const done = transactionDone(transaction)
    try {
      const events = transaction.objectStore(EVENTS_STORE)
      const meta = transaction.objectStore(META_STORE)
      const [sameId, sameKey, storedUsage] = await Promise.all([
        requestValue<EventRecord | undefined>(events.index('eventId').get(identity.id)),
        requestValue<EventRecord | undefined>(events.get([identity.runId, identity.sequence])),
        requestValue<UsageRecord | undefined>(meta.get(USAGE_KEY)),
      ])
      const duplicate = sameId ?? sameKey
      if (duplicate !== undefined) {
        validateDuplicate(duplicate, identity, payloadJson)
        await done
        return
      }
      const usage = storedUsage ?? defaultUsage()
      const bytes = serializedBytes(payloadJson)
      await this.evictForCapacity(transaction, usage, bytes)
      if (usage.eventCount + 1 > this.maxEvents || usage.totalBytes + bytes > this.maxBytes) {
        throw new BrowserObservationError(
          BROWSER_OBSERVATION_ERROR_CODES.quota,
          'browser observation capacity contains only protected critical events',
        )
      }
      const record: EventRecord = {
        itemKind: identity.itemKind,
        runId: identity.runId,
        sequence: identity.sequence,
        eventId: identity.id,
        priority: identity.priority,
        order: usage.nextOrder,
        bytes,
        payloadJson,
      }
      events.add(record)
      usage.eventCount++
      usage.totalBytes += bytes
      usage.nextOrder++
      meta.put(usage)
      await done
    } catch (error) {
      try { transaction.abort() } catch { /* already completed */ }
      await done.catch(() => undefined)
      throw mapDatabaseError(error, 'browser observation staging failed')
    }
  }

  private async evictForCapacity(
    transaction: IDBTransaction,
    usage: UsageRecord,
    incomingBytes: number,
  ): Promise<void> {
    for (const priority of ['verbose', 'normal'] as const) {
      if (usage.eventCount + 1 <= this.maxEvents && usage.totalBytes + incomingBytes <= this.maxBytes) return
      await new Promise<void>((resolve, reject) => {
        const events = transaction.objectStore(EVENTS_STORE)
        const batches = transaction.objectStore(BATCHES_STORE)
        const range = IDBKeyRange.bound([priority, 0], [priority, Number.MAX_SAFE_INTEGER])
        const request = events.index('priorityOrder').openCursor(range)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB eviction cursor failed'))
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor === null || (usage.eventCount + 1 <= this.maxEvents
            && usage.totalBytes + incomingBytes <= this.maxBytes)) {
            resolve()
            return
          }
          const record = cursor.value as EventRecord
          const deletion = cursor.delete()
          deletion.onerror = () => reject(deletion.error ?? new Error('IndexedDB event eviction failed'))
          usage.eventCount--
          usage.totalBytes -= record.bytes
          if (record.batchId === undefined) {
            cursor.continue()
            return
          }
          const batchRequest = batches.get(record.batchId) as IDBRequest<BatchRecord | undefined>
          batchRequest.onerror = () => reject(batchRequest.error ?? new Error('IndexedDB batch eviction failed'))
          batchRequest.onsuccess = () => {
            const batch = batchRequest.result
            if (batch === undefined) {
              cursor.continue()
              return
            }
            const eventIds = batch.eventIds.filter(eventId => eventId !== record.eventId)
            const update = eventIds.length === 0
              ? batches.delete(batch.batchId)
              : batches.put({ ...batch, eventIds })
            update.onerror = () => reject(update.error ?? new Error('IndexedDB batch eviction update failed'))
            update.onsuccess = () => cursor.continue()
          }
        }
      })
    }
  }

  private async assignBatch(
    database: IDBDatabase,
    batchId: string,
    createdAt: string,
    items: readonly ObservationExportItem[],
  ): Promise<void> {
    const transaction = database.transaction([EVENTS_STORE, BATCHES_STORE], 'readwrite')
    const done = transactionDone(transaction)
    try {
      const events = transaction.objectStore(EVENTS_STORE)
      const batches = transaction.objectStore(BATCHES_STORE)
      const existing = await requestValue<BatchRecord | undefined>(batches.get(batchId))
      if (existing !== undefined) {
        validateExistingBatch(existing, items)
        await done
        return
      }
      const records: EventRecord[] = []
      for (const item of items) {
        const identity = itemIdentity(item)
        const record = await requestValue<EventRecord | undefined>(events.index('eventId').get(identity.id))
        if (record === undefined) {
          if (identity.priority === 'critical') throw new BrowserObservationError(
            BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'critical browser observation event was not durably staged',
          )
          continue
        }
        records.push(record)
      }
      if (records.length === 0) {
        await done
        return
      }
      const record: BatchRecord = {
        batchId,
        createdAt,
        eventIds: records.map(event => event.eventId),
        order: Math.min(...records.map(event => event.order)),
      }
      batches.add(record)
      for (const event of records) events.put({ ...event, batchId })
      await done
    } catch (error) {
      try { transaction.abort() } catch { /* already completed */ }
      await done.catch(() => undefined)
      throw mapDatabaseError(error, 'browser observation batch commit failed')
    }
  }
}
