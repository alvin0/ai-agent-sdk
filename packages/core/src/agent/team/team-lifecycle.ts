import type { AgentRunEvent } from '../mode/run-agent.ts'
import type { AgentMemberOutcome, AgentTeamEvent } from './types.ts'
import type { LocalMemberRuntime } from './team-runtime-types.ts'
import { responseFailure } from './team-support.ts'
import { waitForSettlement } from '../../async/index.ts'

type MailboxHost = {
  mailbox: readonly unknown[]
  maxMessages: number
  maxMailboxBytes: number
  mailboxBytes: () => number
  pendingMessages: () => number
  setPendingMessages: (value: number) => void
  pendingMailboxBytes: () => number
  setPendingMailboxBytes: (value: number) => void
}

type ObserverHost = { roster: ReadonlyMap<string, LocalMemberRuntime>
  onAgentEvent: ((member: string, event: AgentRunEvent) => void | Promise<void>) | undefined
  observerTimeoutMs: number; emit(event: AgentTeamEvent): void }

export function reserveMailbox(host: MailboxHost, contentBytes: number): () => void {
  if (host.mailbox.length + host.pendingMessages() >= host.maxMessages) {
    throw new Error(`A2A team reached its ${host.maxMessages}-message mailbox limit`)
  }
  if (host.mailboxBytes() + host.pendingMailboxBytes() + contentBytes > host.maxMailboxBytes) {
    throw new Error(`A2A team reached its ${host.maxMailboxBytes}-byte mailbox limit`)
  }
  host.setPendingMessages(host.pendingMessages() + 1)
  host.setPendingMailboxBytes(host.pendingMailboxBytes() + contentBytes)
  let released = false
  return () => {
    if (released) return
    released = true
    host.setPendingMessages(host.pendingMessages() - 1)
    host.setPendingMailboxBytes(host.pendingMailboxBytes() - contentBytes)
  }
}
export function recordOutcome(member: LocalMemberRuntime, outcome: AgentMemberOutcome): void {
  member.outcome = outcome; member.error = outcome.kind === 'failed' ? outcome.message : undefined
}
export function markPending(member: LocalMemberRuntime, until: Promise<void> | undefined): void {
  member.pendingStart = until
}
export async function observeAgentEvent(host: ObserverHost, member: string, event: AgentRunEvent): Promise<void> {
  if (event.type === 'agent-end') {
    const runtime = host.roster.get(member)
    if (runtime !== undefined) {
      const failure = responseFailure(event.outcome)
      runtime.error = failure
      runtime.outcome = failure === undefined ? { kind: 'completed', text: event.outcome.text }
        : { kind: 'failed', message: failure, ...(event.outcome.text === '' ? {} : { text: event.outcome.text }) }
    }
  }
  if (host.onAgentEvent === undefined) return
  await waitForSettlement(Promise.resolve().then(() => host.onAgentEvent?.(member, event)), host.observerTimeoutMs)
}
