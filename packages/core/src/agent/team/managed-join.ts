/** Push-driven join and bounded synthesis, shared by managed model surfaces. */
import { createUserMessage } from '../../message/index.ts'
import type { AgentSession } from '../define/session.ts'
import type { AgentTeam } from './team.ts'
import type { ManagedSettlements } from './managed-settlements.ts'
import type { WorkerRuntime } from './managed-types.ts'
import { ManagedSynthesisGuard } from './managed-lead.ts'
import { abortable } from './managed-cancellation.ts'

interface JoinHost {
  readonly settlements: ManagedSettlements
  readonly team: AgentTeam
  readonly leadName: string
  lead(): AgentSession
  workers(): readonly WorkerRuntime[]
  preparing(): readonly unknown[]
  workerBusy(runtime: WorkerRuntime): boolean
  hasInputs(): boolean
  needsSynthesis(): boolean
  closing(): readonly Promise<unknown>[]
  joinMembers(signal?: AbortSignal): Promise<void>
  joinCollaboration(signal?: AbortSignal): Promise<void> | undefined
}

export async function joinManagedTeam(host: JoinHost, signal?: AbortSignal): Promise<void> {
  const synthesis = new ManagedSynthesisGuard(host.settlements.deliveredRevision)
  for (;;) {
    signal?.throwIfAborted()
    const outstanding = [...host.workers()].filter(runtime => host.workerBusy(runtime))
    const preparing = [...host.preparing()]
    if (host.needsSynthesis()) await host.joinCollaboration(signal)
    await host.joinMembers(signal)
    await abortable(Promise.all([...host.closing()]), signal)
    await host.team.whenIdle(host.leadName, signal)
    host.settlements.throwLeadFailure()
    if (host.settlements.hasPending) host.settlements.deferReports()
    await abortable(host.settlements.whenFlushed(signal), signal)
    await host.team.whenIdle(host.leadName, signal)
    host.settlements.throwLeadFailure()
    synthesis.observe(host.settlements.deliveredRevision, outstanding.length + preparing.length)
    const busy = host.preparing().length > 0 || host.hasInputs() || [...host.workers()]
      .some(runtime => host.workerBusy(runtime))
    if (!busy && !host.settlements.hasPending) {
      if (!host.needsSynthesis()) return
      synthesis.wake()
      // A yield is provisional even when its last worker settled between the
      // hook and agent-end. Ensure there is input for the scheduler to read.
      host.lead().inject(createUserMessage({ source: { kind: 'app', producer: 'managed-team' },
        content: [{ type: 'text', text: 'All workers settled — synthesize now.' }] }))
      host.team.wake(host.leadName)
    }
  }
}
