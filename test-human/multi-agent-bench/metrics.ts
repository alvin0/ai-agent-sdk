import { createHash } from 'node:crypto'
import { createCoreSpan, type Message, type ObservationEvent } from '../../packages/core/dist/index.js'
import type { AgentSessionOptions } from '../../packages/core/dist/agent.js'

export interface Limits { maxTotalTokens: number; maxTurns: number; maxToolCalls: number }
export const defaultLimits: Limits = { maxTotalTokens: 1500000, maxTurns: 240, maxToolCalls: 320 }
export interface Metrics {
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
  errors: string[]
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

export class Collector {
  readonly events: { member: string; event: ObservationEvent }[] = []
  readonly requests: { member: string; evidence: string; repeated: boolean }[] = []
  readonly tools: { member: string; name: string }[] = []
  readonly errors: string[] = []
  readonly controller = new AbortController()
  readonly limits: Limits
  readonly capHits = { tokens: false, turns: false, toolCalls: false }
  lastText = ''
  spawns = 0
  orphanWorkers = 0
  orphanWorkersAfterGrace = 0
  private readonly toolFailures = new Set<string>()
  private readonly seenEvidence = new Set<string>()
  private leadRequested = false
  private tokens = 0
  constructor(limits: Partial<Limits> = {}) { this.limits = { ...defaultLimits, ...limits } }

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
            this.errors.push(`${member}: ${JSON.stringify(context.outcome.reason.failure)}`)
          }
        },
      },
    }
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
    const input = sum('inputTokens'), output = sum('outputTokens')
    const cacheReadTokens = sum('cacheReadTokens'), cacheWriteTokens = sum('cacheWriteTokens')
    const counts = ends.map(({ event }) => tokenCounts(event.data.reported as Record<string, unknown> | undefined))
    const reportedTokens = counts.reduce((total, count) => total + count.raw, 0)
    const reportedCostWeightedTokens = counts.reduce((total, count) => total + count.weighted, 0)
    return { inputTokens: input, outputTokens: output,
      cacheReadTokens, cacheWriteTokens, totalTokens: reportedTokens,
      uncachedInputTokens: input + cacheWriteTokens, cachedInputTokens: cacheReadTokens,
      costWeightedTokens: reportedCostWeightedTokens, reportedCostWeightedTokens,
      reportedTokens, usageComplete, usageIncomplete: !usageComplete,
      orphanWorkers: this.orphanWorkers, orphanWorkersAfterGrace: this.orphanWorkersAfterGrace,
      leadModelCalls: starts.filter(s => s.member === 'lead').length,
      totalModelCalls: starts.length, toolCalls: this.tools.length, capHits: { ...this.capHits }, spawns: this.spawns,
      wastedLeadTurns: this.requests.filter(r => r.repeated).length, wallMs, errors: [...this.errors] }
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
