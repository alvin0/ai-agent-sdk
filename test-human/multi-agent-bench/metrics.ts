import { createHash } from 'node:crypto'
import { createCoreSpan, type Message, type ObservationEvent,
  type ModelFailure } from '../../packages/core/dist/index.js'
import { isTimelineEvent, lifecycleMetadata, type BenchTeamEvent } from './team-events.ts'
import { DelegationCollector, type DelegationMetrics } from './delegation.ts'
import { retryWaitMetrics, isInfraFailure } from './reliability.ts'
import type { AgentSessionOptions } from '../../packages/core/dist/agent.js'

export interface Limits { maxTotalTokens: number; maxTurns: number; maxToolCalls: number }
export const defaultLimits: Limits = { maxTotalTokens: 1500000, maxTurns: 240, maxToolCalls: 320 }
export interface MemberUsage {
  calls: number; inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number
}
export interface Metrics extends Partial<DelegationMetrics> {
  teamMetricsSource?: 'timeline-v1' | 'inferred'
  callMetricsSource?: 'timeline-v1' | 'model-events'
  usageMetricsSource?: 'team-ledger' | 'model-events'
  wastedWakes?: number
  memberMetrics?: MemberMetrics[]
  leadCallInputTokens?: (number | null)[]
  memberUsage?: { lead: MemberUsage; workers: MemberUsage; byMember: Record<string, MemberUsage> }
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number | null
  uncachedInputTokens: number
  cachedInputTokens: number
  costWeightedTokens: number | null
  reportedCostWeightedTokens: number
  reportedTokens: number
  usageComplete: boolean
  usageIncomplete: boolean
  orphanWorkers: number
  orphanWorkersAfterGrace: number
  leadModelCalls: number
  totalModelCalls: number
  toolCalls: number
  capHits: { tokens: boolean; turns: boolean; toolCalls: boolean }
  spawns: number
  wastedLeadTurns: number
  wallMs: number
  wallActiveMs?: number
  modelRetries?: number
  retryWaitMs?: number
  retryWallWaitMs?: number
  retryScheduledWaitMs?: number
  errors: string[]
}
export interface MemberMetrics extends MemberUsage { member: string; conversationId?: string }
const numeric = (value: unknown) => typeof value === 'number' ? value : 0
/** SDK input, cache reads, cache writes and output are disjoint buckets. Writes cost full weight. */
export function tokenCounts(usage: Record<string, unknown> | undefined) {
  const input = numeric(usage?.inputTokens), output = numeric(usage?.outputTokens)
  const cached = numeric(usage?.cacheReadTokens), written = numeric(usage?.cacheWriteTokens)
  const buckets = input + cached + written + output
  const raw = Math.max(numeric(usage?.totalTokens), buckets)
  // Unattributed reported tokens might all be cached: only their minimum weight is a safe lower bound.
  const weighted = input + written + output + cached * 0.1 + (raw - buckets) * 0.1
  return { raw, weighted, uncached: input + written, cached }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

// Be conservative: unknown notices are evidence. Only recognized status-only shapes are ignored.
export function statusOnly(value: unknown): boolean {
  if (typeof value === 'string') {
    try { return statusOnly(JSON.parse(value)) } catch { /* text notice */ }
    const outstanding = '^Outstanding managed workers: [\\w, .-]+\\.'
      + '(?: Their current lifecycle status is available through list_agents; '
      + 'wait_agents is bounded by its timeout\\.'
      + '| Their statuses and retained results are available through list_agents\\.'
      + '| Read their results with wait_agents\\.)?$'
    return new RegExp(outstanding).test(value)
      || /^Worker '[\w-]+' (?:running|pending|completed|settled)\.?$/.test(value)
      || value === 'All outstanding managed workers have settled. '
        + 'Their statuses and retained results are available through list_agents.'
      || value === 'All outstanding managed workers have settled. Read their results with wait_agents.'
      || value === 'All workers settled — synthesize now.'
  }
  if (Array.isArray(value)) return value.every(item => object(item) && statusOnly(item))
  if (!object(value)) return false
  const statusKeys = new Set(['type', 'name', 'worker', 'agentId', 'conversationId', 'teamId', 'id', 'status', 'kind',
    'role', 'protocol', 'deliveries', 'description', 'interrupted', 'timedOut', 'timeout', 'pending', 'running',
    'completed', 'failed', 'settled', 'closed', 'previousStatus', 'agents', 'workers', 'members', 'targets'])
  return Object.keys(value).length > 0 && Object.entries(value).every(([key, item]) =>
    statusKeys.has(key) && statusMetadata(item))
}

function statusMetadata(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(statusMetadata)
  return !object(value) || statusOnly(value)
}

function evidenceFacts(messages: readonly Message[]): string[] {
  const coordination = new Map<string, boolean>()
  for (const message of messages) for (const block of message.content) {
    if (block.type === 'tool-call') coordination.set(block.id, /wait|list.*agent|hold|join/i.test(block.name))
  }
  return messages.filter(message => message.role !== 'assistant').flatMap(message => {
    const managed = message.source.kind === 'app' && message.source.producer === 'managed-team'
    return message.content.flatMap(block => {
      if (managed && block.type === 'text' && statusOnly(block.text)) return []
      if (block.type === 'tool-result' && coordination.get(block.toolCallId)
        && block.content.every(item => item.type === 'text' && statusOnly(item.text))) return []
      return [JSON.stringify(block, (key, value: unknown) =>
        ['id', 'callId', 'toolCallId', 'messageId', 'conversationId', 'createdAt', 'teamId'].includes(key)
          ? undefined : value)]
    })
  })
}
export function evidenceFingerprint(messages: readonly Message[]): string {
  return createHash('sha256').update(JSON.stringify([...new Set(evidenceFacts(messages))].sort())).digest('hex')
}

export class Collector {
  rootTeamId: string | undefined
  readonly teamEvents: BenchTeamEvent[] = []
  private readonly teamSequences = new Map<string, Set<number>>()
  readonly delegation = new DelegationCollector()
  readonly events: { member: string; event: ObservationEvent }[] = []
  readonly requests: { member: string; evidence: string; repeated: boolean }[] = []
  readonly tools: { member: string; name: string }[] = []
  readonly errors: string[] = []
  readonly controller = new AbortController()
  readonly limits: Limits
  readonly capHits = { tokens: false, turns: false, toolCalls: false }
  readonly infraFailures: ModelFailure[] = []
  readonly retryWaits: [number, number][] = []
  modelRetries = 0
  retryScheduledWaitMs = 0
  lastText = ''
  spawns = 0
  orphanWorkers = 0
  orphanWorkersAfterGrace = 0
  private readonly toolFailures = new Set<string>()
  private readonly seenEvidence = new Set<string>()
  private leadRequested = false
  private tokens = 0
  constructor(limits: Partial<Limits> = {}) { this.limits = { ...defaultLimits, ...limits } }

  /** Prefer SDK-owned facts when present; preserve historical evidence inference on older branches. */
  teamEvent(event: unknown): void {
    if (!object(event)) return
    this.delegation.teamEvent(event)
    if (event.type !== 'team-timeline') { this.lifecycleEvent(event); return }
    if (!isTimelineEvent(event)) return
    if (this.rootTeamId === undefined && (event.depth === undefined || event.depth === 0)) {
      this.rootTeamId = event.teamId
    }
    let seen = this.teamSequences.get(event.teamId)
    if (seen === undefined) this.teamSequences.set(event.teamId, seen = new Set())
    if (seen.has(event.sequence)) return
    seen.add(event.sequence)
    this.teamEvents.push(event as unknown as BenchTeamEvent)
  }

  private lifecycleEvent(event: Record<string, unknown>): void {
    const metadata = lifecycleMetadata(event, this.rootTeamId)
    if (metadata) this.teamEvents.push(metadata)
  }

  private hit(cap: keyof Collector['capHits']) {
    this.capHits[cap] = true
    this.controller.abort(new Error(`Aggregate ${cap} cap hit`))
  }
  options(member: string): Partial<AgentSessionOptions> {
    return {
      compaction: false,
      interceptors: [{ name: 'benchmark-tool-errors', around: async (call, next) => {
        try {
          const result = await next()
          if (result.isError) this.toolError(member, call, result.error.message)
          else this.delegation.toolResult(member, call, result)
          return result
        } catch (error) {
          this.toolError(member, call, error)
          throw error
        }
      } }],
      runtimeLimits: { hookTimeoutMs: 120000 },
      observation: { mode: 'operational', openSpan: createCoreSpan, capture: event => this.observe(member, event) },
      hooks: {
        checkpoint: context => {
          this.controller.signal.throwIfAborted()
          if (context.kind === 'before-tool-dispatch') {
            if (this.tools.length >= this.limits.maxToolCalls) {
              this.hit('toolCalls'); this.controller.signal.throwIfAborted()
            }
            this.tools.push({ member, name: context.call.toolName })
            this.delegation.dispatch(member, { ...context.call, args: context.call.rawArguments })
          } else {
            if (this.requests.length >= this.limits.maxTurns) {
              this.hit('turns'); this.controller.signal.throwIfAborted()
            }
            this.delegation.running(member)
            const facts = evidenceFacts(context.request.messages)
            const repeated = member === 'lead' && this.leadRequested && facts.every(fact => this.seenEvidence.has(fact))
            this.requests.push({ member, evidence: evidenceFingerprint(context.request.messages), repeated })
            if (member === 'lead') {
              this.leadRequested = true
              facts.forEach(fact => this.seenEvidence.add(fact))
            }
          }
        },
        onTurnEnd: context => {
          this.delegation.settled(member)
          if (member === 'lead') this.lastText = context.outcome.text
          if (context.outcome.reason.kind === 'error') {
            this.recordInfraFailure(context.outcome.reason.failure)
            this.errors.push(`${member}: ${JSON.stringify(context.outcome.reason.failure)}`)
          }
        },
      },
    }
  }
  private observe(member: string, event: ObservationEvent) {
        this.events.push({ member, event })
        if (event.name === 'sdk.model.call' && event.phase === 'end') {
          const usage = event.data.reported as Record<string, unknown> | undefined
          this.tokens += tokenCounts(usage).weighted
          if (this.tokens >= this.limits.maxTotalTokens) this.hit('tokens')
        }
        if (event.phase === 'end' && ['sdk.model.call', 'sdk.tool.call'].includes(event.name)
          && ['error', 'aborted'].includes(String(event.data.status))
          && !(event.name === 'sdk.tool.call'
            && this.toolFailures.has(`${member}:${event.correlation.toolCallId}`))) {
          if (event.name === 'sdk.tool.call') {
            this.delegation.observationFailure(member, event.correlation.toolCallId, JSON.stringify(event.data))
          }
          this.errors.push(`${member} ${event.name}: ${JSON.stringify(event.data)}`)
        }
    return { eventId: event.eventId, status: 'accepted' as const, durable: false, boundary: 'none' as const }
  }
  recordInfraFailure(failure: ModelFailure) {
    if (isInfraFailure(failure) && !this.infraFailures.some(existing =>
      JSON.stringify(existing) === JSON.stringify(failure))) this.infraFailures.push(failure)
  }
  toolError(member: string, call: { toolName: string; args: unknown; callId: string }, error: unknown) {
    this.delegation.rejected(member, call, errorMessage(error))
    this.toolFailures.add(`${member}:${call.callId}`)
    this.errors.push(`${member} tool ${call.toolName} args=${argsSummary(call.args)}: ${errorMessage(error)}`)
  }
  metrics(wallMs: number): Metrics {
    const starts = this.events.filter(({ event }) => event.name === 'sdk.model.call' && event.phase === 'start')
    const ends = this.events.filter(({ event }) => event.name === 'sdk.model.call' && event.phase === 'end')
    const usageComplete = starts.length > 0 && starts.length === ends.length
      && ends.every(({ event }) => ['complete', 'not-applicable'].includes(String(event.data.coverage)))
    const timeline = this.teamEvents.filter(event => event.type === 'team-timeline')
    const calls = timeline.filter(event => event.kind === 'model-requested')
    const settlements = timeline.filter(event => event.kind === 'member-settled' && event.usage !== undefined)
    // A timeout may end before a run terminal arrives. Keep canonical partial evidence in that case.
    const timelineCalls = calls.length > 0 && calls.length === starts.length
    const timelineUsage = timelineCalls
      && settlements.reduce((n, event) => n + numeric(event.usage?.coverage?.logicalCalls), 0) === calls.length
    const reports = timelineUsage ? settlements.map(event => event.usage?.reported)
      : ends.map(({ event }) => event.data.reported as Record<string, unknown> | undefined)
    const preferredSum = (key: string) => reports.reduce((n, usage) => n + numeric(usage?.[key]), 0)
    const input = preferredSum('inputTokens'), output = preferredSum('outputTokens')
    const cacheReadTokens = preferredSum('cacheReadTokens'), cacheWriteTokens = preferredSum('cacheWriteTokens')
    const counts = reports.map(tokenCounts)
    const reportedTokens = counts.reduce((total, count) => total + count.raw, 0)
    const reportedCostWeightedTokens = counts.reduce((total, count) => total + count.weighted, 0)
    const retryWait = retryWaitMetrics(this.retryWaits)
    const delegation = this.delegation.metrics(this.spawns, timeline)
    const memberMetrics = this.memberMetrics()
    const memberUsage = aggregateMemberUsage(memberMetrics, item => this.isRootLead(item))
    const complete = timelineUsage ? settlements.every(event => event.usage?.authoritative) : usageComplete
    return { ...delegation, memberUsage, ...this.callMetrics(starts, ends, calls, timelineCalls),
      teamMetricsSource: timeline.length > 0 ? 'timeline-v1' : 'inferred',
      usageMetricsSource: timelineUsage ? 'team-ledger' : 'model-events',
      wallActiveMs: Math.max(0, wallMs - retryWait.union), modelRetries: this.modelRetries,
      retryWaitMs: retryWait.total, retryWallWaitMs: retryWait.union,
      retryScheduledWaitMs: this.retryScheduledWaitMs, inputTokens: input, outputTokens: output,
      cacheReadTokens, cacheWriteTokens, totalTokens: reportedTokens,
      uncachedInputTokens: input + cacheWriteTokens, cachedInputTokens: cacheReadTokens,
      costWeightedTokens: reportedCostWeightedTokens, reportedCostWeightedTokens,
      reportedTokens, usageComplete: complete, usageIncomplete: !complete,
      orphanWorkers: this.orphanWorkers, orphanWorkersAfterGrace: this.orphanWorkersAfterGrace,
      toolCalls: this.tools.length, capHits: { ...this.capHits },
      wastedLeadTurns: this.requests.filter(r => r.repeated).length,
      wastedWakes: timeline.filter(event => event.kind === 'wasted-wake' && event.teamId === this.rootTeamId).length,
      memberMetrics, wallMs, errors: [...this.errors] }
  }
  private callMetrics(starts: Collector['events'], ends: Collector['events'],
    calls: BenchTeamEvent[], timelineCalls: boolean) {
    return {
      callMetricsSource: timelineCalls ? 'timeline-v1' as const : 'model-events' as const,
      leadModelCalls: timelineCalls ? calls.filter(event => event.teamId === this.rootTeamId
        && this.isRootLead(event)).length : starts.filter(item => this.isRootLead(item)).length,
      totalModelCalls: timelineCalls ? calls.length : starts.length,
      leadCallInputTokens: starts.filter(item => this.isRootLead(item)).map(start => {
        const end = ends.find(item => sameCall(start, item))
        const usage = end?.event.data.reported as Record<string, unknown> | undefined
        return usage === undefined ? null : numeric(usage.inputTokens) + numeric(usage.cacheReadTokens)
          + numeric(usage.cacheWriteTokens)
      }),
    }
  }
  private isRootLead(item: { member: string; event?: ObservationEvent; conversationId?: string }): boolean {
    const first = this.events.find(({ member, event }) => member === 'lead' && event.name === 'sdk.agent.run'
      && event.phase === 'start') ?? this.events.find(({ member }) => member === 'lead')
    const conversationId = item.event?.correlation?.conversationId ?? item.conversationId
    return item.member === 'lead' && (conversationId === undefined
      || conversationId === first?.event.correlation?.conversationId)
  }

  private memberMetrics(): MemberMetrics[] {
    const members = new Map<string, MemberMetrics>()
    for (const { member, event } of this.events) {
      if (event.name !== 'sdk.model.call') continue
      const conversationId = event.correlation?.conversationId
      const key = JSON.stringify([member, conversationId])
      let aggregate = members.get(key)
      if (aggregate === undefined) {
        aggregate = { member, ...conversationId === undefined ? {} : { conversationId },
          calls: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
        members.set(key, aggregate)
      }
      if (event.phase === 'start') aggregate.calls++
      if (event.phase === 'end') addUsage(aggregate, event.data.reported as Record<string, unknown> | undefined)
    }
    return [...members.values()]
  }

}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (object(error) && typeof error.message === 'string') return error.message
  return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error)
}
export function argsSummary(args: unknown): string {
  return (JSON.stringify(args, (_key, value: unknown) =>
    typeof value === 'string' && value.length > 160 ? `${value.slice(0, 160)}…[${value.length} chars]` : value)
    ?? String(args)).slice(0, 512)
}

function aggregateMemberUsage(members: MemberMetrics[], isLead: (item: MemberMetrics) => boolean) {
  const empty = (): MemberUsage => ({ calls: 0, inputTokens: 0, cachedInputTokens: 0,
    cacheWriteTokens: 0, outputTokens: 0 })
  const lead = empty(), workers = empty(), byMember: Record<string, MemberUsage> = Object.create(null)
  for (const member of members) {
    const target = isLead(member) ? lead : workers
    const named = byMember[member.member] ??= empty()
    for (const key of Object.keys(target) as (keyof MemberUsage)[]) {
      target[key] += member[key]
      named[key] += member[key]
    }
  }
  return { lead, workers, byMember }
}

function sameCall(a: Collector['events'][number], b: Collector['events'][number]) {
  return a.member === b.member && a.event.correlation?.modelCallId === b.event.correlation?.modelCallId
    && a.event.correlation?.runId === b.event.correlation?.runId
    && a.event.correlation?.conversationId === b.event.correlation?.conversationId
}
function addUsage(target: MemberUsage, usage: Record<string, unknown> | undefined) {
  target.inputTokens += numeric(usage?.inputTokens)
  target.cachedInputTokens += numeric(usage?.cacheReadTokens)
  target.cacheWriteTokens += numeric(usage?.cacheWriteTokens)
  target.outputTokens += numeric(usage?.outputTokens)
}
