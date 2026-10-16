import { createHash } from 'node:crypto'
import { createCoreSpan, type Message, type ObservationEvent,
  type ModelFailure } from '../../packages/core/dist/index.js'
import { retryWaitMetrics, isInfraFailure } from './reliability.ts'
import type { AgentSessionOptions } from '../../packages/core/dist/agent.js'

export interface Limits { maxTotalTokens: number; maxTurns: number; maxToolCalls: number }
export const defaultLimits: Limits = { maxTotalTokens: 1500000, maxTurns: 240, maxToolCalls: 320 }
export interface Metrics {
  teamMetricsSource?: 'timeline-v1' | 'inferred'
  callMetricsSource?: 'timeline-v1' | 'model-events'
  usageMetricsSource?: 'team-ledger' | 'model-events'
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
  spawnAttempts?: number
  spawnsRejected?: number
  wastedWakes?: number
  memberMetrics?: MemberMetrics[]
  /** Total reported input buckets per root lead call; null when usage is absent. */
  leadCallInputTokens?: (number | null)[]
  wastedLeadTurns: number
  wallMs: number
  wallActiveMs?: number
  modelRetries?: number
  retryWaitMs?: number
  retryWallWaitMs?: number
  retryScheduledWaitMs?: number
  errors: string[]
}
export interface MemberMetrics {
  member: string
  conversationId?: string
  calls: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
}
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

/** Structural adapter: this harness also runs against SDK branches without timeline types. */
export interface BenchTeamEvent {
  type: string; schemaVersion?: 1; teamId: string; sequence?: number; kind?: string; member: string
  parentTeamId?: string
  depth?: number
  conversationId?: string
  reason?: string
  message?: { id: string; sender: string; target: string; delivery: string; createdAt: string }
  runId?: string
  usage?: { reported: Record<string, unknown>; authoritative: boolean; coverage: { logicalCalls: number } }
}

export class Collector {
  rootTeamId: string | undefined
  readonly teamEvents: BenchTeamEvent[] = []
  private readonly teamSequences = new Map<string, Set<number>>()
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
    if (event.type !== 'team-timeline') { this.lifecycleEvent(event); return }
    if (event.schemaVersion !== 1 || typeof event.teamId !== 'string' || typeof event.sequence !== 'number'
      || typeof event.kind !== 'string' || typeof event.member !== 'string') return
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
    if (event.type === 'message-accepted' && object(event.message)) {
      const { id, teamId, sender, target, delivery, createdAt } = event.message
      if ([id, teamId, sender, target, delivery, createdAt].every(value => typeof value === 'string')) {
        this.teamEvents.push({ type: 'message-accepted', teamId, member: target,
          message: { id, sender, target, delivery, createdAt } } as BenchTeamEvent)
      }
    } else if (typeof event.type === 'string' && event.type.startsWith('member-run-')
      && typeof event.member === 'string') {
      const response = object(event.response) ? event.response : undefined
      const report = object(response?.report) ? response.report : undefined
      const outcome = object(response?.outcome) ? response.outcome : undefined
      this.teamEvents.push({ type: event.type, teamId: this.rootTeamId ?? '', member: event.member,
        ...typeof report?.runId === 'string' ? { runId: report.runId } : {},
        ...typeof outcome?.yielded === 'boolean' ? { yielded: outcome.yielded } : {} })
    }
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
          return result
        } catch (error) {
          this.toolError(member, call, error)
          throw error
        }
      } }],
      runtimeLimits: { hookTimeoutMs: 120000 },
      observation: { mode: 'operational', openSpan: createCoreSpan, capture: event => {
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
          this.errors.push(`${member} ${event.name}: ${JSON.stringify(event.data)}`)
        }
        return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
      } },
      hooks: {
        checkpoint: context => {
          this.controller.signal.throwIfAborted()
          if (context.kind === 'before-tool-dispatch') {
            if (this.tools.length >= this.limits.maxToolCalls) {
              this.hit('toolCalls'); this.controller.signal.throwIfAborted()
            }
            this.tools.push({ member, name: context.call.toolName })
          } else {
            if (this.requests.length >= this.limits.maxTurns) {
              this.hit('turns'); this.controller.signal.throwIfAborted()
            }
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
          if (member === 'lead') this.lastText = context.outcome.text
          if (context.outcome.reason.kind === 'error') {
            this.recordInfraFailure(context.outcome.reason.failure)
            this.errors.push(`${member}: ${JSON.stringify(context.outcome.reason.failure)}`)
          }
        },
      },
    }
  }
  recordInfraFailure(failure: ModelFailure) {
    if (isInfraFailure(failure) && !this.infraFailures.some(existing =>
      JSON.stringify(existing) === JSON.stringify(failure))) this.infraFailures.push(failure)
  }
  toolError(member: string, call: { toolName: string; args: unknown; callId: string }, error: unknown) {
    this.toolFailures.add(`${member}:${call.callId}`)
    this.errors.push(`${member} tool ${call.toolName} args=${argsSummary(call.args)}: ${errorMessage(error)}`)
  }
  metrics(wallMs: number): Metrics {
    const starts = this.events.filter(({ event }) => event.name === 'sdk.model.call' && event.phase === 'start')
    const ends = this.events.filter(({ event }) => event.name === 'sdk.model.call' && event.phase === 'end')
    const usageComplete = starts.length > 0 && starts.length === ends.length
      && ends.every(({ event }) => ['complete', 'not-applicable'].includes(String(event.data.coverage)))
    const sum = (key: string) => ends.reduce((total, { event }) => {
      const reported = event.data.reported as Record<string, unknown> | undefined
      return total + numeric(reported?.[key])
    }, 0)
    const timeline = this.teamEvents.filter(event => event.type === 'team-timeline')
    const calls = timeline.filter(event => event.kind === 'model-requested')
    const settlements = timeline.filter(event => event.kind === 'member-settled' && event.usage !== undefined)
    // A timeout may end before a run terminal arrives. Keep canonical partial evidence in that case.
    const timelineCalls = calls.length > 0 && calls.length === starts.length
    const timelineUsage = timelineCalls
      && settlements.reduce((n, event) => n + numeric(event.usage?.coverage?.logicalCalls), 0) === calls.length
    const preferredSum = (key: string) => timelineUsage
      ? settlements.reduce((n, event) => n + numeric(event.usage?.reported[key]), 0) : sum(key)
    const input = preferredSum('inputTokens'), output = preferredSum('outputTokens')
    const cacheReadTokens = preferredSum('cacheReadTokens'), cacheWriteTokens = preferredSum('cacheWriteTokens')
    const counts = timelineUsage ? settlements.map(event => tokenCounts(event.usage?.reported))
      : ends.map(({ event }) => tokenCounts(event.data.reported as Record<string, unknown> | undefined))
    const reportedTokens = counts.reduce((total, count) => total + count.raw, 0)
    const reportedCostWeightedTokens = counts.reduce((total, count) => total + count.weighted, 0)
    const retryWait = retryWaitMetrics(this.retryWaits)
    return { callMetricsSource: timelineCalls ? 'timeline-v1' : 'model-events', teamMetricsSource: timeline.length > 0 ? 'timeline-v1' : 'inferred',
      usageMetricsSource: timelineUsage ? 'team-ledger' : 'model-events', wallActiveMs: Math.max(0, wallMs - retryWait.union), modelRetries: this.modelRetries,
      retryWaitMs: retryWait.total, retryWallWaitMs: retryWait.union,
      retryScheduledWaitMs: this.retryScheduledWaitMs, inputTokens: input, outputTokens: output,
      cacheReadTokens, cacheWriteTokens, totalTokens: reportedTokens,
      uncachedInputTokens: input + cacheWriteTokens, cachedInputTokens: cacheReadTokens,
      costWeightedTokens: reportedCostWeightedTokens, reportedCostWeightedTokens,
      reportedTokens, usageComplete: timelineUsage ? settlements.every(event => event.usage?.authoritative) : usageComplete,
      usageIncomplete: timelineUsage ? settlements.some(event => !event.usage?.authoritative) : !usageComplete,
      orphanWorkers: this.orphanWorkers, orphanWorkersAfterGrace: this.orphanWorkersAfterGrace,
      leadModelCalls: timelineCalls ? calls.filter(event => event.member === 'lead'
        && event.teamId === this.rootTeamId && this.isRootLead(event)).length
        : starts.filter(item => this.isRootLead(item)).length,
      totalModelCalls: timelineCalls ? calls.length : starts.length,
      toolCalls: this.tools.length, capHits: { ...this.capHits },
      spawns: timeline.length > 0 ? timeline.filter(event => event.kind === 'spawn-accepted').length : this.spawns,
      spawnAttempts: timeline.length > 0 ? timeline.filter(event => event.kind === 'spawn-requested'
        || event.kind === 'spawn-rejected' && (event.reason === 'invalid' || event.reason === 'aborted')).length : this.spawns,
      spawnsRejected: timeline.filter(event => event.kind === 'spawn-rejected').length,
      wastedLeadTurns: this.requests.filter(r => r.repeated).length,
      wastedWakes: timeline.filter(event => event.kind === 'wasted-wake' && event.teamId === this.rootTeamId).length,
      memberMetrics: this.memberMetrics(), leadCallInputTokens: starts.filter(item => this.isRootLead(item)).map(start => {
        const end = ends.find(item => item.event.correlation?.modelCallId === start.event.correlation?.modelCallId
          && item.event.correlation?.runId === start.event.correlation?.runId)
        const usage = end?.event.data.reported as Record<string, unknown> | undefined
        return usage === undefined ? null : numeric(usage.inputTokens) + numeric(usage.cacheReadTokens)
          + numeric(usage.cacheWriteTokens)
      }), wallMs, errors: [...this.errors] }
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
      if (event.phase !== 'end') continue
      const usage = event.data.reported as Record<string, unknown> | undefined
      aggregate.inputTokens += numeric(usage?.inputTokens)
      aggregate.cachedInputTokens += numeric(usage?.cacheReadTokens)
      aggregate.cacheWriteTokens += numeric(usage?.cacheWriteTokens)
      aggregate.outputTokens += numeric(usage?.outputTokens)
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
