/** Projects existing ledger facts onto the team event channel without changing delivery receipts. */
import { progressActivity } from './team-progress-internal.ts'
import { NOOP_OBSERVATION_PORT, addUsageCounters, type ObservationEvent,
  type ObservationPort } from '../../observation/index.ts'
import type { TurnHooks } from '../loop/events.ts'
import type { RunUsageReport } from '../accounting/report.ts'
import { deepCloneFreeze } from './common.ts'
import type { AgentTeamMember, AgentMemberOutcome } from './types.ts'
import type { TeamMemberSnapshot, TeamSnapshot, TeamTimelineData, TeamTimelineEvent,
  TeamWakeReason, TeamSettlementStatus, TeamActivation } from './team-timeline.ts'

/** @internal Session instrumentation is runtime-owned. */
export interface TeamObservedSessionOptions {
  readonly observation?: ObservationPort
  readonly hooks?: TurnHooks
}
export interface TeamSettlementUsage {
  readonly runId: string
  readonly usage: RunUsageReport
}

type MemberState = { provisional?: true; view: TeamMemberSnapshot; runId?: string
  lastUsage?: RunUsageReport | undefined
  hasSettlement?: true; settlementReported?: boolean; settledRunId?: string | undefined }

const eventOwners = new WeakMap<ObservationEvent, TeamObservation>()

export class TeamObservation {
  private team: object = {}
  bindProgress(team: object): void { this.team = team }
  private sequence = 0
  private readonly origin = performance.now()
  private readonly states = new Map<string, MemberState>()
  private readonly active = new Set<string>()
  private information = 0
  private lastLeadInformation: number | undefined
  private readonly activations = new Map<string, TeamActivation>()
  private readonly seen = new WeakSet<ObservationEvent>()
  private pendingWake: { member: string; reason: TeamWakeReason } | undefined

  constructor(private readonly teamId: string, private readonly emit: (event: TeamTimelineEvent) => void,
    private readonly listening = () => true,
    private readonly ancestry: { readonly parentTeamId?: string; readonly depth?: number } = {}) {}

  get childContext() { return { parentTeamId: this.teamId, depth: (this.ancestry.depth ?? 0) + 1 } }
  private get envelope() {
    return { teamId: this.teamId, depth: this.ancestry.depth ?? 0,
      ...this.ancestry.parentTeamId === undefined ? {} : { parentTeamId: this.ancestry.parentTeamId } }
  }

  record(data: TeamTimelineData): void {
    if (data.kind === 'spawn-failed') this.failedSpawn(data.member)
    if (data.kind === 'notice-delivered' || data.kind === 'board-operation') this.information++
    const sequence = ++this.sequence
    if (!this.listening()) return
    this.emit(deepCloneFreeze({ ...data, type: 'team-timeline', schemaVersion: 1,
      ...this.envelope, sequence, occurredAt: new Date().toISOString(),
      elapsedMs: Math.max(0, performance.now() - this.origin) }))
  }

  private failedSpawn(member: string): void {
    const state = this.states.get(member)
    if (state !== undefined) state.view = { ...state.view, status: 'failed', settledAt: new Date().toISOString() }
  }

  attach(member: AgentTeamMember): void {
    const existing = this.states.get(member.name)
    if (existing !== undefined && (existing.provisional || existing.view.conversationId === member.conversationId)) {
      existing.view = { ...existing.view, agentId: member.agentId, role: member.role, attached: true,
        ...member.conversationId === undefined ? {} : { conversationId: member.conversationId } }
      delete existing.provisional
      return
    }
    const previous = existing?.runId
    if (previous !== undefined) this.active.delete(previous)
    this.states.set(member.name, { view: { name: member.name, agentId: member.agentId,
      ...member.conversationId === undefined ? {} : { conversationId: member.conversationId },
      role: member.role, attached: true, status: member.status, attachedAt: new Date().toISOString(),
      durationMs: 0, modelCalls: 0, runs: 0, activeRuns: 0 } })
  }

  input(member: string): void {
    if (this.states.get(member)?.view.role === 'lead') this.information++
  }

  accepted(member: string, sender: string): void {
    const source = (this.states.get(member)?.view.runs ?? 0) === 0 ? 'initial' : 'follow-up'
    if (this.activations.get(member)?.source !== 'settlement') this.activations.set(member, { source, sender })
  }

  wake(member: string, reason: TeamWakeReason, sender?: string): void {
    if (this.activations.get(member)?.source !== 'settlement') {
      this.activations.set(member, { source: reason, ...sender === undefined ? {} : { sender } })
    }
    if (this.states.get(member)?.view.role !== 'lead') return
    if (this.pendingWake?.reason !== 'settlement') this.pendingWake = { member, reason }
    this.record({ kind: 'lead-woken', member, reason })
  }

  outcome(member: string, outcome: AgentMemberOutcome,
    report?: TeamSettlementUsage): void {
    const state = this.states.get(member)
    if (state === undefined) return
    const status = outcome.status ?? (outcome.kind === 'completed' ? 'completed' : 'failed')
    state.view = { ...state.view, status, settledAt: new Date().toISOString() }
    if (state.view.role !== 'peer') return
    this.workerSettlement(member, status, state, report)
  }

  private workerSettlement(member: string, status: TeamSettlementStatus, state: MemberState,
    report?: TeamSettlementUsage): void {
    const evidence = settlementUsage(state, report)
    if (state.hasSettlement && state.settledRunId === evidence.runId
      && (state.settlementReported || report === undefined)) return
    state.settlementReported = report !== undefined
    state.hasSettlement = true
    state.settledRunId = evidence.runId
    this.record({ kind: 'worker-settled', member, status,
      ...evidence })
  }

  snapshot(members: readonly AgentTeamMember[]): TeamSnapshot {
    return deepCloneFreeze({ schemaVersion: 1, ...this.envelope, sequence: this.sequence,
      occurredAt: new Date().toISOString(), elapsedMs: Math.max(0, performance.now() - this.origin),
      members: [...this.states.values()].map(state => {
        const current = members.find(member => member.name === state.view.name)
        if (current?.status === 'pending' || current?.status === 'running') {
          return { ...state.view, attached: true, status: current.status }
        }
        return { ...state.view, attached: current !== undefined }
      }) })
  }

  clear(): void { this.states.clear(); this.active.clear(); this.pendingWake = undefined; this.activations.clear() }

  sessionOptions<T extends TeamObservedSessionOptions>(member: string, options: T): T {
    const port = options.observation ?? NOOP_OBSERVATION_PORT
    return { ...options, observation: {
      mode: port.mode, openSpan: input => port.openSpan(input),
      capture: event => { this.observe(member, event); return port.capture(event) },
      ...port.checkpoint === undefined ? {} : { checkpoint: (event, signal) => {
        this.observe(member, event)
        return port.checkpoint!(event, signal)
      } },
    }, hooks: { ...options.hooks,
      checkpoint: async context => {
        if (context.kind === 'before-tool-dispatch') progressActivity(this.team, {
          kind: 'tool', member, name: context.call.toolName, args: context.call.rawArguments,
        })
        return options.hooks?.checkpoint?.(context)
      }, onTurnEnd: async context => {
      if (context.outcome.reason.kind === 'budget-exhausted') this.record({ kind: 'budget', member,
        budget: context.outcome.reason.budget, action: 'exhausted' })
      return options.hooks?.onTurnEnd?.(context)
    } } }
  }

  private observe(member: string, event: ObservationEvent): void {
    const owner = eventOwners.get(event)
    if (this.seen.has(event)) return
    if (owner !== undefined && owner !== this) return
    eventOwners.set(event, this)
    this.seen.add(event)
    const state = this.ensureState(member, event)
    const runId = event.correlation.runId
    if (event.name === 'sdk.agent.run') this.runEvent(member, state, event)
    if (event.name === 'sdk.model.call' && event.phase === 'start') {
      state.view = { ...state.view, modelCalls: state.view.modelCalls + 1 }
      if (state.view.role === 'lead' && sameConversation(state, event)) this.leadRequest(member)
      this.record({ kind: 'model-requested', member, runId, ...conversation(event) })
    }
    if (isToolEnd(event)) this.input(member)
  }

  private ensureState(member: string, event: ObservationEvent): MemberState {
    let state = this.states.get(member)
    if (state === undefined) {
      this.attach({ name: member, agentId: member, kind: 'local', role: 'peer', status: 'idle', deliveries: [],
        ...event.correlation.conversationId === undefined ? {} : { conversationId: event.correlation.conversationId } })
      state = this.states.get(member)!
      state.provisional = true
    }
    return state
  }

  private leadRequest(member: string): void {
    const wake = this.pendingWake
    this.pendingWake = undefined
    if (wake?.member === member && (wake.reason === 'synthesis' || wake.reason === 'settlement')
      && this.lastLeadInformation === this.information) {
      this.record({ kind: 'wasted-wake', member, reason: 'no-new-team-information' })
    }
    this.lastLeadInformation = this.information
  }

  private runEvent(member: string, state: MemberState, event: ObservationEvent): void {
    const runId = event.correlation.runId
    if (event.phase === 'start') {
      this.active.add(runId)
      if (sameConversation(state, event)) { state.runId = runId; state.lastUsage = undefined }
      state.view = { ...state.view, status: 'running', startedAt: event.occurredAt,
        runs: state.view.runs + 1, activeRuns: state.view.activeRuns + 1 }
      const activation = this.activations.get(member) ?? { source: state.view.runs === 1 ? 'initial' : 'follow-up' }
      this.activations.delete(member)
      this.record({ kind: 'member-started', member, runId, activation,
        ...event.correlation.conversationId === undefined ? {} : { conversationId: event.correlation.conversationId } })
    } else if (event.phase === 'end' && this.active.delete(runId)) {
      const usage = event.data.usage as unknown as RunUsageReport
      progressActivity(this.team, { kind: 'run-end', member, status: String(event.data.status) })
      const status = event.data.status as 'success' | 'error' | 'aborted' | 'rejected' | 'unknown'
      const durationMs = typeof event.data.durationMs === 'number' ? event.data.durationMs : 0
      if (sameConversation(state, event)) state.lastUsage = usage
      state.view = { ...state.view, settledAt: event.occurredAt,
        status: settledStatus(state.view.status, status),
        durationMs: state.view.durationMs + durationMs, activeRuns: Math.max(0, state.view.activeRuns - 1),
        usage: mergeUsage(state.view.usage, usage) }
      this.record({ kind: 'member-settled', member, runId, status, durationMs, usage })
    }
  }
}

function mergeUsage(before: RunUsageReport | undefined, next: RunUsageReport): RunUsageReport {
  if (before === undefined) return next
  const reported = addUsageCounters([before.reported, next.reported])
  const coverage = { ...next.coverage }
  for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) coverage[key] += before.coverage[key]
  return { reported: reported.counters, coverage, ...estimatedUsage(before, next),
    authoritative: before.authoritative && next.authoritative && !reported.overflow }
}

function estimatedUsage(before: RunUsageReport, next: RunUsageReport):
Pick<RunUsageReport, 'estimated' | 'budgetTokens'> {
  const estimates = [before.estimated, next.estimated].filter(value => value !== undefined)
  const estimated = estimates.length === 0 ? undefined : addUsageCounters(estimates)
  return { ...estimated === undefined ? {} : { estimated: estimated.counters },
    ...before.budgetTokens === undefined && next.budgetTokens === undefined ? {}
      : { budgetTokens: Math.min(Number.MAX_SAFE_INTEGER, (before.budgetTokens ?? 0) + (next.budgetTokens ?? 0)) } }
}

function settlementUsage(state: MemberState, report?: TeamSettlementUsage) {
  const runId = report?.runId ?? state.runId
  const usage = report?.usage ?? (state.view.activeRuns === 0 ? state.lastUsage : undefined)
  return { ...runId === undefined ? {} : { runId }, ...usage === undefined ? {} : { usage } }
}

function sameConversation(state: MemberState, event: ObservationEvent): boolean {
  return event.correlation.conversationId === undefined || state.view.conversationId === undefined
    || event.correlation.conversationId === state.view.conversationId
}

function settledStatus(before: TeamMemberSnapshot['status'], status: string): TeamMemberSnapshot['status'] {
  return before === 'cancelled' || before === 'timeout' ? before : snapshotStatus(status)
}

function snapshotStatus(status: string): TeamMemberSnapshot['status'] {
  if (status === 'success') return 'idle'
  if (status === 'aborted') return 'cancelled'
  return status === 'unknown' ? 'unknown' : 'failed'
}

function conversation(event: ObservationEvent): { conversationId?: string } {
  return event.correlation.conversationId === undefined ? {} : { conversationId: event.correlation.conversationId }
}

function isToolEnd(event: ObservationEvent): boolean {
  return event.name === 'sdk.tool.call' && event.phase === 'end'
}
