import type { ObservationEvent } from '../../observation/index.ts'
import { capturedOptionalMethod } from '../common/data.ts'
import type { ObservationExportItem, RunTerminalRecord } from '../exporter/delivery-types.ts'
import type { RuntimeObservationExporterRegistration } from '../exporter/types.ts'
import { DELIVERY_ERROR_CODES } from './config.ts'
import { DeliveryDataError } from './data.ts'
import { isPreparedEvent } from './event.ts'
import { isPreparedTerminal } from './terminal.ts'

export interface StagingFailure {
  readonly exporterIndex: number
  readonly required: boolean
  readonly code: typeof DELIVERY_ERROR_CODES.STAGE_FAILED
  readonly stage: 'stage'
  readonly message: string
}

/** Local write initiation only. The queue owner calls this after admission, never as a durability receipt. */
export class DeliveryStaging {
  private sealed = false
  private readonly hooks: readonly {
    readonly invoke: ((item: ObservationExportItem) => void | Promise<void>) | undefined
    readonly required: boolean
  }[]

  constructor(
    registrations: readonly RuntimeObservationExporterRegistration[],
    private readonly onFailure: (failure: StagingFailure) => void,
  ) {
    this.hooks = Object.freeze(registrations.map(registration => Object.freeze({
      invoke: capturedOptionalMethod<[ObservationExportItem], void | Promise<void>>(registration.exporter, 'stage'),
      required: registration.requirement === 'required',
    })))
  }

  stage(item: ObservationExportItem): void {
    if (this.sealed) return
    if (!isPreparedEvent(item as ObservationEvent) && !isPreparedTerminal(item as RunTerminalRecord)) throw new DeliveryDataError()
    for (const [index, hook] of this.hooks.entries()) {
      if (this.sealed) break
      if (hook.invoke === undefined) continue
      const fail = (): void => this.failure(index, hook.required)
      try {
        // Invoke directly: deferring this call to a microtask would violate capture-time staging.
        const pending = hook.invoke(item)
        if (pending !== undefined) void Promise.resolve(pending).then(value => {
          if (value !== undefined) fail()
        }, fail)
      } catch { fail() }
    }
  }

  seal(): void { this.sealed = true }

  private failure(exporterIndex: number, required: boolean): void {
    if (this.sealed) return
    const failure: StagingFailure = Object.freeze({ exporterIndex, required,
      code: DELIVERY_ERROR_CODES.STAGE_FAILED, stage: 'stage', message: 'Observation staging failed' })
    try { this.onFailure(failure) } catch { /* Health failure cannot escape a synchronous capture call. */ }
  }
}
