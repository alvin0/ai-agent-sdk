import {
  defineObservationExporter,
  type ObservationDeliveryBatch,
  type ObservationExportItem,
  type ObservationExporterPlugin,
} from '@ai-agent-sdk/core/observability'
import {
  IndexedDbObservationExporter,
  type IndexedDbObservationExporterOptions,
} from '../storage/indexeddb-exporter.ts'

class RuntimeIndexedDbExporter extends IndexedDbObservationExporter {
  stageRuntime(item: ObservationExportItem): Promise<void> {
    return this.stageItem(item)
  }

  async exportRuntime(batch: ObservationDeliveryBatch, signal: AbortSignal) {
    const items: readonly ObservationExportItem[] = [...batch.events, ...batch.runRecords]
    const createdAt = batch.events[0]?.occurredAt ?? batch.runRecords[0]?.endedAt ?? new Date().toISOString()
    await this.exportItems(batch.id, createdAt, items, signal)
    return Object.freeze({
      batchId: batch.id,
      acceptedEventIds: batch.events.map(event => event.eventId),
      acceptedRunIds: batch.runRecords.map(record => record.runId),
    })
  }
}

function captureOptions(
  value: IndexedDbObservationExporterOptions | undefined,
): IndexedDbObservationExporterOptions {
  if (value !== undefined && (typeof value !== 'object' || value === null)) {
    throw new TypeError('IndexedDB observation exporter options must be an object')
  }
  const options = value ?? {}
  return Object.freeze({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.databaseName === undefined ? {} : { databaseName: options.databaseName }),
    ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
    ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.openTimeoutMs === undefined ? {} : { openTimeoutMs: options.openTimeoutMs }),
  })
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('browser observation aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('browser observation aborted', 'AbortError')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** Inert runtime adapter; IndexedDB acquisition starts only in explicit readiness. */
export function indexedDbObservationExporter(
  value?: IndexedDbObservationExporterOptions,
): ObservationExporterPlugin {
  const options = captureOptions(value)
  const id = options.id ?? 'indexeddb'
  let exporter: RuntimeIndexedDbExporter | undefined
  let readiness: Promise<void> | undefined
  const required = (): RuntimeIndexedDbExporter => {
    if (exporter === undefined) throw new Error('IndexedDB runtime observation exporter is not ready')
    return exporter
  }
  return defineObservationExporter({
    id,
    supportedBoundaries: ['local-durable'],
    async ready(signal) {
      signal.throwIfAborted()
      exporter ??= new RuntimeIndexedDbExporter(options)
      readiness ??= exporter.ready()
      await abortable(readiness, signal)
    },
    stage(item) { return required().stageRuntime(item) },
    export(batch, signal) { return required().exportRuntime(batch, signal) },
    async shutdown(signal) {
      if (exporter !== undefined) await exporter.shutdown(signal)
    },
  })
}
