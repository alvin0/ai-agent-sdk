import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { AgentTeamEvent } from './types.ts'
import type { LocalMemberRuntime } from './team-runtime-types.ts'
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
        await member.session.whenIdle(signal)
        const through = member.wakeRequestedSeq
        if (answeredWake(member)) {
          recordAnsweredWake(member)
          member.wakeConsumedSeq = through
          continue
        }
        host.emit({ type: 'member-run-start', member: member.name })
        try {
          const response = await member.session.runPending({
            signal,
            onEvent: event => host.observeAgentEvent(member.name, event),
          })
          if (signal.aborted) {
            recordWakeCancellation(member, through, host)
            cancellationReported = true
            continue
          }
          const failure = recordWakeResponse(member, response)
          member.wakeConsumedSeq = through
          emitWakeResult(member, failure, host)
        } catch (error: unknown) {
          if (signal.aborted) {
            member.error = undefined
            recordWakeCancellation(member, through, host)
            cancellationReported = true
            continue
          }
          recordWakeError(member, error, through, host)
        }
      }
    } catch (error: unknown) {
      if (!signal.aborted) throw error
      member.error = undefined
      member.wakeConsumedSeq = member.wakeRequestedSeq
      if (!cancellationReported) host.emit({ type: 'member-run-cancelled', member: member.name })
    }
  }


function emitWakeResult(member: LocalMemberRuntime, failure: string | undefined, host: WakeHost): void {
  if (failure === undefined) host.emit({ type: 'member-run-end', member: member.name })
  else host.emit({ type: 'member-run-error', member: member.name, error: failure })
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
