import { createOperationId, deepFreeze, type ObservationBoundary, type ObservationEvent } from '@ai-agent-sdk/core'
import type { ExportAck, ObservationBatch, ObservationExporter } from './types.ts'

/** Memory-only exporter for tests and local inspection. It cannot claim durability. */
export class MemoryObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries = Object.freeze(['none'] as const)
  private readonly retained: ObservationEvent[] = []
  private readonly retainedBatches: ObservationBatch[] = []

  constructor(id = 'memory') {
    if (id.trim().length === 0) throw new TypeError('memory exporter id must be non-empty')
    this.id = id
  }

  export(batch: ObservationBatch, _signal: AbortSignal): Promise<ExportAck> {
    this.retainedBatches.push(batch)
    this.retained.push(...batch.events)
    return Promise.resolve(Object.freeze({ batchId: batch.batchId, accepted: true, retryable: false }))
  }

  events(): readonly ObservationEvent[] {
    return deepFreeze([...this.retained])
  }

  batches(): readonly ObservationBatch[] {
    return deepFreeze([...this.retainedBatches])
  }

  clear(): void {
    this.retained.length = 0
    this.retainedBatches.length = 0
  }
}

export interface TestObservationExporterOptions {
  readonly id?: string
  readonly supportedBoundaries?: readonly ObservationBoundary[]
  readonly failExports?: number
  readonly retryable?: boolean
  readonly rejectAck?: boolean
}

/** Deterministic programmable exporter used by delivery and fault-injection tests. */
export class TestObservationExporter implements ObservationExporter {
  readonly id: string
  readonly supportedBoundaries: readonly ObservationBoundary[]
  readonly exported: ObservationBatch[] = []
  shutdownCalls = 0
  private failuresRemaining: number
  private readonly retryable: boolean
  private readonly rejectAck: boolean

  constructor(options: TestObservationExporterOptions = {}) {
    this.id = options.id ?? `test-${createOperationId()}`
    this.supportedBoundaries = Object.freeze([...(options.supportedBoundaries ?? ['none'])])
    this.failuresRemaining = options.failExports ?? 0
    this.retryable = options.retryable ?? true
    this.rejectAck = options.rejectAck ?? false
  }

  export(batch: ObservationBatch, signal: AbortSignal): Promise<ExportAck> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('export aborted'))
    this.exported.push(batch)
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--
      return Promise.reject(new Error('test exporter failure'))
    }
    return Promise.resolve(Object.freeze({
      batchId: this.rejectAck ? `${batch.batchId}-wrong` : batch.batchId,
      accepted: !this.rejectAck,
      retryable: this.retryable,
    }))
  }

  shutdown(_signal: AbortSignal): Promise<void> {
    this.shutdownCalls++
    return Promise.resolve()
  }
}
