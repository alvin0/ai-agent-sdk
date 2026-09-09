import { RuntimeResources } from '../../platform/resources.ts'
import { AgentRuntimeConstructionError, type RuntimeComponentCloseReport } from '../common/errors.ts'
import { atDeadline, BoundaryFailure } from '../lifecycle/bounded.ts'
import type { RuntimeObservationExporterRegistration } from './types.ts'

function failedReady(index: number, error: unknown): AgentRuntimeConstructionError {
  const reason = error instanceof BoundaryFailure ? error.reason : 'failed'
  return new AgentRuntimeConstructionError({
    failureCode: reason === 'aborted' ? 'CAPABILITY_STARTUP_ABORTED'
      : reason === 'timed-out' ? 'CAPABILITY_STARTUP_TIMEOUT' : 'CAPABILITY_STARTUP_FAILED',
    reason, stage: 'exporter-ready', component: { kind: 'observation-exporter', id: `exporter-${index}` },
  })
}

/** Construct only after whole-runtime preflight. This is the explicit ownership-transfer boundary. */
export class RuntimeExporters {
  private readonly abort: AbortController
  private readiness: Promise<void> | undefined
  private closing: Promise<readonly RuntimeComponentCloseReport[]> | undefined

  constructor(
    readonly registrations: readonly RuntimeObservationExporterRegistration[],
    private readonly resources: RuntimeResources,
  ) { this.abort = resources.platform.controller() }

  ready(deadlineAt: number, caller?: AbortSignal): Promise<void> {
    if (this.readiness !== undefined) return this.readiness
    this.readiness = this.start(deadlineAt, caller)
    void this.readiness.catch(() => undefined)
    return this.readiness
  }

  private async start(deadlineAt: number, caller?: AbortSignal): Promise<void> {
    const scope = this.resources.cancellation([this.abort.signal, ...caller === undefined ? [] : [caller]])
    try {
      for (const [index, registration] of this.registrations.entries()) {
        try {
          await atDeadline(this.resources, deadlineAt, signal => registration.exporter.ready?.(signal), scope.signal)
        } catch (error) { throw failedReady(index, error) }
      }
    } finally { scope.dispose() }
  }

  /** No caller-abort signal here: cleanup must proceed even when startup/run cancellation requested it. */
  close(deadlineAt: number): Promise<readonly RuntimeComponentCloseReport[]> {
    if (this.closing !== undefined) return this.closing
    let resolve!: (rows: readonly RuntimeComponentCloseReport[]) => void
    this.closing = new Promise(done => { resolve = done })
    // Store the promise before abort dispatch so reentrant close joins it.
    this.abort.abort(new Error('Runtime exporters are closing'))
    void this.shutdown(deadlineAt).then(resolve)
    return this.closing
  }

  private async shutdown(deadlineAt: number): Promise<readonly RuntimeComponentCloseReport[]> {
    const rows: RuntimeComponentCloseReport[] = []
    for (let index = this.registrations.length - 1; index >= 0; index--) {
      const registration = this.registrations[index]!
      if (registration.ownership !== 'owned') continue
      const component = { kind: 'observation-exporter' as const, id: `exporter-${index}` }
      try {
        if (registration.exporter.shutdown !== undefined) {
          await atDeadline(this.resources, deadlineAt, registration.exporter.shutdown)
        }
        rows.push(Object.freeze({ ...component, status: 'closed' }))
      } catch (error) {
        const timedOut = error instanceof BoundaryFailure && error.reason === 'timed-out'
        rows.push(Object.freeze({
          ...component, status: timedOut ? 'timed-out' : 'failed',
          error: Object.freeze({ code: timedOut ? 'CAPABILITY_CLEANUP_TIMEOUT' : 'CAPABILITY_CLEANUP_FAILED',
            stage: 'exporter-shutdown', message: 'Observation exporter shutdown did not complete' }),
        }))
      }
    }
    return Object.freeze(rows)
  }
}
