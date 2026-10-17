/** Invocation cleanup: an aborted or failed run must not leave owned workers to wake the lead later. */
import type { WorkerRuntime } from './managed-types.ts'

export interface ManagedRunFinishHost {
  cancelLead(reason: unknown): Promise<void>
  closeWorker(name: string, reason: unknown): Promise<unknown>
  workerBusy(runtime: WorkerRuntime): boolean
  finishProgress(aborted: boolean): void
}

/** The signal that suppresses settlement wakes while cleanup runs. A failed run owes no synthesis. */
export function managedFinishingSignal(signal: AbortSignal, failed: { error: unknown } | undefined): AbortSignal {
  return signal.aborted || failed === undefined ? signal
    : AbortSignal.abort(new Error('managed lead run failed', { cause: failed.error }))
}

export async function finishManagedRun(host: ManagedRunFinishHost, signal: AbortSignal, finishing: AbortSignal,
  owned: ReadonlySet<WorkerRuntime>): Promise<void> {
  try { host.finishProgress(signal.aborted) } catch {
    /* Progress cleanup cannot prevent invocation release or worker cancellation. */
  }
  if (signal.aborted) {
    await Promise.allSettled([host.cancelLead(signal.reason),
      ...[...owned].map(runtime => host.closeWorker(runtime.request.name, signal.reason))])
  } else if (finishing !== signal) {
    // Busy workers would otherwise outlive the rejected run; settled ones keep their retained results.
    await Promise.allSettled([...owned].filter(runtime => host.workerBusy(runtime))
      .map(runtime => host.closeWorker(runtime.request.name, finishing.reason)))
  }
}
