import type { ObservationHealthSnapshot } from '../../observation/telemetry-types.ts'

export interface RuntimeObservationHealthSnapshot extends ObservationHealthSnapshot {
  readonly integrationEvidence: {
    readonly accepted: number
    readonly filtered: number
    readonly dropped: number
    readonly rejected: number
  }
}
