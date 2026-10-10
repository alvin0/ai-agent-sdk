import { type ObservationEvent  } from '@alvin0/ai-agent-sdk-core'
import type {
  ObservationExportItem,
} from '@alvin0/ai-agent-sdk-core/observability'

export const DATABASE_VERSION = 1
export const EVENTS_STORE = 'events'
export const BATCHES_STORE = 'batches'
export const META_STORE = 'meta'
export const USAGE_KEY = 'usage'
export const DEFAULT_DATABASE_NAME = 'ai-agent-sdk-observability'
export const DEFAULT_MAX_EVENTS = 50_000
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_OPEN_TIMEOUT_MS = 10_000

export const BROWSER_OBSERVATION_ERROR_CODES = Object.freeze({
  quota: 'OBSERVABILITY_BROWSER_QUOTA',
  unavailable: 'OBSERVABILITY_EXPORT_FAILED',
} as const)

export type BrowserObservationErrorCode =
  typeof BROWSER_OBSERVATION_ERROR_CODES[keyof typeof BROWSER_OBSERVATION_ERROR_CODES]

export class BrowserObservationError extends Error {
  override readonly name = 'BrowserObservationError'
  readonly code: BrowserObservationErrorCode

  constructor(code: BrowserObservationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export interface IndexedDbObservationExporterOptions {
  readonly id?: string
  readonly databaseName?: string
  readonly indexedDB?: IDBFactory
  readonly maxEvents?: number
  readonly maxBytes?: number
  readonly openTimeoutMs?: number
}

export interface BrowserQueueStats {
  readonly eventCount: number
  readonly totalBytes: number
  readonly batchCount: number
}

export interface UsageRecord {
  readonly key: typeof USAGE_KEY
  eventCount: number
  totalBytes: number
  nextOrder: number
}

export interface EventRecord {
  readonly itemKind: 'event' | 'run-record'
  readonly runId: string
  readonly sequence: number
  readonly eventId: string
  readonly priority: ObservationEvent['priority']
  readonly order: number
  readonly bytes: number
  readonly payloadJson: string
  batchId?: string
}

export interface BatchRecord {
  readonly batchId: string
  readonly createdAt: string
  readonly eventIds: readonly string[]
  readonly order: number
}

export interface PendingStage {
  readonly payloadJson: string
  readonly promise: Promise<void>
}

export function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer`)
  return value
}

export function safeDatabaseName(value: string): string {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 128) {
    throw new TypeError('IndexedDB observation databaseName must contain 1-128 characters')
  }
  return normalized
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'))
    transaction.onerror = () => { /* abort carries the terminal error */ }
  })
}

export function mapDatabaseError(error: unknown, message: string): BrowserObservationError {
  const name = typeof error === 'object' && error !== null ? Reflect.get(error, 'name') : undefined
  if (name === 'QuotaExceededError') {
    return new BrowserObservationError(BROWSER_OBSERVATION_ERROR_CODES.quota, 'browser observation quota exceeded')
  }
  if (error instanceof BrowserObservationError) return error
  return new BrowserObservationError(BROWSER_OBSERVATION_ERROR_CODES.unavailable, message)
}

export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('browser observation aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup(); reject(signal.reason ?? new DOMException('browser observation aborted', 'AbortError'))
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

export function hasSchema(database: IDBDatabase): boolean {
  return database.objectStoreNames.contains(EVENTS_STORE)
    && database.objectStoreNames.contains(BATCHES_STORE)
    && database.objectStoreNames.contains(META_STORE)
}

export function createSchema(database: IDBDatabase): void {
  const events = database.createObjectStore(EVENTS_STORE, { keyPath: ['runId', 'sequence'] })
  events.createIndex('eventId', 'eventId', { unique: true })
  events.createIndex('priorityOrder', ['priority', 'order'])
  events.createIndex('order', 'order', { unique: true })
  events.createIndex('batchId', 'batchId')
  const batches = database.createObjectStore(BATCHES_STORE, { keyPath: 'batchId' })
  batches.createIndex('order', 'order', { unique: true })
  database.createObjectStore(META_STORE, { keyPath: 'key' })
}

export function openDatabase(factory: IDBFactory, name: string, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false
    let blocked = false
    const request = factory.open(name, DATABASE_VERSION)
    const timer = setTimeout(() => finishError(new BrowserObservationError(
      BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'browser observation database open timed out',
    )), timeoutMs)
    const finishError = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(mapDatabaseError(error, blocked
        ? 'browser observation database upgrade is blocked'
        : 'browser observation database is unavailable'))
    }
    request.onblocked = () => {
      blocked = true
      finishError(new BrowserObservationError(
        BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'browser observation database upgrade is blocked',
      ))
    }
    request.onerror = () => finishError(request.error)
    request.onupgradeneeded = event => {
      try {
        if ((event as IDBVersionChangeEvent).oldVersion === 0) createSchema(request.result)
      } catch (error) {
        try { request.transaction?.abort() } catch { /* already aborted */ }
        finishError(error)
      }
    }
    request.onsuccess = () => {
      const database = request.result
      if (settled) {
        database.close()
        return
      }
      if (!hasSchema(database)) {
        database.close()
        finishError(new BrowserObservationError(
          BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'browser observation database schema is invalid',
        ))
        return
      }
      settled = true
      clearTimeout(timer)
      database.onversionchange = () => database.close()
      resolve(database)
    }
  })
}

export function defaultUsage(): UsageRecord {
  return { key: USAGE_KEY, eventCount: 0, totalBytes: 0, nextOrder: 1 }
}

export function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export interface ItemIdentity {
  readonly itemKind: EventRecord['itemKind']
  readonly runId: string
  readonly sequence: number
  readonly id: string
  readonly priority: ObservationEvent['priority']
}

export function itemIdentity(item: ObservationExportItem): ItemIdentity {
  if ('eventId' in item) return {
    itemKind: 'event', runId: item.correlation.runId, sequence: item.sequence,
    id: item.eventId, priority: item.priority,
  }
  return { itemKind: 'run-record', runId: item.runId, sequence: -1,
    id: `run:${item.runId}`, priority: 'critical' }
}


export function requiredFactory(options: IndexedDbObservationExporterOptions): IDBFactory {
    const factory = options.indexedDB ?? globalThis.indexedDB
    if (factory === undefined || typeof factory.open !== 'function') {
      throw new TypeError('IndexedDB observation exporter requires indexedDB')
    }
  return factory
}

export function validateDuplicate(duplicate: EventRecord, identity: ItemIdentity, payloadJson: string): void {
        if (duplicate.eventId !== identity.id || duplicate.payloadJson !== payloadJson
          || duplicate.runId !== identity.runId || duplicate.sequence !== identity.sequence) {
          throw new BrowserObservationError(
            BROWSER_OBSERVATION_ERROR_CODES.unavailable,
            'duplicate browser observation identity has different data',
          )
        }
}

export function validateExistingBatch(existing: BatchRecord, items: readonly ObservationExportItem[]): void {
        const submittedIds = new Set(items.map(item => itemIdentity(item).id))
        if (!existing.eventIds.every(eventId => submittedIds.has(eventId))) {
          throw new BrowserObservationError(
            BROWSER_OBSERVATION_ERROR_CODES.unavailable, 'duplicate browser observation batchId has different events',
          )
        }
}
