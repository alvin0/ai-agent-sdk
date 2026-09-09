import type { ObservationBoundary } from '../../observation/index.ts'
import { RuntimeResources, type CancellationScope } from '../../platform/resources.ts'
import { capturedMethod } from '../common/data.ts'
import type { ObservationDeliveryAck, ObservationDeliveryBatch } from '../exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import { atDeadline, BoundaryFailure } from '../lifecycle/bounded.ts'
import { validateDeliveryAck } from './ack.ts'
import { isPreparedBatch } from './batch.ts'
import { DELIVERY_ERROR_CODES } from './config.ts'
import { DeliveryDataError } from './data.ts'

export interface DeliveryAttemptReport {
  readonly status: 'complete' | 'partial' | 'failed' | 'timed-out' | 'aborted' | 'closed'
  readonly complete: boolean
  readonly boundary: ObservationBoundary
  readonly acceptedEventIds: readonly string[]
  readonly acceptedRunIds: readonly string[]
  readonly error?: { readonly code: string; readonly stage: 'export' | 'ack'; readonly message: string }
}

/** One exporter/batch checkpoint. Retry keeps the exact frozen batch and canonical run-record identities. */
export class DeliveryAttempt {
  private readonly events = new Set<string>()
  private readonly runs = new Set<string>()
  private readonly abort: AbortController
  private readonly sendBatch: (batch: ObservationDeliveryBatch, signal: AbortSignal) => Promise<ObservationDeliveryAck>
  private readonly boundary: ObservationBoundary
  private inFlight: Promise<DeliveryAttemptReport> | undefined
  private sealed = false

  constructor(
    private readonly batch: ObservationDeliveryBatch,
    registration: RuntimeObservationExporterRegistration,
    private readonly resources: RuntimeResources,
  ) {
    if (!isPreparedBatch(batch) || !registration.exporter.supportedBoundaries.includes(registration.boundary)) throw new DeliveryDataError()
    this.boundary = registration.boundary
    this.sendBatch = capturedMethod(registration.exporter, 'export')
    this.abort = resources.platform.controller()
  }

  private complete(): boolean { return this.events.size === this.batch.events.length && this.runs.size === this.batch.runRecords.length }

  send(deadlineAt: number, caller?: AbortSignal): Promise<DeliveryAttemptReport> {
    if (this.inFlight !== undefined) return this.inFlight
    if (this.sealed || this.resources.isClosed) return Promise.resolve(this.report('closed', DELIVERY_ERROR_CODES.CLOSED))
    if (this.complete()) return Promise.resolve(this.report('complete'))
    this.inFlight = this.exportOnce(deadlineAt, caller).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  seal(): void {
    if (this.sealed) return
    this.sealed = true
    this.abort.abort(new Error('Observation delivery is closed'))
  }

  private async exportOnce(deadlineAt: number, caller?: AbortSignal): Promise<DeliveryAttemptReport> {
    let scope: CancellationScope | undefined
    let stage: 'export' | 'ack' = 'export'
    try {
      scope = this.resources.cancellation([this.abort.signal, ...caller === undefined ? [] : [caller]])
      const value = await atDeadline(this.resources, deadlineAt, signal => this.sendBatch(this.batch, signal), scope.signal)
      if (this.sealed || this.resources.isClosed) return this.report('closed', DELIVERY_ERROR_CODES.CLOSED)
      stage = 'ack'
      const ack = validateDeliveryAck(value, this.batch)
      if (this.resources.platform.monotonicNow() >= deadlineAt) {
        scope.cancel()
        return this.report('timed-out', DELIVERY_ERROR_CODES.TIMEOUT, 'ack')
      }
      // An accessor/Proxy may abort while it is inspected. Recheck before committing any acceptance.
      if (this.sealed || this.resources.isClosed) return this.report('closed', DELIVERY_ERROR_CODES.CLOSED)
      if (scope.signal.aborted) return this.report('aborted', DELIVERY_ERROR_CODES.ABORTED)
      for (const id of ack.acceptedEventIds) this.events.add(id)
      for (const id of ack.acceptedRunIds) this.runs.add(id)
      return this.report(this.complete() ? 'complete' : 'partial')
    } catch (error) {
      const reason = error instanceof BoundaryFailure ? error.reason : 'failed'
      if (this.sealed || this.resources.isClosed) return this.report('closed', DELIVERY_ERROR_CODES.CLOSED)
      if (reason === 'timed-out') return this.report('timed-out', DELIVERY_ERROR_CODES.TIMEOUT)
      if (reason === 'aborted') return this.report('aborted', DELIVERY_ERROR_CODES.ABORTED)
      return this.report('failed', stage === 'ack' ? DELIVERY_ERROR_CODES.ACK_INVALID : DELIVERY_ERROR_CODES.EXPORT_FAILED, stage)
    } finally { scope?.dispose() }
  }

  private report(status: DeliveryAttemptReport['status'], code?: string, stage: 'export' | 'ack' = 'export'): DeliveryAttemptReport {
    return Object.freeze({ status, complete: this.complete(), boundary: this.complete() ? this.boundary : 'none',
      acceptedEventIds: Object.freeze(this.batch.events.filter(event => this.events.has(event.eventId)).map(event => event.eventId)),
      acceptedRunIds: Object.freeze(this.batch.runRecords.filter(record => this.runs.has(record.runId)).map(record => record.runId)),
      ...(code === undefined ? {} : { error: Object.freeze({ code, stage, message: 'Observation delivery did not complete' }) }) })
  }
}
