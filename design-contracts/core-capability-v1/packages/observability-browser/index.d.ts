import type {
  ExportAck,
  Observability,
  ObservationBatch,
  ObservationBoundary,
  ObservationEvent,
  ObservationExporter,
  ObservationExporterPlugin,
} from '@ai-agent-sdk/core/observability'

export declare const BROWSER_OBSERVATION_ERROR_CODES: Readonly<{
  readonly quota: 'OBSERVABILITY_BROWSER_QUOTA'
  readonly unavailable: 'OBSERVABILITY_EXPORT_FAILED'
}>

export type BrowserObservationErrorCode =
  typeof BROWSER_OBSERVATION_ERROR_CODES[keyof typeof BROWSER_OBSERVATION_ERROR_CODES]

export declare class BrowserObservationError extends Error {
  readonly name: 'BrowserObservationError'
  readonly code: BrowserObservationErrorCode
  constructor(
    code: BrowserObservationErrorCode,
    message: string,
    options?: ErrorOptions,
  )
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

/** Existing durable advanced exporter remains available for direct control. */
export declare class IndexedDbObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  constructor(options?: IndexedDbObservationExporterOptions)
  ready(): Promise<void>
  stage(event: ObservationEvent): Promise<void>
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
  recoverEvents(): Promise<readonly ObservationEvent[]>
  acknowledgeBatch(batchId: string): Promise<number>
  stats(): Promise<BrowserQueueStats>
  pendingBatchIds(): Promise<readonly string[]>
  shutdown(signal: AbortSignal): Promise<void>
}

interface LifecycleTarget {
  readonly visibilityState?: string
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export interface BrowserLifecycleOptions {
  readonly document?: LifecycleTarget
  readonly page?: LifecycleTarget
  readonly onFlushFailure?: (error: unknown) => void
}

export declare function installBrowserObservabilityLifecycle(
  observation: Pick<Observability, 'flush'>,
  options?: BrowserLifecycleOptions,
): () => void

/** Recommended runtime adapter; it does not repurpose the advanced class. */
export declare function indexedDbObservationExporter(
  options?: IndexedDbObservationExporterOptions,
): ObservationExporterPlugin
