/** Bounded cancellation and write-claim cleanup for one managed worker. */
import type { AgentTeam } from './team.ts'
import type { ManagedAgentWorkerStatus, WorkerRuntime } from './managed-types.ts'
import type { ManagedWorkerScheduling } from './managed-scheduling.ts'
import { abortable, recordEvidence } from './managed-support.ts'

interface ManagedCloseHost {
readonly team: AgentTeam
readonly scheduling: ManagedWorkerScheduling
readonly closeTimeoutMs: number
readonly workerRuntimes: Map<string, WorkerRuntime>
}

export async function closeManagedWorker(
  runtime: WorkerRuntime, reason: unknown, host: ManagedCloseHost,
): Promise<ManagedAgentWorkerStatus> {
  const address = runtime.request.name
  const previous = runtime.status
  runtime.closing = true
  runtime.controller.abort(reason)
  const closeDeadline = AbortSignal.timeout(host.closeTimeoutMs)
  // The controller only governs the run THIS harness started. A worker the
  // lead reached with followup_task, or any wake-up delivery, is running
  // under the team's own scheduler, and aborting the harness controller does
  // nothing to it: observed in a real run, a closed worker kept calling the
  // model for another fourteen seconds and submitted its result after the
  // lead had already answered, so the conversation ended on the worker's
  // output instead of the lead's synthesis.
  try {
    await abortable(host.team.cancel(address, reason), closeDeadline)
  } catch {
    // A cancellation that times out must not wedge the close: the slot is
    // freed either way, exactly as it is for a run that ignores its signal.
  }
  if (previous === 'pending') {
    // Never started, so there is no run to wait for — and `settled` would
    // never resolve on its own, because nothing is going to end.
    runtime.status = 'closed'
    runtime.start = undefined
    host.team.markPending(address, undefined)
    runtime.markSettled()
  } else {
    // Waited for, but not indefinitely, and a worker that ignores its signal
    // does not get to wedge the harness: the slot is freed either way. The
    // wait is what usually lets `detach` succeed, since it refuses a member
    // whose session is still running.
    try { await abortable(runtime.settled, closeDeadline) } catch { /* non-cooperative run remains bounded */ }
    runtime.status = 'closed'
    runtime.markSettled()
  }
  recordEvidence(runtime)
  if (host.scheduling.workerHasWork(runtime)) {
    if (runtime.request.writes.length > 0) host.scheduling.retainWrites(runtime)
    // Closing frees the managed slot, but cannot establish that an active
    // session stopped writing. Release only its write claim at actual idle.
    void host.team.whenIdle(address).then(async () => {
      host.scheduling.releaseWrites(runtime)
      try {
        if (host.team.members().some(member => member.name === address
          && member.conversationId === runtime.session.conversationId)) {
          host.team.detach(address)
        }
      } catch { /* roster already removed or disposed */ }
      await host.scheduling.releaseDependents(runtime)
    }).catch(() => { /* team lifecycle may already be disposed */ })
  }
  if (host.workerRuntimes.get(address) === runtime) {
    host.workerRuntimes.delete(address)
    try { host.team.detach(address) } catch { /* already gone, or the team is disposed */ }
  }
  // Closing is a settlement too: work planned after this worker must not be
  // left waiting on one the lead has abandoned.
  runtime.dependencies = []
  await host.scheduling.releaseDependents(runtime)
  return previous
}

