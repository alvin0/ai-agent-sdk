import type { ObservationBoundary } from '../../observation/index.ts'
import { RuntimeResources } from '../../platform/resources.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { arrayData } from '../common/data.ts'
import type { ObservationDeliveryBatch } from '../exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import { DeliveryAttempt, type DeliveryAttemptReport } from './attempt.ts'
import { isPreparedBatch } from './batch.ts'
import { DELIVERY_ERROR_CODES } from './config.ts'
import { DeliveryDataError } from './data.ts'

export interface ExporterCheckpointReport {
  readonly exporterIndex: number
  readonly requirement: 'required' | 'best-effort'
  readonly selectedBoundary: ObservationBoundary
  readonly delivery: DeliveryAttemptReport
}

export interface BatchCheckpointReport {
  readonly status: 'complete' | 'required-complete' | 'incomplete' | 'closed'
  readonly requiredComplete: boolean
  readonly complete: boolean
  readonly reachedBoundary: ObservationBoundary
  readonly exporters: readonly ExporterCheckpointReport[]
}

/** Fan out one stable batch. Required exporters form the checkpoint barrier; best-effort rows remain observable. */
export class DeliveryCheckpoint {
  private readonly registrations: readonly RuntimeObservationExporterRegistration[]
  private readonly attempts: readonly DeliveryAttempt[]
  private inFlight: Promise<BatchCheckpointReport> | undefined
  private sealed = false

  constructor(batch: ObservationDeliveryBatch, registrations: readonly RuntimeObservationExporterRegistration[], resources: RuntimeResources) {
    try {
      if (!isPreparedBatch(batch)) throw new DeliveryDataError()
      this.registrations = arrayData(registrations, COMPOSITION_LIMITS.exporters).map(value => value as RuntimeObservationExporterRegistration)
      if (new Set(this.registrations.map(value => value.exporter.id)).size !== this.registrations.length) throw new DeliveryDataError()
      this.attempts = Object.freeze(this.registrations.map(value => new DeliveryAttempt(batch, value, resources)))
    } catch { throw new DeliveryDataError() }
  }

  run(deadlineAt: number, caller?: AbortSignal): Promise<BatchCheckpointReport> {
    if (this.inFlight !== undefined) return this.inFlight
    if (this.sealed) return Promise.resolve(this.closedReport())
    this.inFlight = this.runOnce(deadlineAt, caller).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  seal(): void {
    if (this.sealed) return
    this.sealed = true
    for (const attempt of this.attempts) attempt.seal()
  }

  private async runOnce(deadlineAt: number, caller?: AbortSignal): Promise<BatchCheckpointReport> {
    const reports: ExporterCheckpointReport[] = []
    for (let index = 0; index < this.attempts.length; index++) {
      const registration = this.registrations[index]!
      const delivery = await this.attempts[index]!.send(deadlineAt, caller)
      reports.push(Object.freeze({ exporterIndex: index, requirement: registration.requirement,
        selectedBoundary: registration.boundary, delivery }))
    }
    return this.report(reports)
  }

  private report(rows: readonly ExporterCheckpointReport[]): BatchCheckpointReport {
    const required = rows.filter(row => row.requirement === 'required')
    const requiredComplete = required.every(row => row.delivery.complete)
    const complete = rows.every(row => row.delivery.complete)
    const reachedBoundary = requiredComplete && required.length > 0
      ? required.map(row => row.selectedBoundary).reduce(weakerBoundary)
      : 'none'
    return Object.freeze({ status: this.sealed ? 'closed' : complete ? 'complete' : requiredComplete ? 'required-complete' : 'incomplete',
      requiredComplete: !this.sealed && requiredComplete, complete: !this.sealed && complete,
      reachedBoundary: this.sealed ? 'none' : reachedBoundary, exporters: Object.freeze([...rows]) })
  }

  private closedReport(): BatchCheckpointReport {
    return this.report(this.registrations.map((registration, index) => Object.freeze({ exporterIndex: index,
      requirement: registration.requirement, selectedBoundary: registration.boundary,
      delivery: Object.freeze({ status: 'closed', complete: false, boundary: 'none', acceptedEventIds: [], acceptedRunIds: [],
        error: Object.freeze({ code: DELIVERY_ERROR_CODES.CLOSED, stage: 'export', message: 'Observation delivery did not complete' }) }),
    })))
  }
}

function weakerBoundary(left: ObservationBoundary, right: ObservationBoundary): ObservationBoundary {
  return boundaryRank(left) <= boundaryRank(right) ? left : right
}

function boundaryRank(value: ObservationBoundary): number {
  return value === 'remote-acknowledged' ? 2 : value === 'local-durable' ? 1 : 0
}
