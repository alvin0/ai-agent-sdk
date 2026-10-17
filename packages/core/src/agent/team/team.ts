import { deliverProgressEvent, progressActivity, registerProgressChannel } from './team-progress-internal.ts'
import { TeamObservation, type TeamSettlementUsage } from './team-observation.ts'
import { registerTeamObservation } from './team-observation-internal.ts'
import type { TeamSnapshot, TeamWakeReason } from './team-timeline.ts'
import { TeamResults } from './team-results.ts'
import { sendTeamMessage } from './team-delivery.ts'
import { teamInstructions } from './team-instructions.ts'
import { TeamWork } from './team-work.ts'
import { TeamRoster } from './team-roster.ts'
import { evictsOldest, TeamMailbox } from './team-mailbox.ts'
import { registerTeamInternals } from './team-internal.ts'
import type { LocalMemberRuntime, AddressableMember } from './team-runtime-types.ts'
import { teamTimeouts } from './team-support.ts'
import type { AgentRunEvent } from '../mode/run-agent.ts'
import { recordOutcome, markPending, observeAgentEvent } from './team-lifecycle.ts'
import { beginWait as beginTeamWait } from './team-coordination.ts'
import { dispatchRemote } from './team-remote.ts'
import { executeTeamWait } from './team-wait-operation.ts'
import type { ToolRunContext } from '../tool/definition.ts'
import { TeamTools } from './team-tools.ts'
import { type ToolDefinition } from '../tool/definition.ts'
import type { ContentBlock } from '../../message/index.ts'
import type {
  TeamMemberAttachmentOptions, TeamPort, TeamSessionPort, TeamToolAccess,
} from './contracts.ts'
import type {
  AgentMemberOutcome, AgentMessageRecord, AgentTeamEvent, AgentTeamMember, AgentTeamOptions,
  LinkAgentOptions, SendAgentMessageRequest, SendAgentMessageResult,
} from './types.ts'
import {
  boundedString, positiveInteger, newTeamId,
  DEFAULT_MIN_WAIT_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
} from './common.ts'
export class AgentTeam implements TeamPort {
  private readonly observation: TeamObservation
  readonly id: string
  private readonly maxMessageBytes: number
  private readonly maxLinkedResultBytes: number
  private readonly maxMessages: number
  private readonly disposeTimeoutMs: number
  private readonly operationTimeoutMs: number
  private readonly observerTimeoutMs: number
  private readonly waitTimeoutMs: number
  private readonly minWaitTimeoutMs: number
  private onEvent: ((event: AgentTeamEvent) => void) | undefined
  private onAgentEvent: AgentTeamOptions['onAgentEvent']
  private readonly roster: TeamRoster
  private readonly mailbox: TeamMailbox
  private readonly work: TeamWork
  private readonly waitEdges = new Map<string, Map<string, number>>()
  private readonly results = new TeamResults()
  private readonly waitGuards = new Set<(sender: string, targets: readonly string[]) => void>()
  private readonly wakeGuards = new Set<(target: string) => void>()
  private readonly listeners = new Set<(event: AgentTeamEvent) => void>()
  private readonly teamTools: TeamTools
  constructor(
    options: AgentTeamOptions = {},
    private readonly ownRemoteTask?: (signal: AbortSignal) => () => void,
  ) {
    this.id = boundedString(options.id ?? newTeamId(), 'team id', 1024)
    const maxMembers = positiveInteger(options.maxMembers ?? 8, 'maxMembers')
    this.maxMessageBytes = positiveInteger(options.maxMessageBytes ?? 64 * 1024, 'maxMessageBytes')
    this.maxLinkedResultBytes = positiveInteger(
      options.maxLinkedResultBytes ?? 1024 * 1024,
      'maxLinkedResultBytes',
    )
    this.maxMessages = positiveInteger(options.maxMessages ?? 10_000, 'maxMessages')
    const maxMailboxBytes = positiveInteger(options.maxMailboxBytes ?? 64 * 1024 * 1024, 'maxMailboxBytes')
    const maxMetadataBytes = positiveInteger(options.maxMetadataBytes ?? 8 * 1024, 'maxMetadataBytes')
    const timeouts = teamTimeouts(options, DEFAULT_WAIT_TIMEOUT_MS, DEFAULT_MIN_WAIT_TIMEOUT_MS)
    this.disposeTimeoutMs = timeouts.disposeTimeoutMs
    this.operationTimeoutMs = timeouts.operationTimeoutMs
    this.observerTimeoutMs = timeouts.observerTimeoutMs
    this.waitTimeoutMs = timeouts.waitTimeoutMs
    this.minWaitTimeoutMs = timeouts.minWaitTimeoutMs
    this.observation = new TeamObservation(this.id, event => this.emit(event),
      () => this.onEvent !== undefined || this.listeners.size > 0, options)
    registerTeamObservation(this, this.observation)
    registerTeamInternals(this, {
      guardWake: guard => this.guardWake(guard), guardWait: guard => this.guardWait(guard),
      takeResults: (sender, targets, maxBytes, settled) => this.takeResults(sender, targets, maxBytes, settled),
      captureResults: (sender, targets, retained) => this.captureResults(sender, targets, retained),
      waitForBatch: (sender, targets, whenIdle, ctx) => this.waitForBatch(sender, targets, whenIdle, ctx),
      releaseSlot: name => this.releaseSlot(name),
      resultDelivered: (recipient, member) => this.results.isDelivered(recipient, member),
    })
    this.onEvent = options.onEvent
    this.onAgentEvent = options.onAgentEvent
    this.roster = new TeamRoster({ id: this.id, maxMembers, maxMetadataBytes, emit: event => this.emit(event) })
    this.mailbox = new TeamMailbox(this.maxMessages, maxMailboxBytes, evictsOldest(options.mailboxOverflow))
    this.work = new TeamWork({
      id: this.id, disposeTimeoutMs: this.disposeTimeoutMs, operationTimeoutMs: this.operationTimeoutMs,
      localMembers: () => this.roster.locals.values(), remoteMembers: () => this.roster.remotes.values(),
      cancelMember: (name, reason) => this.cancel(name, reason), clear: () => this.clear(),
      emit: event => this.emit(event), observeAgentEvent: (member, event) => this.observeAgentEvent(member, event),
    })
    registerProgressChannel(this, { signal: this.work.signal, emit: event => this.emit(event) })
    this.teamTools = new TeamTools({
      waitTimeoutMs: this.waitTimeoutMs, minWaitTimeoutMs: this.minWaitTimeoutMs,
      assertActive: () => this.assertActive(), members: () => this.members(),
      retainedResult: target => this.results.retained(target),
      takeResults: (sender, targets, maxBytes) => this.takeResults(sender, targets, maxBytes),
      captureResults: (sender, targets) => this.captureResults(sender, targets),
      sendMessage: request => this.sendMessage(request),
      followup: (from, target, message, signal) => this.followup(from, target, message, signal),
      beginWait: (from, targets) => this.beginWait(from, targets),
      whenIdle: (name, signal) => this.whenIdle(name, signal), member: name => this.roster.locals.get(name),
    })
  }
  observeInvocation(member: string, signal: AbortSignal): void {
    progressActivity(this, { kind: 'invocation', member, signal })
  }
  attach(session: TeamSessionPort, options: TeamMemberAttachmentOptions = {}): void {
    this.assertActive()
    this.roster.attach(session, options)
    this.results.forget(options.name ?? session.definition.id)
  }
  linkAgent(options: LinkAgentOptions): () => void {
    this.assertActive()
    return this.roster.linkAgent(options)
  }
  detach(name: string): void {
    this.assertActive()
    const member = this.members().find(member => member.name === name)
    this.roster.detach(name)
    if (member !== undefined) this.results.archive(member)
    this.observation.record({ kind: 'member-closed', member: name })
  }
  /** Detached metadata summary; no prompt, message or worker result content. */
  snapshot(): TeamSnapshot { return this.observation.snapshot(this.members()) }
  members(): readonly AgentTeamMember[] { return this.roster.members() }
  private guardWake(guard: (target: string) => void): () => void {
    this.wakeGuards.add(guard)
    return () => { this.wakeGuards.delete(guard) }
  }
  /** Subscribe to runtime lifecycle events without replacing host hooks. */
  subscribe(listener: (event: AgentTeamEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private takeResults(sender: string, targets: readonly string[], maxBytes?: number,
    settled?: ReadonlyMap<string, AgentMemberOutcome>) {
    const members = this.results.select(this.members(), targets).map(member => {
      const outcome = settled?.get(member.name)
      // A captured settlement is delivered even if a queued follow-up already restarted the member.
      return outcome === undefined ? member : { ...member, status: 'idle' as const, outcome }
    })
    return this.results.take(sender, members, maxBytes)
  }
  private captureResults(sender: string, targets: readonly string[], retained = true) {
    return this.results.capture(sender, this.members(), targets, retained)
  }
  private releaseSlot(name: string): void {
    if (this.roster.releaseSlot(name)) this.observation.record({ kind: 'slot-released', member: name })
  }
  messages(): readonly AgentMessageRecord[] {
    return this.mailbox.messages()
  }
  async sendMessage(request: SendAgentMessageRequest): Promise<SendAgentMessageResult> {
    this.assertActive()
    if (request.delivery === 'wakeup') {
      for (const guard of this.wakeGuards) guard(request.target)
    }
    return sendTeamMessage(request, {
      teamId: this.id, maxMessageBytes: this.maxMessageBytes, maxLinkedResultBytes: this.maxLinkedResultBytes,
      mailbox: this.mailbox,
      requireLocalMember: name => this.requireLocalMember(name), requireAddress: name => this.requireAddress(name),
      scheduleWake: (member, seq) => this.scheduleWake(member, seq),
      dispatchRemote: (member, input) => dispatchRemote(member, input, this.remoteDispatchHost()),
      emit: event => this.emit(event),
    })
  }
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
  async whenIdle(name: string, signal?: AbortSignal): Promise<void> {
    return this.work.whenIdle(this.requireAddress(name), signal)
  }
  notifySteer(name: string): void {
    const member = this.requireLocalMember(name)
    this.observation.input(name)
    const controller = member.steerController
    member.steerController = undefined
    controller?.abort(new Error('user input steered into the active turn'))
  }
  wake(name: string, reason: TeamWakeReason = 'host'): void {
    for (const guard of this.wakeGuards) guard(name)
    const member = this.requireLocalMember(name)
    this.observation.wake(name, reason)
    this.scheduleWake(member, member.wakeRequestedSeq + 1)
  }
  async cancel(name: string, reason: unknown = new Error('A2A member work cancelled')): Promise<void> {
    return this.work.cancel(this.requireAddress(name), reason)
  }
  dispose(reason: unknown = new Error('A2A team disposed')): Promise<void> {
    return this.work.dispose(reason)
  }
  toolsFor(
    sender: string, access: TeamToolAccess = 'full', whenIdle = (target: string, signal?: AbortSignal) =>
      this.whenIdle(target, signal),
  ): readonly ToolDefinition<any>[] {
    return this.teamTools.toolsFor(sender, access, whenIdle)
  }
  instructionsFor(name: string): string { return teamInstructions(this.id, this.roster, name) }
  private remoteDispatchHost() {
    return { maxMessages: this.maxMessages, maxLinkedResultBytes: this.maxLinkedResultBytes,
      operationTimeoutMs: this.operationTimeoutMs, lifecycle: this.work.signal,
      ownRemoteTask: this.ownRemoteTask, emit: (event: AgentTeamEvent) => this.emit(event) }
  }

  private scheduleWake(member: LocalMemberRuntime, seq: number): void {
    this.roster.reserveSlot(member.name)
    this.work.scheduleWake(member, seq)
  }
  get messageByteLimit(): number { return this.maxMessageBytes }
  private requireLocalMember(value: string): LocalMemberRuntime {
    return this.roster.requireLocalMember(value)
  }
  private guardWait(guard: (sender: string, targets: readonly string[]) => void): () => void {
    this.waitGuards.add(guard)
    return () => { this.waitGuards.delete(guard) }
  }

  /** Managed independent batch barrier, including reserved addresses without sessions yet.
   * Its outer collector owns results; this barrier must not claim archived or current evidence. */
  private waitForBatch(sender: string, targets: readonly string[],
    whenIdle: (target: string, signal?: AbortSignal) => Promise<void>, ctx: ToolRunContext) {
    return executeTeamWait({
      waitTimeoutMs: this.waitTimeoutMs, minWaitTimeoutMs: this.minWaitTimeoutMs,
      assertActive: () => this.assertActive(), members: () => this.members(),
      retainedResult: target => this.results.retained(target),
      takeResults: (sender, targets, maxBytes) => this.takeResults(sender, targets, maxBytes),
      captureResults: sender => this.captureResults(sender, [], false),
      sendMessage: request => this.sendMessage(request),
      followup: (from, target, message, signal) => this.followup(from, target, message, signal),
      beginWait: () => () => {}, whenIdle, member: name => this.roster.locals.get(name),
    }, { name: sender, sender }, { targets }, ctx)
  }

  beginWait(sender: string, targets: readonly string[]): () => void {
    for (const guard of this.waitGuards) guard(sender, targets)
    return beginTeamWait(
      { waitEdges: this.waitEdges, requireAddress: name => this.requireAddress(name) }, sender, targets,
    )
  }
  private requireAddress(value: string): AddressableMember {
    return this.roster.requireAddress(value)
  }

  private assertActive(): void { this.work.assertActive() }

  recordOutcome(name: string, outcome: AgentMemberOutcome,
    report?: TeamSettlementUsage): void {
    recordOutcome(this.requireLocalMember(name), outcome)
    this.results.publish(this.members().map(member => member.name === name ? { ...member, status: 'idle' } : member))
    this.observation.outcome(name, outcome, report)
  }
  markPending(name: string, until: Promise<void> | undefined): void {
    markPending(this.requireLocalMember(name), until)
  }
  private clear(): void {
    this.roster.clear()
    this.emit({ type: 'team-disposed', teamId: this.id })
    this.mailbox.clear()
    this.waitEdges.clear()
    this.results.clear()
    this.listeners.clear()
    this.wakeGuards.clear()
    this.waitGuards.clear()
    this.observation.clear()
    this.onEvent = undefined
    this.onAgentEvent = undefined
  }
  private observeLifecycle(event: AgentTeamEvent): void {
    if (event.type === 'member-attached' || event.type === 'member-linked') this.observation.attach(event.member)
    if (event.type === 'message-accepted') {
      this.observation.input(event.message.target)
      this.observation.accepted(event.message.target, event.message.sender)
      if (event.message.delivery === 'wakeup') {
        this.observation.wake(event.message.target, 'message', event.message.sender)
      }
    }
  }
  private publishSettlement(event: AgentTeamEvent): void {
    if (event.type === 'member-run-end' || event.type === 'member-run-error'
      || event.type === 'member-run-cancelled') {
      const outcome: AgentMemberOutcome | undefined = event.type === 'member-run-cancelled'
        ? { kind: 'failed', status: 'cancelled', message: 'Member run cancelled' }
        : this.members().find(member => member.name === event.member)?.outcome
      this.results.publish(this.members())
      if (outcome !== undefined) this.observation.outcome(event.member, outcome,
        'response' in event ? (event.response as { report?: TeamSettlementUsage } | undefined)?.report : undefined)
    }
  }
  private emit(event: AgentTeamEvent): boolean {
    if (event.type === 'team-progress') return deliverProgressEvent(event, [this.onEvent, ...this.listeners])
    this.observeLifecycle(event)
    this.publishSettlement(event)
    let delivered = true
    try { this.onEvent?.(event) } catch { delivered = false }
    for (const listener of this.listeners) { try { listener(event) } catch { delivered = false } }
    return delivered
  }
  private async observeAgentEvent(member: string, event: AgentRunEvent): Promise<void> {
    return observeAgentEvent({
      roster: this.roster.locals, onAgentEvent: this.onAgentEvent, observerTimeoutMs: this.observerTimeoutMs,
      emit: event => this.emit(event),
    }, member, event)
  }

}
