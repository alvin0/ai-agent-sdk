import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { AgentMemberOutcome, AgentTeamEvent } from './types.ts'
import type { LocalMemberRuntime } from './team-runtime-types.ts'
import { waitForSettlement } from '../../async/index.ts'

type ObserverHost = { roster: ReadonlyMap<string, LocalMemberRuntime>
  onAgentEvent: ((member: string, event: AgentRunEvent) => void | Promise<void>) | undefined
  observerTimeoutMs: number; emit(event: AgentTeamEvent): void }

export function recordOutcome(member: LocalMemberRuntime, outcome: AgentMemberOutcome): void {
  member.outcome = outcome; member.error = outcome.kind === 'failed' ? outcome.message : undefined
}
export function markPending(member: LocalMemberRuntime, until: Promise<void> | undefined): void {
  member.pendingStart = until
}
export async function observeAgentEvent(host: ObserverHost, member: string, event: AgentRunEvent): Promise<void> {
  // Scheduler settlement already published the outcome before this observer.
  // Re-projecting it here would create a second delivery identity for the same run.
  if (host.onAgentEvent === undefined) return
  await waitForSettlement(Promise.resolve().then(() => host.onAgentEvent?.(member, event)), host.observerTimeoutMs)
}
