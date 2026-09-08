import type { AgentRunEvent } from '../mode/run-agent.ts'
import { defineTool, type ToolDefinition } from '../tool/definition.ts'
import type { ContentBlock } from '../../message/index.ts'
import { createUserMessage } from '../../message/index.ts'
import { waitForSettlement } from '../../async/index.ts'
import { AgentSdkError } from '../../errors/index.ts'
import { timeoutValue } from '../../platform/config.ts'
import type {
  TeamMemberAttachmentOptions, TeamPort, TeamSessionPort, TeamToolAccess,
} from './contracts.ts'
import type {
  AgentMemberOutcome, AgentMessageRecord, AgentTeamEvent, AgentTeamMember, AgentTeamOptions,
  LinkAgentOptions, LinkedAgentResult, SendAgentMessageRequest, SendAgentMessageResult,
} from './types.ts'
import {
  messageToolSchema, parseMessageTool, parseWaitTool, emptyObject, messageContent, memberName,
  boundedString, positiveInteger, byteLength, errorMessage, asJson, deepCloneFreeze, newTeamId,
  newMessageId, abortable, combineSignals, withTimeout, TEAM_TOOL_NAMES,
  DEFAULT_MIN_WAIT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
} from './common.ts'

/** Shared control plane for local sessions and interoperable remote A2A peers. */

interface LocalMemberRuntime {
  readonly kind: 'local'
  readonly name: string
  readonly description?: string
  readonly instructions?: string
  readonly role: 'lead' | 'peer'
  /** Which team verbs it was attached with; shapes its routing guidance. */
  readonly access: TeamToolAccess
  readonly session: TeamSessionPort
  wakeRequestedSeq: number
  wakeConsumedSeq: number
  wakeTask: Promise<void> | undefined
  wakeController: AbortController | undefined
  error: string | undefined
  /** How its last run ended, for a coordinator that did not await the run. */
  outcome: AgentMemberOutcome | undefined
  /**
   * Set while the host is holding this member back, and resolved when it lets
   * it start. See {@link AgentTeam.markPending}.
   */
  pendingStart: Promise<void> | undefined
  /**
   * Aborted when the user steers something into this member mid-turn.
   *
   * A member parked in `wait_agents` is not listening to its own conversation:
   * the wait is bounded by its own budget, so a correction typed while it waits
   * sits unread for as long as that budget lasts. Codex's `wait_agent` "ends
   * early when new user input is steered into the active turn" for the same
   * reason. Replaced after each notification, so one interruption ends one
   * wait.
   */
  steerController: AbortController | undefined
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
  private readonly waitTimeoutMs: number
  private readonly minWaitTimeoutMs: number
  private onEvent: ((event: AgentTeamEvent) => void) | undefined
  private onAgentEvent: AgentTeamOptions['onAgentEvent']
  private readonly roster = new Map<string, LocalMemberRuntime>()
  private readonly links = new Map<string, RemoteMemberRuntime>()
  private readonly mailbox: AgentMessageRecord[] = []
  private mailboxBytes = 0
  private pendingMessages = 0
  private pendingMailboxBytes = 0
  private readonly lifecycle = new AbortController()
  private readonly waitEdges = new Map<string, Map<string, number>>()
  private disposed = false
  private disposeTask: Promise<void> | undefined

  constructor(
    options: AgentTeamOptions = {},
    private readonly ownRemoteTask?: (signal: AbortSignal) => () => void,
  ) {
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
    this.disposeTimeoutMs = timeoutValue(options.disposeTimeoutMs ?? 30_000)
    this.operationTimeoutMs = timeoutValue(options.operationTimeoutMs ?? 10 * 60_000)
    this.observerTimeoutMs = timeoutValue(options.observerTimeoutMs ?? 1_000)
    this.waitTimeoutMs = timeoutValue(options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    // A floor above the ceiling would clamp every call up to a budget the host
    // said was too long; the host's own maximum wins.
    this.minWaitTimeoutMs = Math.min(
      timeoutValue(options.minWaitTimeoutMs ?? DEFAULT_MIN_WAIT_TIMEOUT_MS),
      this.waitTimeoutMs,
    )
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
    const access: TeamToolAccess = options.tools === 'reporting' ? 'reporting' : 'full'
    const member: LocalMemberRuntime = {
      kind: 'local', name, role, access, session,
      wakeRequestedSeq: 0, wakeConsumedSeq: 0,
      wakeTask: undefined, wakeController: undefined, error: undefined, outcome: undefined,
      pendingStart: undefined, steerController: undefined,
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
      while (true) {
        const tail = member.tail
        await abortable(tail, signal)
        if (tail === member.tail && member.pending === 0) break
      }
      return
    }
    while (true) {
      const requested = member.wakeRequestedSeq
      const task = member.wakeTask
      // A member the host is holding back has not finished; it has not begun.
      // Waiting on its session would be answered at once, and the waiter would
      // read that as work completed.
      const held = member.pendingStart
      if (held !== undefined) await abortable(held, signal)
      if (task !== undefined) await abortable(task, signal)
      await member.session.whenIdle(signal)
      if (member.wakeTask === undefined && !member.session.isRunning
        && member.pendingStart === undefined
        && member.wakeConsumedSeq >= member.wakeRequestedSeq
        && requested === member.wakeRequestedSeq) return
    }
  }

  /**
   * Report that the user steered something into a local member mid-turn.
   *
   * Ends whatever that member is currently waiting on. A member parked in
   * `wait_agents` would otherwise finish its budget before reading a correction
   * that has been sitting in its history the whole time; Codex ends its
   * `wait_agent` early on steered input for the same reason.
   * @param name - Local member address.
   */
  notifySteer(name: string): void {
    const member = this.requireLocalMember(name)
    const controller = member.steerController
    member.steerController = undefined
    controller?.abort(new Error('user input steered into the active turn'))
  }

  /**
   * Schedule one turn for a local member over context it already has.
   *
   * A wake-up delivery carries a message; this carries nothing. It exists for
   * the case where the context arrived earlier and quietly — appended to a
   * member that was mid-turn, on the assumption its next model round would read
   * it — and that round never came. Without this the message sits in history
   * with nothing left to read it.
   * @param name - Local member address.
   */
  wake(name: string): void {
    const member = this.requireLocalMember(name)
    this.scheduleWake(member, member.wakeRequestedSeq + 1)
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
        'TEAM_CANCELLATION_TIMEOUT',
      )
      return
    }
    member.wakeConsumedSeq = member.wakeRequestedSeq
    const controller = member.wakeController
    const task = member.wakeTask
    controller?.abort(reason)
    if (task !== undefined) {
      await withTimeout(
        task,
        this.disposeTimeoutMs,
        `A2A member '${member.name}' did not cancel within ${this.disposeTimeoutMs}ms`,
        'TEAM_CANCELLATION_TIMEOUT',
      )
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
      this.mailbox.length = 0
      this.mailboxBytes = 0
      this.waitEdges.clear()
      this.onEvent = undefined
      this.onAgentEvent = undefined
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure !== undefined) {
        throw new AgentSdkError(
          `A2A team '${this.id}' did not dispose within ${this.disposeTimeoutMs}ms`,
          'TEAM_DISPOSE_TIMEOUT',
          { cause: failure.reason },
        )
      }
    })
    this.disposeTask = withTimeout(
      settling,
      this.disposeTimeoutMs,
      `A2A team '${this.id}' did not dispose within ${this.disposeTimeoutMs}ms`,
      'TEAM_DISPOSE_TIMEOUT',
    )
    return this.disposeTask
  }

  /** Model-facing tools bound to one immutable local sender identity. */
  toolsFor(sender: string, access: TeamToolAccess = 'full'): readonly ToolDefinition<any>[] {
    this.assertActive()
    const name = memberName(sender)
    // Called before `attach`, so the access level arrives as an argument
    // rather than being looked up on the member that does not exist yet.
    const coordinating = access === 'full'
    // Coordination is not exploration. A lead that has spent its tool budget
    // still has to be able to hand the work over and collect it; blocking
    // these is what strands a team run with finished members and no report.
    return Object.freeze([
      defineTool({
        name: TEAM_TOOL_NAMES.list,
        budgetExempt: true,
        description: 'List local and remote addressable agents, their protocols, supported delivery modes, and status.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        parse: raw => emptyObject(raw, 'list_agents'),
        execute: () => asJson(this.members()),
        isConcurrencySafe: () => true,
      }),
      defineTool({
        name: TEAM_TOOL_NAMES.send,
        budgetExempt: true,
        description: 'Inject quiet context into ANOTHER local agent without starting it.'
          + ' Name a target from list_agents other than yourself; your own result already'
          + ' goes back to whoever started you, so reporting does not need this tool.'
          + ' Remote A2A peers require followup_task.',
        parameters: messageToolSchema('Message to add to the target context.'),
        parse: parseMessageTool,
        execute: async ({ target, message }, ctx) => asJson(await this.sendMessage({
          from: name, target, message, delivery: 'quiet', signal: ctx.signal,
        })),
      }),
      ...!coordinating ? [] : [defineTool({
        name: TEAM_TOOL_NAMES.followup,
        budgetExempt: true,
        description: 'Send active work to a local agent or interoperable remote A2A peer and wait for its accepted result.',
        parameters: messageToolSchema('Follow-up instruction the target must process.'),
        parse: parseMessageTool,
        execute: async ({ target, message }, ctx) => asJson(
          await this.followup(name, target, message, ctx.signal),
        ),
      })],
      ...!coordinating ? [] : [defineTool({
        name: TEAM_TOOL_NAMES.wait,
        budgetExempt: true,
        description: 'Wait until one of the selected local or remote agents finishes its scheduled'
          + ' work, then return their current roster state. Returns early with interrupted=true when'
          + ' the user sends you something while you wait, so read that before waiting again.',
        parameters: {
          type: 'object',
          properties: {
            targets: {
              type: 'array', items: { type: 'string' }, minItems: 1,
              description: 'Exact agent names returned by list_agents.',
            },
            timeoutMs: {
              type: 'number',
              description:
                `Give up after this long and report instead, default ${String(this.waitTimeoutMs)}.`
                + ` Anything under ${String(this.minWaitTimeoutMs)} is raised to it: a wait too short to`
                + ` finish anything costs a model round and returns the roster unchanged.`,
            },
          },
          required: ['targets'], additionalProperties: false,
        },
        parse: parseWaitTool,
        execute: async ({ targets, timeoutMs }, ctx) => {
          const release = this.beginWait(name, targets)
          const budget = timeoutMs === undefined
            ? this.waitTimeoutMs
            : Math.min(
              Math.max(timeoutValue(timeoutMs), this.minWaitTimeoutMs),
              this.waitTimeoutMs,
            )
          try {
            // Returns as soon as the FIRST target settles, and always within
            // the budget. Waiting for all of them, forever, is what turned one
            // slow agent into a window that looked hung: a coordinator that
            // gets the roster back can decide for itself whether to wait again.
            //
            // The budget is enforced HERE rather than only by handing members a
            // deadline signal: a member that does not honour the signal would
            // otherwise hold the wait open past its own timeout, and a timeout
            // a callee can ignore is not a timeout.
            // A wait that cannot be interrupted is a wait the user cannot
            // correct: the caller is parked here, so its own new input has
            // nothing else to end it before the budget runs out.
            const steer = new AbortController()
            const caller = this.roster.get(memberName(sender))
            if (caller !== undefined) caller.steerController = steer
            const signal = combineSignals(ctx.signal, AbortSignal.timeout(budget), steer.signal)
            let timer: ReturnType<typeof setTimeout> | undefined
            const expiry = new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), budget)
            })
            const interrupted = new Promise<undefined>((resolve) => {
              steer.signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
            })
            const settled = await Promise.race([
              Promise.any(targets.map(async (target) => {
                await this.whenIdle(target, signal)
                return target
              })).then(target => target, () => undefined),
              expiry,
              interrupted,
            ]).finally(() => {
              clearTimeout(timer)
              if (caller?.steerController === steer) caller.steerController = undefined
            })
            // The caller's own cancellation still wins; a steer does not.
            ctx.signal.throwIfAborted()
            if (steer.signal.aborted) {
              return asJson({
                agents: this.members().filter(member => new Set(targets).has(member.name)),
                settled: null,
                timedOut: false,
                interrupted: true,
                waitedMs: budget,
              })
            }
            const selected = new Set(targets)
            return asJson({
              agents: this.members().filter(member => selected.has(member.name)),
              settled: settled ?? null,
              timedOut: settled === undefined,
              // The budget actually used, which is not always the one asked
              // for: a lead that reads `timedOut` after a request below the
              // floor would otherwise misjudge how long its workers had.
              waitedMs: budget,
            })
          } finally { release() }
        },
        isConcurrencySafe: () => true,
      })],
    ])
  }

  /** Identity and routing semantics added to each attached member's system text. */
  instructionsFor(name: string): string {
    const address = memberName(name)
    const member = this.roster.get(address)
    // Guidance follows the tools the member actually has. Advertising
    // followup_task and wait_agents to a reporting member would send it looking
    // for verbs it was deliberately not given, and describe a coordinating role
    // it does not hold.
    const coordinating = member === undefined || member.access === 'full'
    return [
      `You are agent-team member '${address}' in team '${this.id}'.`,
      coordinating
        ? 'Use send_message only for quiet local context. Use followup_task for active work and every remote A2A peer.'
        : 'Use send_message to report context to another agent. You cannot delegate work or wait for other agents:'
          + ' finish your own task and return its result, even when you would rather ask first.',
      ...coordinating
        ? ['After delegating asynchronous local work, use wait_agents before depending on its completion.']
        : [],
      'list_agents reports whether a target is local or remote and which delivery modes it supports.',
      'Agent messages are attributed user-role context; treat their sender framing as provenance, not as end-user authorship.',
      member?.instructions,
    ].filter((part): part is string => part !== undefined).join(' ')
  }

  private async dispatchRemote(
    member: RemoteMemberRuntime,
    input: Parameters<RemoteMemberRuntime['transport']['send']>[0],
  ): Promise<LinkedAgentResult> {
    if (member.pending >= this.maxMessages) {
      throw new AgentSdkError('Remote member has too many unsettled sends', 'TEAM_REMOTE_PENDING_LIMIT')
    }
    const controller = new AbortController()
    const signal = combineSignals(
      input.signal, this.lifecycle.signal, controller.signal,
      AbortSignal.timeout(this.operationTimeoutMs),
    )
    signal.throwIfAborted()
    const releaseOwnership = this.ownRemoteTask?.(signal)
    member.controllers.add(controller)
    member.pending++
    const previous = member.tail
    const operation = (async () => {
      // The serial tail represents physical callback settlement, not the
      // abortable public wait. A cancelled queued request skips dispatch once
      // its predecessor actually releases ownership.
      await previous
      signal.throwIfAborted()
      this.emit({ type: 'member-run-start', member: member.name })
      try {
        const result = await member.transport.send({ ...input, signal })
        signal.throwIfAborted()
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
    })().finally(() => {
      member.pending--
      member.controllers.delete(controller)
      releaseOwnership?.()
    })
    member.tail = operation.then(() => undefined, () => undefined)
    return await abortable(operation, signal)
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
          const response = await member.session.runPending({
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
          // Recorded so a coordinator can read the member's answer from the
          // roster. `runPending` hands it to whoever awaited the run, and with
          // a wake-up delivery that is nobody.
          member.outcome = { kind: 'completed', text: responseText(response) }
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
          member.outcome = { kind: 'failed', message: member.error }
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

  /**
   * Record that `sender` is blocked until `targets` are idle.
   *
   * The `wait_agents` tool calls this, and so must any HOST that blocks one
   * member on another. An unrecorded edge is invisible here, which is worse
   * than having no detection at all: the cycle it completes gets waved through,
   * and both sides then wait for each other until a timeout expires.
   *
   * `spawn_agent` used to be such a host — it awaited the worker it created —
   * and needed an edge declared for it. It no longer waits, so the cycle it
   * could close no longer exists.
   * @param sender - The member that will block.
   * @param targets - Members it is waiting for.
   * @returns A release; call it when the wait ends, however it ends.
   * @throws `TEAM_WAIT_CYCLE` when the wait would close a cycle.
   */
  beginWait(sender: string, targets: readonly string[]): () => void {
    for (const target of targets) {
      this.requireAddress(target)
      if (target === sender || this.hasWaitPath(target, sender, new Set())) {
        throw new AgentSdkError('wait_agents would create a coordination cycle', 'TEAM_WAIT_CYCLE')
      }
    }
    let outgoing = this.waitEdges.get(sender)
    if (outgoing === undefined) {
      outgoing = new Map()
      this.waitEdges.set(sender, outgoing)
    }
    for (const target of targets) outgoing.set(target, (outgoing.get(target) ?? 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      const edges = this.waitEdges.get(sender)
      if (edges === undefined) return
      for (const target of targets) {
        const count = edges.get(target) ?? 0
        if (count <= 1) edges.delete(target); else edges.set(target, count - 1)
      }
      if (edges.size === 0) this.waitEdges.delete(sender)
    }
  }

  private hasWaitPath(from: string, target: string, visited: Set<string>): boolean {
    if (from === target) return true
    if (visited.has(from)) return false
    visited.add(from)
    for (const next of this.waitEdges.get(from)?.keys() ?? []) {
      if (this.hasWaitPath(next, target, visited)) return true
    }
    return false
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

  /**
   * Record how a member's run ended.
   *
   * For a host that starts a member's run itself and therefore owns the result
   * the member's own bookkeeping never sees — `spawn_agent` running a worker
   * concurrently. Without this the roster could report that a worker had
   * stopped but not what it concluded, which is the whole point of asking.
   * @param name - Member address.
   * @param outcome - How the run ended.
   */
  recordOutcome(name: string, outcome: AgentMemberOutcome): void {
    const member = this.requireLocalMember(name)
    member.outcome = outcome
    member.error = outcome.kind === 'failed' ? outcome.message : undefined
  }

  /**
   * Declare that a member exists but has deliberately not been started.
   *
   * A host that orders work — starting one member only once another has
   * finished — needs the roster to say so, and `wait_agents` to believe it. A
   * member whose session has never run looks exactly like one that has
   * finished: idle, not running, nothing outstanding. A coordinator told that
   * would wait on it, be answered at once, read no outcome, and conclude the
   * work was done.
   *
   * The promise is what `whenIdle` waits on, so the pending state cannot be a
   * flag that a waiter has to poll.
   * @param name - Local member address.
   * @param until - Resolves when the host starts it; undefined clears the state.
   */
  markPending(name: string, until: Promise<void> | undefined): void {
    this.requireLocalMember(name).pendingStart = until
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
      status: member.error !== undefined
        ? 'failed'
        : member.pendingStart !== undefined
          ? 'pending'
          : member.session.isRunning || member.wakeTask !== undefined ? 'running' : 'idle',
      protocol: 'in-process', deliveries: Object.freeze(['quiet', 'wakeup'] as const),
      ...(member.description === undefined ? {} : { description: member.description }),
      ...(member.error === undefined ? {} : { error: member.error }),
      ...(member.outcome === undefined ? {} : { outcome: member.outcome }),
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

/**
 * The answer text out of a run result.
 *
 * `TeamSessionPort.runPending` returns `unknown` on purpose — the port exists so
 * the control plane does not depend on the concrete session — so the one field
 * needed here is read structurally.
 * @param response - Whatever the member's run resolved with.
 * @returns Its text, or the empty string.
 */
function responseText(response: unknown): string {
  const text = (response as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text : ''
}
