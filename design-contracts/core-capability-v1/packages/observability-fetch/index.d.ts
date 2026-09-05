import type {
  ExportAck,
  FlushResult,
  Observability,
  ObservationBatch,
  ObservationBoundary,
  ObservationExporter,
  ObservationExporterPlugin,
} from '@ai-agent-sdk/core/observability'

export interface FetchObservationExporterOptions {
  readonly id?: string
  readonly endpoint: string | URL
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
  readonly allowInsecureHttp?: boolean
  readonly requestTimeoutMs?: number
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly maxBatchEvents?: number
  readonly maxBatchBytes?: number
  readonly maxAckBytes?: number
  readonly maxAckChunks?: number
  readonly random?: () => number
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
}

/** Existing marker-free advanced exporter remains caller-owned. */
export declare class FetchObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  constructor(options: FetchObservationExporterOptions)
  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck>
}

export type WaitUntil = (pending: Promise<unknown>) => void

export declare function flushObservabilityWithWaitUntil(
  observation: Pick<Observability, 'flush'>,
  waitUntil: WaitUntil,
  signal?: AbortSignal,
): Promise<FlushResult>

/** Recommended runtime adapter; it does not repurpose the advanced class. */
export declare function fetchObservationExporter(
  options: FetchObservationExporterOptions,
): ObservationExporterPlugin
