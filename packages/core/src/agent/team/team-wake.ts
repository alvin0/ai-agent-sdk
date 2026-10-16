import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { AgentTeamEvent } from './types.ts'
import type { LocalMemberRuntime } from './team-runtime-types.ts'
import { abortable } from './common.ts'
import { recordAnsweredWake, recordWakeResponse, answeredWake } from './team-support.ts'

interface WakeHost {
  emit(event: AgentTeamEvent): void
  observeAgentEvent(member: string, event: AgentRunEvent): Promise<void>
}

export async function runWakeLoop(member: LocalMemberRuntime, signal: AbortSignal, host: WakeHost): Promise<void> {
  let cancellationReported = false
  try {
    while (member.wakeConsumedSeq < member.wakeRequestedSeq) {
      signal.throwIfAborted()
      while (member.pendingStart !== undefined) await abortable(member.pendingStart, signal)
      await member.session.whenIdle(signal)
      if (member.pendingStart !== undefined) continue
      const through = member.wakeRequestedSeq
      if (answeredWake(member)) {
        recordAnsweredWake(member)
        member.wakeConsumedSeq = through
        continue
      }
      if (await runOneWake(member, signal, host, through)) cancellationReported = true
    }
  } catch (error: unknown) {
    if (!signal.aborted) throw error
    member.error = undefined
    member.wakeConsumedSeq = member.wakeRequestedSeq
    if (!cancellationReported) host.emit({ type: 'member-run-cancelled', member: member.name })
  }
}

function emitWakeResult(
  member: LocalMemberRuntime, failure: string | undefined, host: WakeHost, response: unknown,
): void {
  if (failure === undefined) host.emit({ type: 'member-run-end', member: member.name, response })
  else host.emit({ type: 'member-run-error', member: member.name, error: failure, response })
}
function recordWakeCancellation(member: LocalMemberRuntime, through: number, host: WakeHost): void {
  member.wakeConsumedSeq = through
  host.emit({ type: 'member-run-cancelled', member: member.name })
}
function recordWakeError(member: LocalMemberRuntime, error: unknown, through: number, host: WakeHost): void {
  if (member.session.isRunning) return
  member.error = error instanceof Error ? error.message : String(error)
  member.outcome = { kind: 'failed', message: member.error }
  member.wakeConsumedSeq = through
  host.emit({ type: 'member-run-error', member: member.name, error: member.error })
}

/** Run and settle one admitted wake without mixing it with queue consumption. */
async function runOneWake(
  member: LocalMemberRuntime, signal: AbortSignal, host: WakeHost, through: number,
): Promise<boolean> {
  host.emit({ type: 'member-run-start', member: member.name })
  let terminal: AgentRunEvent | undefined
  try {
    const response = await member.session.runPending({
      signal,
      onEvent: event => {
        if (event.type === 'agent-end') { terminal = event; return }
        return host.observeAgentEvent(member.name, event)
      },
    })
    if (signal.aborted) {
      recordWakeCancellation(member, through, host)
      return true
    }
    const failure = recordWakeResponse(member, response)
    member.wakeConsumedSeq = through
    emitWakeResult(member, failure, host, response)
    // Publish the final agent event only after the roster reflects settlement.
    // Hosts can now drain on this event without waiting for a heartbeat.
    if (terminal !== undefined) await host.observeAgentEvent(member.name, terminal)
  } catch (error: unknown) {
    if (signal.aborted) {
      member.error = undefined
      recordWakeCancellation(member, through, host)
      return true
    }
    recordWakeError(member, error, through, host)
  }
  return false
}
