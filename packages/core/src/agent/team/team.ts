import type { AgentRunEvent } from '../mode/run-agent.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { ContentBlock } from '../../message/index.ts'
import { createUserMessage } from '../../message/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import type { TeamMemberAttachmentOptions, TeamPort, TeamSessionPort } from './contracts.ts'
import type {
  AgentMessageRecord, AgentTeamEvent, AgentTeamMember, AgentTeamOptions, LinkAgentOptions,
  LinkedAgentResult, SendAgentMessageRequest, SendAgentMessageResult,
} from './types.ts'
import {
  messageToolSchema, parseMessageTool, parseWaitTool, emptyObject, messageContent, memberName,
  boundedString, positiveInteger, byteLength, errorMessage, asJson, deepCloneFreeze, newTeamId,
  newMessageId, abortable, combineSignals, withTimeout, TEAM_TOOL_NAMES,
} from './common.ts'

/** Shared control plane for local sessions and interoperable remote A2A peers. */

interface LocalMemberRuntime {
  readonly kind: 'local'
  readonly name: string
  readonly description?: string
  readonly instructions?: string
  readonly role: 'lead' | 'peer'
  readonly session: TeamSessionPort
  wakeRequestedSeq: number
  wakeConsumedSeq: number
  wakeTask: Promise<void> | undefined
  wakeController: AbortController | undefined
  error: string | undefined
}

interface RemoteMemberRuntime {
  readonly kind: 'remote'
  readonly name: string
  readonly description?: string
  readonly role: 'peer'
  readonly transport: LinkAgentOptions['transport']
  tail: Promise<void>
  pending: number
  readonly controllers: Set<AbortController>
  error: string | undefined
}

type AddressableMember = LocalMemberRuntime | RemoteMemberRuntime


/**
 * Connect long-lived local AgentSessions and remote protocol peers behind one
 * roster and one model-facing messaging surface.
 */
export class AgentTeam implements TeamPort {
  readonly id: string
  private readonly maxMembers: number
  private readonly maxMessageBytes: number
  private readonly maxLinkedResultBytes: number
  private readonly maxMessages: number
  private readonly maxMailboxBytes: number
  private readonly maxMetadataBytes: number
  private readonly disposeTimeoutMs: number
  private readonly operationTimeoutMs: number
  private readonly observerTimeoutMs: number
  private readonly onEvent: ((event: AgentTeamEvent) => void) | undefined
  private readonly onAgentEvent: AgentTeamOptions['onAgentEvent']
  private readonly roster = new Map<string, LocalMemberRuntime>()
  private readonly links = new Map<string, RemoteMemberRuntime>()
  private readonly mailbox: AgentMessageRecord[] = []
  private mailboxBytes = 0
  private pendingMessages = 0
  private pendingMailboxBytes = 0
  private readonly lifecycle = new AbortController()
  private disposed = false
  private disposeTask: Promise<void> | undefined

  constructor(options: AgentTeamOptions = {}) {
    this.id = boundedString(options.id ?? newTeamId(), 'team id', 1024)
    this.maxMembers = positiveInteger(options.maxMembers ?? 8, 'maxMembers')
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes ?? 64 * 1024, 'maxMessageBytes')
    this.maxLinkedResultBytes = positiveInteger(
      options.maxLinkedResultBytes ?? 1024 * 1024,
      'maxLinkedResultBytes',
    )
    this.maxMessages = positiveInteger(options.maxMessages ?? 10_000, 'maxMessages')
    this.maxMailboxBytes = positiveInteger(options.maxMailboxBytes ?? 64 * 1024 * 1024, 'maxMailboxBytes')
    this.maxMetadataBytes = positiveInteger(options.maxMetadataBytes ?? 8 * 1024, 'maxMetadataBytes')
    this.disposeTimeoutMs = positiveInteger(options.disposeTimeoutMs ?? 30_000, 'disposeTimeoutMs')
    this.operationTimeoutMs = positiveInteger(options.operationTimeoutMs ?? 10 * 60_000, 'operationTimeoutMs')
    this.observerTimeoutMs = positiveInteger(options.observerTimeoutMs ?? 1_000, 'observerTimeoutMs')
    this.onEvent = options.onEvent
    this.onAgentEvent = options.onAgentEvent
  }

  /** Called by AgentSession after its tool catalog is assembled. */
  attach(session: TeamSessionPort, options: TeamMemberAttachmentOptions = {}): void {
    this.assertActive()
    const name = memberName(options.name ?? session.definition.id)
    this.assertAddressAvailable(name)
    this.assertCapacity()
    const role = options.role ?? (this.roster.size === 0 ? 'lead' : 'peer')
    if (role === 'lead' && [...this.roster.values()].some(member => member.role === 'lead')) {
      throw new Error(`A2A team '${this.id}' already has a lead`)
    }
    const member: LocalMemberRuntime = {
      kind: 'local', name, role, session,
      wakeRequestedSeq: 0, wakeConsumedSeq: 0,
      wakeTask: undefined, wakeController: undefined, error: undefined,
      ...(options.description === undefined ? {} : {
        description: boundedString(options.description, 'member description', this.maxMetadataBytes),
      }),
      ...(options.instructions === undefined ? {} : {
        instructions: boundedString(options.instructions, 'member instructions', this.maxMetadataBytes),
      }),
    }
    this.roster.set(name, member)
    this.emit({ type: 'member-attached', member: this.view(member) })
  }

  /** Link one remote transport, including an official A2A protocol client. */
  linkAgent(options: LinkAgentOptions): () => void {
    this.assertActive()
    const name = memberName(options.name)
    this.assertAddressAvailable(name)
    this.assertCapacity()
    if (typeof options.transport?.send !== 'function') {
      throw new TypeError('linked agent transport must implement send()')
    }
    const member: RemoteMemberRuntime = {
      kind: 'remote', name, role: 'peer', transport: options.transport,
      tail: Promise.resolve(), pending: 0, controllers: new Set(), error: undefined,
      ...(options.description === undefined ? {} : {
        description: boundedString(options.description, 'linked agent description', this.maxMetadataBytes),
      }),
    }
    this.links.set(name, member)
    this.emit({ type: 'member-linked', member: this.view(member) })
    return () => {
      if (this.links.get(name) !== member) return
      if (member.pending > 0) throw new Error(`cannot unlink running A2A member '${name}'`)
      this.links.delete(name)
    }
  }

  /** Remove exactly one idle local session registration. */
  detach(name: string): void {
    this.assertActive()
    const member = this.requireLocalMember(name)
    if (member.session.isRunning || member.wakeTask !== undefined) {
      throw new Error(`cannot detach running A2A member '${member.name}'`)
    }
    this.roster.delete(member.name)
  }

  /** Current detached roster: local members first, then remote links. */
  members(): readonly AgentTeamMember[] {
    return Object.freeze([
      ...this.roster.values(),
      ...this.links.values(),
    ].map(member => this.view(member)))
  }

  /** Immutable audit log. Local target history remains its resumable receipt. */
  messages(): readonly AgentMessageRecord[] {
    return deepCloneFreeze(this.mailbox)
  }

  /** Deliver to a local mailbox or dispatch through a linked remote transport. */
  async sendMessage(request: SendAgentMessageRequest): Promise<SendAgentMessageResult> {
    this.assertActive()
    request.signal?.throwIfAborted()
    const sender = this.requireLocalMember(request.from)
    const target = this.requireAddress(request.target)
    if (target.kind === 'local' && sender === target) throw new Error('an A2A member cannot message itself')
    const delivery = request.delivery ?? 'quiet'
    if (delivery !== 'quiet' && delivery !== 'wakeup') {
      throw new TypeError("A2A delivery must be 'quiet' or 'wakeup'")
    }
    if (target.kind === 'remote' && delivery === 'quiet') {
      throw new Error(
        `remote A2A member '${target.name}' cannot accept quiet injection; use followup_task or delivery 'wakeup'`,
      )
    }
    const id = newMessageId()
    const content = messageContent(request.message, this.maxMessageBytes)
    const framed = deepCloneFreeze([
      { type: 'text' as const, text: `A2A message ${id} from ${sender.name}:` },
      ...content,
    ])
    const contentBytes = byteLength(framed)
    if (contentBytes > this.maxMessageBytes) {
      throw new Error(`A2A message exceeds the ${this.maxMessageBytes}-byte limit`)
    }
    const reservedBytes = target.kind === 'remote'
      ? contentBytes + this.maxLinkedResultBytes
      : contentBytes
    const releaseReservation = this.reserveMailbox(reservedBytes)

    let result: LinkedAgentResult | undefined
    try {
      if (target.kind === 'local') {
        const message = createUserMessage({
          source: {
            kind: 'agent-message' as const,
            teamId: this.id, messageId: id, sender: sender.name,
            senderAgentId: sender.session.definition.id,
          },
          content: framed,
        })
        const seq = target.session.inject(message)
        if (delivery === 'wakeup') this.scheduleWake(target, seq)
      } else {
        result = await this.dispatchRemote(target, {
          teamId: this.id, messageId: id, sender: sender.name,
          senderAgentId: sender.session.definition.id, content: framed,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
      }

      const record: AgentMessageRecord = deepCloneFreeze({
        id, teamId: this.id, sender: sender.name,
        senderAgentId: sender.session.definition.id,
        target: target.name,
        targetAgentId: target.kind === 'local'
          ? target.session.definition.id
          : target.transport.agentId,
        delivery, content: framed, status: 'accepted' as const,
        createdAt: new Date().toISOString(),
        ...(result === undefined ? {} : { result }),
      })
      const retainedBytes = contentBytes + (result === undefined ? 0 : byteLength(result))
      this.mailbox.push(record)
      this.mailboxBytes += retainedBytes
      this.emit({ type: 'message-accepted', message: deepCloneFreeze(record) })
      return deepCloneFreeze({
        messageId: id, status: 'accepted' as const, delivery, target: target.name,
        ...(result === undefined ? {} : { result }),
      })
    } finally {
      releaseReservation()
    }
  }

  /** Wake-up alias used by hosts and model tools. */
  followup(
    from: string,
    target: string,
    message: string | readonly ContentBlock[],
    signal?: AbortSignal,
  ): Promise<SendAgentMessageResult> {
    return this.sendMessage({
      from, target, message, delivery: 'wakeup',
      ...(signal === undefined ? {} : { signal }),
    })
  }

  /** Wait until all local wake-up work or remote dispatches settle. */
  async whenIdle(name: string, signal?: AbortSignal): Promise<void> {
    const member = this.requireAddress(name)
    if (member.kind === 'remote') {
      await abortable(member.tail, signal)
      return
    }
    while (true) {
      const requested = member.wakeRequestedSeq
      const task = member.wakeTask
      if (task !== undefined) await abortable(task, signal)
      await member.session.whenIdle(signal)
      if (member.wakeTask === undefined && !member.session.isRunning
        && member.wakeConsumedSeq >= member.wakeRequestedSeq
        && requested === member.wakeRequestedSeq) return
    }
  }

  /** Cancel team-owned scheduled work for one member without mutating its history. */
  async cancel(name: string, reason: unknown = new Error('A2A member work cancelled')): Promise<void> {
    const member = this.requireAddress(name)
    if (member.kind === 'remote') {
      for (const controller of member.controllers) controller.abort(reason)
      await withTimeout(
        member.tail,
        this.disposeTimeoutMs,
        `A2A member '${member.name}' did not cancel within ${this.disposeTimeoutMs}ms`,
      )
      return
    }
    member.wakeConsumedSeq = member.wakeRequestedSeq
    const controller = member.wakeController
    const task = member.wakeTask
    controller?.abort(reason)
    try {
      if (task !== undefined) {
        await withTimeout(
          task,
          this.disposeTimeoutMs,
          `A2A member '${member.name}' did not cancel within ${this.disposeTimeoutMs}ms`,
        )
      }
    } catch (error: unknown) {
      if (controller?.signal.aborted !== true) throw error
    }
  }

  /** Permanently close this control plane and cancel every team-owned operation. */
  dispose(reason: unknown = new Error('A2A team disposed')): Promise<void> {
    if (this.disposeTask !== undefined) return this.disposeTask
    this.disposed = true
    this.lifecycle.abort(reason)
    const settling = Promise.allSettled([
      ...[...this.roster.values()].map(member => this.cancel(member.name, reason)),
      ...[...this.links.values()].map(member => this.cancel(member.name, reason)),
    ]).then(results => {
      this.roster.clear()
      this.links.clear()
      this.emit({ type: 'team-disposed', teamId: this.id })
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure !== undefined) {
        throw new Error(
          `A2A team '${this.id}' did not dispose within ${this.disposeTimeoutMs}ms`,
          { cause: failure.reason },
        )
      }
    })
    this.disposeTask = withTimeout(
      settling,
      this.disposeTimeoutMs,
      `A2A team '${this.id}' did not dispose within ${this.disposeTimeoutMs}ms`,
    )
    return this.disposeTask
  }

  /** Model-facing tools bound to one immutable local sender identity. */
  toolsFor(sender: string): readonly ToolDefinition<any>[] {
    this.assertActive()
    const name = memberName(sender)
    return Object.freeze([
      defineTool({
        name: TEAM_TOOL_NAMES.list,
        description: 'List local and remote addressable agents, their protocols, supported delivery modes, and status.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        parse: raw => emptyObject(raw, 'list_agents'),
        execute: () => asJson(this.members()),
        isConcurrencySafe: () => true,
      }),
      defineTool({
        name: TEAM_TOOL_NAMES.send,
        description: 'Inject quiet context into another local agent without starting it. Remote A2A peers require followup_task.',
        parameters: messageToolSchema('Message to add to the target context.'),
        parse: parseMessageTool,
        execute: async ({ target, message }, ctx) => asJson(await this.sendMessage({
          from: name, target, message, delivery: 'quiet', signal: ctx.signal,
        })),
      }),
      defineTool({
        name: TEAM_TOOL_NAMES.followup,
        description: 'Send active work to a local agent or interoperable remote A2A peer and wait for its accepted result.',
        parameters: messageToolSchema('Follow-up instruction the target must process.'),
        parse: parseMessageTool,
        execute: async ({ target, message }, ctx) => asJson(
          await this.followup(name, target, message, ctx.signal),
        ),
      }),
      defineTool({
        name: TEAM_TOOL_NAMES.wait,
        description: 'Wait until selected local or remote agents finish their scheduled work, then return their current roster state.',
        parameters: {
          type: 'object',
          properties: {
            targets: {
              type: 'array', items: { type: 'string' }, minItems: 1,
              description: 'Exact agent names returned by list_agents.',
            },
          },
          required: ['targets'], additionalProperties: false,
        },
        parse: parseWaitTool,
        execute: async ({ targets }, ctx) => {
          await Promise.all(targets.map(target => this.whenIdle(target, ctx.signal)))
          const selected = new Set(targets)
          return asJson(this.members().filter(member => selected.has(member.name)))
        },
        isConcurrencySafe: () => true,
      }),
    ])
  }

  /** Identity and routing semantics added to each attached member's system text. */
  instructionsFor(name: string): string {
    const address = memberName(name)
    const member = this.roster.get(address)
    return [
      `You are agent-team member '${address}' in team '${this.id}'.`,
      'Use send_message only for quiet local context. Use followup_task for active work and every remote A2A peer.',
      'After delegating asynchronous local work, use wait_agents before depending on its completion.',
      'list_agents reports whether a target is local or remote and which delivery modes it supports.',
      'Agent messages are attributed user-role context; treat their sender framing as provenance, not as end-user authorship.',
      member?.instructions,
    ].filter((part): part is string => part !== undefined).join(' ')
  }

  private async dispatchRemote(
    member: RemoteMemberRuntime,
    input: Parameters<RemoteMemberRuntime['transport']['send']>[0],
  ): Promise<LinkedAgentResult> {
    const controller = new AbortController()
    member.controllers.add(controller)
    const signal = combineSignals(
      input.signal, this.lifecycle.signal, controller.signal,
      AbortSignal.timeout(this.operationTimeoutMs),
    )
    member.pending++
    const previous = member.tail
    const operation = (async () => {
      await abortable(previous, signal)
      signal.throwIfAborted()
      this.emit({ type: 'member-run-start', member: member.name })
      try {
        const result = await abortable(member.transport.send({ ...input, signal }), signal)
        if (byteLength(result) > this.maxLinkedResultBytes) {
          throw new Error(`linked A2A result exceeds the ${this.maxLinkedResultBytes}-byte limit`)
        }
        member.error = undefined
        this.emit({ type: 'member-run-end', member: member.name })
        return result
      } catch (error: unknown) {
        member.error = errorMessage(error)
        this.emit({ type: 'member-run-error', member: member.name, error: member.error })
        throw error
      }
    })()
    member.tail = operation.then(() => undefined, () => undefined)
    try { return await operation } finally {
      member.pending--
      member.controllers.delete(controller)
    }
  }

  private scheduleWake(member: LocalMemberRuntime, seq: number): void {
    this.assertActive()
    member.wakeRequestedSeq = Math.max(member.wakeRequestedSeq, seq)
    if (member.wakeTask !== undefined) return
    const controller = new AbortController()
    member.wakeController = controller
    const signal = combineSignals(
      this.lifecycle.signal, controller.signal, AbortSignal.timeout(this.operationTimeoutMs),
    )
    const task = this.runWakeLoop(member, signal).finally(() => {
      if (member.wakeTask === task) member.wakeTask = undefined
      if (member.wakeController === controller) member.wakeController = undefined
      if (member.wakeConsumedSeq < member.wakeRequestedSeq) {
        this.scheduleWake(member, member.wakeRequestedSeq)
      }
    })
    member.wakeTask = task
  }

  private async runWakeLoop(member: LocalMemberRuntime, signal: AbortSignal): Promise<void> {
    let cancellationReported = false
    try {
      while (member.wakeConsumedSeq < member.wakeRequestedSeq) {
        signal.throwIfAborted()
        await member.session.whenIdle(signal)
        const through = member.wakeRequestedSeq
        this.emit({ type: 'member-run-start', member: member.name })
        try {
          await member.session.runPending({
            signal,
            onEvent: event => this.observeAgentEvent(member.name, event),
          })
          if (signal.aborted) {
            member.wakeConsumedSeq = through
            this.emit({ type: 'member-run-cancelled', member: member.name })
            cancellationReported = true
            continue
          }
          member.error = undefined
          member.wakeConsumedSeq = through
          this.emit({ type: 'member-run-end', member: member.name })
        } catch (error: unknown) {
          if (signal.aborted) {
            member.error = undefined
            member.wakeConsumedSeq = through
            this.emit({ type: 'member-run-cancelled', member: member.name })
            cancellationReported = true
            continue
          }
          if (member.session.isRunning) continue
          member.error = errorMessage(error)
          member.wakeConsumedSeq = through
          this.emit({ type: 'member-run-error', member: member.name, error: member.error })
        }
      }
    } catch (error: unknown) {
      if (!signal.aborted) throw error
      member.error = undefined
      member.wakeConsumedSeq = member.wakeRequestedSeq
      if (!cancellationReported) this.emit({ type: 'member-run-cancelled', member: member.name })
    }
  }

  private requireLocalMember(value: string): LocalMemberRuntime {
    const name = memberName(value)
    const member = this.roster.get(name)
    if (member === undefined) throw new Error(`unknown local A2A member '${name}'`)
    return member
  }

  private requireAddress(value: string): AddressableMember {
    const name = memberName(value)
    const member = this.roster.get(name) ?? this.links.get(name)
    if (member === undefined) throw new Error(`unknown A2A member '${name}'`)
    return member
  }

  private assertAddressAvailable(name: string): void {
    if (this.roster.has(name) || this.links.has(name)) {
      throw new Error(`A2A member '${name}' is already attached or linked`)
    }
  }

  private assertCapacity(): void {
    if (this.roster.size + this.links.size >= this.maxMembers) {
      throw new Error(`A2A team '${this.id}' reached its ${this.maxMembers}-member limit`)
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error(`A2A team '${this.id}' is disposed`)
  }

  private reserveMailbox(contentBytes: number): () => void {
    if (this.mailbox.length + this.pendingMessages >= this.maxMessages) {
      throw new Error(`A2A team '${this.id}' reached its ${this.maxMessages}-message mailbox limit`)
    }
    if (this.mailboxBytes + this.pendingMailboxBytes + contentBytes > this.maxMailboxBytes) {
      throw new Error(`A2A team '${this.id}' reached its ${this.maxMailboxBytes}-byte mailbox limit`)
    }
    this.pendingMessages++
    this.pendingMailboxBytes += contentBytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.pendingMessages--
      this.pendingMailboxBytes -= contentBytes
    }
  }

  private view(member: AddressableMember): AgentTeamMember {
    if (member.kind === 'remote') {
      return Object.freeze({
        name: member.name, agentId: member.transport.agentId, kind: 'remote' as const,
        role: member.role,
        status: member.error === undefined ? (member.pending > 0 ? 'running' : 'idle') : 'failed',
        protocol: member.transport.protocol,
        deliveries: Object.freeze(['wakeup'] as const),
        ...(member.description === undefined ? {} : { description: member.description }),
        ...(member.error === undefined ? {} : { error: member.error }),
      })
    }
    return Object.freeze({
      name: member.name, agentId: member.session.definition.id, kind: 'local' as const,
      conversationId: member.session.conversationId, role: member.role,
      status: member.error === undefined
        ? (member.session.isRunning || member.wakeTask !== undefined ? 'running' : 'idle')
        : 'failed',
      protocol: 'in-process', deliveries: Object.freeze(['quiet', 'wakeup'] as const),
      ...(member.description === undefined ? {} : { description: member.description }),
      ...(member.error === undefined ? {} : { error: member.error }),
    })
  }

  private emit(event: AgentTeamEvent): void {
    try { this.onEvent?.(event) } catch { /* observers do not own control-plane correctness */ }
  }

  private async observeAgentEvent(member: string, event: AgentRunEvent): Promise<void> {
    if (this.onAgentEvent === undefined) return
    const observer = Promise.resolve().then(() => this.onAgentEvent?.(member, event))
    await waitForSettlement(observer, this.observerTimeoutMs)
  }
}
