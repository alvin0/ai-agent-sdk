import { timeoutValue } from '../../platform/config.ts'
import type { TeamMemberAttachmentOptions, TeamToolAccess } from './contracts.ts'
import type { AgentTeamOptions, AgentTeamMember } from './types.ts'
import type { AddressableMember, LocalMemberRuntime, RemoteMemberRuntime } from './team-runtime-types.ts'

export function teamMemberView(member: AddressableMember): AgentTeamMember {
  if (member.kind === 'remote') {
    return Object.freeze({
      name: member.name, agentId: member.transport.agentId, kind: 'remote' as const,
      role: member.role,
      status: remoteStatus(member),
      protocol: member.transport.protocol,
      deliveries: Object.freeze(['wakeup'] as const),
      ...(member.description === undefined ? {} : { description: member.description }),
      ...(member.error === undefined ? {} : { error: member.error }),
    })
  }
  return localView(member)
}

function localView(member: LocalMemberRuntime): AgentTeamMember {
  return Object.freeze({
    name: member.name, agentId: member.session.definition.id, kind: 'local' as const,
    conversationId: member.session.conversationId, role: member.role,
    status: localStatus(member),
    protocol: 'in-process', deliveries: Object.freeze(['quiet', 'wakeup'] as const),
    ...(member.description === undefined ? {} : { description: member.description }),
    ...(member.error === undefined ? {} : { error: member.error }),
    ...(member.outcome === undefined ? {} : { outcome: member.outcome }),
  })
}

/**
 * The answer text out of a run result.
 *
 * `TeamSessionPort.runPending` returns `unknown` on purpose — the port exists so
 * the control plane does not depend on the concrete session — so the one field
 * needed here is read structurally.
 * @param response - Whatever the member's run resolved with.
 * @returns Its text, or the empty string.
 */
export function responseText(response: unknown): string {
  const text = (response as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text : ''
}

/** Session implementations may resolve an incomplete terminal response rather than reject. */
export function responseFailure(response: unknown): string | undefined {
  if (response === null || typeof response !== 'object') return undefined
  const value = response as TeamResponse
  const reason = value.outcome?.reason ?? value.stopReason
  if (incompleteResponse(value, reason)) return failureMessage(value, reason)
  return undefined
}

interface TeamResponse {
  completed?: unknown
  outcome?: { completed?: unknown; reason?: { kind?: unknown; failure?: { message?: unknown } } }
  stopReason?: { kind?: unknown }
}

function incompleteResponse(value: TeamResponse, reason: { kind?: unknown } | undefined): boolean {
  return value.outcome?.completed === false || value.completed === false
    || failedReason(reason)
}

function failureMessage(value: TeamResponse, reason: { kind?: unknown } | undefined): string {
  const message = value.outcome?.reason?.failure?.message
  return typeof message === 'string' ? message : `member run did not complete (${String(reason?.kind ?? 'unknown')})`
}

function remoteStatus(member: RemoteMemberRuntime): AgentTeamMember['status'] {
  if (member.error !== undefined) return 'failed'
  return member.pending > 0 ? 'running' : 'idle'
}

function localStatus(member: LocalMemberRuntime): AgentTeamMember['status'] {
  if (member.error !== undefined) return 'failed'
  if (member.pendingStart !== undefined) return 'pending'
  return member.session.isRunning || member.wakeTask !== undefined ? 'running' : 'idle'
}

export function teamToolAccess(options: TeamMemberAttachmentOptions): TeamToolAccess | false {
  if (options.tools === false) return false
  return options.tools === 'reporting' ? 'reporting' : 'full'
}

export function localMemberIdle(member: LocalMemberRuntime, requested: number): boolean {
  return member.wakeTask === undefined && !member.session.isRunning
    && member.pendingStart === undefined && member.wakeConsumedSeq >= member.wakeRequestedSeq
    && requested === member.wakeRequestedSeq
}

export function teamTimeouts(options: AgentTeamOptions, defaultWait: number, defaultMinWait: number) {
  const disposeTimeoutMs = timeoutValue(options.disposeTimeoutMs ?? 30_000)
  const operationTimeoutMs = timeoutValue(options.operationTimeoutMs ?? 10 * 60_000)
  const observerTimeoutMs = timeoutValue(options.observerTimeoutMs ?? 1_000)
  const waitTimeoutMs = timeoutValue(options.waitTimeoutMs ?? defaultWait)
  const minWaitTimeoutMs = Math.min(timeoutValue(options.minWaitTimeoutMs ?? defaultMinWait), waitTimeoutMs)
  return { disposeTimeoutMs, operationTimeoutMs, observerTimeoutMs, waitTimeoutMs, minWaitTimeoutMs }
}

export function routingGuidance(coordinating: boolean, member: LocalMemberRuntime | undefined): string | undefined {
  if (coordinating) {
    return 'Use send_message only for quiet local context. '
      + 'Use followup_task for active work and every remote A2A peer.'
  }
  return member?.access === false ? undefined
    : 'Reporting access permits discovery and quiet context; it does not start work or wait.'
}

function failedReason(reason: { kind?: unknown } | undefined): boolean {
  return reason?.kind === 'error' || reason?.kind === 'max-tokens' || reason?.kind === 'aborted'
    || reason?.kind === 'usage-unavailable'
}

export function recordAnsweredWake(member: LocalMemberRuntime): void {
  const outcome = member.session.lastOutcome?.()
  if (outcome !== undefined) {
    const failure = responseFailure(outcome)
    member.error = failure
    member.outcome = failure === undefined
      ? { kind: 'completed', text: outcome.text }
      : { kind: 'failed', message: failure, ...(outcome.text === '' ? {} : { text: outcome.text }) }
  }
}

export function recordWakeResponse(member: LocalMemberRuntime, response: unknown): string | undefined {
  member.error = undefined
  // Recorded so a coordinator can read the member's answer from the
  // roster. `runPending` hands it to whoever awaited the run, and with
  // a wake-up delivery that is nobody.
  const failure = responseFailure(response)
  member.error = failure
  member.outcome = failure === undefined
    ? { kind: 'completed', text: responseText(response) }
    : { kind: 'failed', message: failure,
      ...(responseText(response) === '' ? {} : { text: responseText(response) }) }
  return failure
}

export function answeredWake(member: LocalMemberRuntime): boolean {
  return member.session.hasUnansweredInput?.() === false
}

export function waitToolSchema(waitTimeoutMs: number, minWaitTimeoutMs: number) {
  return {
          type: 'object',
          properties: {
            targets: {
              type: 'array', items: { type: 'string' }, minItems: 1,
              description: 'Exact agent names returned by list_agents.',
            },
            timeoutMs: {
              type: 'number',
              description:
                `Give up after this long and report instead, default ${String(waitTimeoutMs)}.`
                + ` Anything under ${String(minWaitTimeoutMs)} is raised to it: a wait too short to`
                + ` finish anything costs a model round and returns the roster unchanged.`,
            },
          },
          required: ['targets'], additionalProperties: false,
        }
}
