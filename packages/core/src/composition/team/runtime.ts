import { AgentTeam } from '../../agent/team/team.ts'
import type { AgentSessionTeamPort, AgentSessionTeamAttachmentOptions } from '../../agent/define/session/types.ts'
import type { AgentSession } from '../../agent/define/session.ts'
import type {
  AgentTeamEvent, LinkAgentOptions, LinkedAgentResult, LinkedAgentSendInput,
  SendAgentMessageRequest, SendAgentMessageResult,
} from '../../agent/team/types.ts'
import { memberName } from '../../agent/team/common.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { NOT_APPLICABLE_USAGE_COVERAGE } from '../../support-safe/error.ts'
import { atDeadline } from '../lifecycle/bounded.ts'
import type { RuntimeAgentHost } from '../agent/session.ts'
import { createRuntimeTeamMemberSession, preflightRuntimeTeamMember } from '../agent/session.ts'
import { captureInvocationOptions } from '../agent/options.ts'
import { boundedText, capturedMethod, objectValue, optionalAbortSignal, ownData } from '../common/data.ts'
import { COMPOSITION_LIMITS } from '../common/config.ts'
import { captureCloseSignal } from '../runtime/config.ts'
import { captureRuntimeTeamOptions } from './options.ts'
import { RUNTIME_TEAM_ERROR_CODES, RUNTIME_TEAM_LIMITS } from './config.ts'
import { TEAM_TOOL_NAMES } from '../../agent/team/common.ts'
import type {
  RuntimeAgentTeam, RuntimeAgentTeamEvent, RuntimeTeamRegistration,
} from './types.ts'
import type { RuntimeAgentInvocationOptions } from '../agent/types.ts'

class RuntimeTeamValue implements RuntimeTeamRegistration {
  readonly id: string
  readonly view: RuntimeAgentTeam
  private closing: Promise<void> | undefined
  private closed = false

  constructor(
    private readonly host: RuntimeAgentHost,
    private readonly team: AgentTeam,
    private readonly sessions: Map<string, ReturnType<typeof createRuntimeTeamMemberSession>>,
    memberNames: readonly string[],
    private readonly onClosed: (registration: RuntimeTeamRegistration) => void,
  ) {
    this.id = team.id
    this.view = Object.freeze({
      id: team.id, memberNames,
      linkAgent: (options: LinkAgentOptions) => this.linkAgent(options),
      sendMessage: (request: SendAgentMessageRequest) => this.sendMessage(request),
      session: (name: string) => this.session(name),
      run: (name: string, input: string, options?: RuntimeAgentInvocationOptions) => this.run(name, input, options),
      close: (options?: { readonly signal?: AbortSignal }) => this.close(options),
    })
  }

  private assertActive(): void {
    this.host.operations.assertActive()
    if (this.closed) throw new AgentSdkError('Runtime team is closed', RUNTIME_TEAM_ERROR_CODES.closed)
  }

  private session(name: string) {
    this.assertActive()
    const value = this.sessions.get(memberName(name))
    if (value === undefined) throw new AgentSdkError('Runtime team member is unavailable', RUNTIME_TEAM_ERROR_CODES.invalid)
    return value
  }

  private run(name: string, input: string, rawOptions?: Parameters<RuntimeAgentTeam['run']>[2]) {
    this.assertActive()
    if (typeof input !== 'string') throw new TypeError('Runtime team input must be a string')
    const options = captureInvocationOptions(rawOptions)
    const session = this.session(name)
    return this.host.operations.execute('team-operation', {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, lease => session.run(input, { ...options, signal: lease.signal }))
  }

  private sendMessage(raw: SendAgentMessageRequest): Promise<SendAgentMessageResult> {
    this.assertActive()
    const request = captureMessage(raw)
    return this.host.operations.execute('team-operation', {
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, lease => this.team.sendMessage({ ...request, signal: lease.signal }))
  }

  private linkAgent(raw: LinkAgentOptions): () => void {
    this.assertActive()
    const options = captureLink(raw, this.host, this.team.id)
    const unlink = this.team.linkAgent(options)
    let active = true
    return () => {
      if (!active) return
      unlink()
      active = false
    }
  }

  private close(raw?: { readonly signal?: AbortSignal }): Promise<void> {
    captureCloseSignal(raw)
    if (this.closing !== undefined) return this.closing
    this.closed = true
    this.closing = this.team.dispose(new Error('Runtime agent team is closing')).finally(() => {
      // The runtime retains this lightweight registration for close reporting.
      // Member sessions can contain full histories and must not remain reachable
      // from a long-lived runtime after the team has settled.
      this.sessions.clear()
    })
    void this.closing.then(() => this.onClosed(this), () => undefined)
    void this.closing.catch(() => undefined)
    return this.closing
  }

  async closeForRuntime(deadlineAt: number) {
    try {
      await atDeadline(this.host.resources, deadlineAt, () => this.close())
      return Object.freeze({ kind: 'agent-team' as const, id: this.team.id, status: 'closed' as const })
    } catch {
      return Object.freeze({ kind: 'agent-team' as const, id: this.team.id, status: 'timed-out' as const,
        error: Object.freeze({ code: 'CAPABILITY_CLEANUP_TIMEOUT', stage: 'team-cleanup',
          message: 'Runtime agent team did not close before the shared deadline' }) })
    }
  }
}

export function createRuntimeAgentTeam(
  host: RuntimeAgentHost,
  raw: unknown,
  onClosed: (registration: RuntimeTeamRegistration) => void = () => undefined,
): RuntimeTeamRegistration {
  host.operations.assertActive()
  const options = captureRuntimeTeamOptions(raw)
  for (const member of options.members) {
    preflightRuntimeTeamMember(host, member.agent, member.session,
      member.tools === false ? [] : Object.values(TEAM_TOOL_NAMES))
  }
  const pendingEvents: RuntimeAgentTeamEvent[] = []
  let emit = (event: RuntimeAgentTeamEvent): void => { pendingEvents.push(event) }
  const team = new AgentTeam({ id: options.id, maxMembers: RUNTIME_TEAM_LIMITS.members,
    ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
    ...(options.observerTimeoutMs === undefined ? {} : { observerTimeoutMs: options.observerTimeoutMs }),
    onEvent: event => emit(projectEvent(event)),
  })
  const sessions = new Map<string, ReturnType<typeof createRuntimeTeamMemberSession>>()
  const attachments: Array<{ readonly session: AgentSession; readonly options: AgentSessionTeamAttachmentOptions }> = []
  const stagingTeam: AgentSessionTeamPort = Object.freeze({
    attach(session: AgentSession, attachment: AgentSessionTeamAttachmentOptions = {}) {
      attachments.push({ session, options: attachment })
    },
    toolsFor: (sender: string) => team.toolsFor(sender),
    instructionsFor: (name: string) => team.instructionsFor(name),
  })
  try {
    for (const member of options.members) {
      sessions.set(member.name, createRuntimeTeamMemberSession(host, member.agent, member.session, {
        team: stagingTeam, name: member.name, role: member.role,
        ...(member.description === undefined ? {} : { description: member.description }),
        ...(member.instructions === undefined ? {} : { instructions: member.instructions }),
        ...(member.tools === undefined ? {} : { tools: member.tools }),
      }))
    }
    for (const attachment of attachments) team.attach(attachment.session, attachment.options)
  } catch (error) {
    void team.dispose().catch(() => undefined)
    throw error
  }
  emit = event => { options.onEvent?.(event) }
  for (const event of pendingEvents) emit(event)
  return new RuntimeTeamValue(host, team, sessions, Object.freeze([...sessions.keys()]), onClosed)
}

function captureMessage(raw: unknown): SendAgentMessageRequest {
  const source = objectValue(raw)
  const allowed = new Set(['from', 'target', 'message', 'delivery', 'signal'])
  if (Reflect.ownKeys(source).some(key => typeof key !== 'string' || !allowed.has(key))) {
    throw new TypeError('Runtime team message contains unsupported fields')
  }
  const signal = optionalAbortSignal(ownData(source, 'signal', false))
  const delivery = ownData(source, 'delivery', false)
  return Object.freeze({ from: memberName(ownData(source, 'from')), target: memberName(ownData(source, 'target')),
    message: ownData(source, 'message') as SendAgentMessageRequest['message'],
    ...(delivery === undefined ? {} : { delivery: delivery as NonNullable<SendAgentMessageRequest['delivery']> }),
    ...(signal === undefined ? {} : { signal }) })
}

function captureLink(raw: unknown, host: RuntimeAgentHost, teamId: string): LinkAgentOptions {
  const source = objectValue(raw)
  const name = memberName(ownData(source, 'name'))
  const descriptionValue = ownData(source, 'description', false)
  const transport = objectValue(ownData(source, 'transport'))
  const protocol = boundedText(ownData(transport, 'protocol'), COMPOSITION_LIMITS.identityBytes)
  const agentId = boundedText(ownData(transport, 'agentId'), COMPOSITION_LIMITS.identityBytes)
  const send = capturedMethod<[LinkedAgentSendInput], Promise<LinkedAgentResult>>(transport, 'send')
  const logger = host.observation.logger({ scope: 'sdk.team.transport', fields: { teamId, member: name } })
  return Object.freeze({ name,
    ...(descriptionValue === undefined ? {} : {
      description: boundedText(descriptionValue, 8 * 1_024),
    }),
    transport: Object.freeze({ protocol, agentId,
      send: (input: LinkedAgentSendInput) => send({ ...input, logger }) }),
  })
}

function projectEvent(event: AgentTeamEvent): RuntimeAgentTeamEvent {
  if (event.type === 'member-attached') return Object.freeze({ type: event.type, member: event.member.name })
  if (event.type === 'member-linked') return Object.freeze({ type: event.type, member: event.member.name,
    protocol: event.member.protocol ?? 'unknown' })
  if (event.type === 'message-accepted') return Object.freeze({ type: event.type,
    messageId: event.message.id, target: event.message.target })
  if (event.type === 'member-run-start' || event.type === 'member-run-end') return Object.freeze(event)
  if (event.type === 'member-run-error') return Object.freeze({ type: event.type, member: event.member,
    error: Object.freeze({ code: 'TEAM_MEMBER_RUN_FAILED', stage: 'team-operation',
      message: 'Runtime team member operation failed', usageCoverage: NOT_APPLICABLE_USAGE_COVERAGE,
      possiblyBilledAttemptsWithoutUsage: 0 }) })
  if (event.type === 'team-disposed') return Object.freeze({ type: 'team-closed', teamId: event.teamId })
  return Object.freeze({ type: 'member-run-end', member: event.member })
}
