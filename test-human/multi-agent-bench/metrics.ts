import { createHash } from 'node:crypto'
import { createCoreSpan, type Message, type ObservationEvent } from '../../packages/core/dist/index.js'
import type { AgentSessionOptions } from '../../packages/core/dist/agent.js'

export interface Limits { maxTotalTokens: number; maxTurns: number; maxToolCalls: number }
export const defaultLimits: Limits = { maxTotalTokens: 80000, maxTurns: 240, maxToolCalls: 320 }
export interface Metrics {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number | null
  reportedTokens: number
  usageComplete: boolean
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
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

// Be conservative: unknown notices are evidence. Only recognized status-only shapes are ignored.
export function statusOnly(value: unknown): boolean {
  if (typeof value === 'string') {
    try { return statusOnly(JSON.parse(value)) } catch { /* text notice */ }
    const outstanding = '^Outstanding managed workers: [\\w, .-]+\\.'
      + '(?: Their current lifecycle status is available through list_agents; '
      + 'wait_agents is bounded by its timeout\\.)?$'
    return new RegExp(outstanding).test(value)
      || /^Worker '[\w-]+' (?:running|pending|completed|settled)\.?$/.test(value)
      || value === 'All outstanding managed workers have settled. '
        + 'Their statuses and retained results are available through list_agents.'
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
      runtimeLimits: { hookTimeoutMs: 120000 },
      observation: { mode: 'operational', openSpan: createCoreSpan, capture: event => {
        this.events.push({ member, event })
        if (event.name === 'sdk.model.call' && event.phase === 'end') {
          const usage = event.data.reported as Record<string, unknown> | undefined
          this.tokens += ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
            .reduce((sum, key) => sum + numeric(usage?.[key]), 0)
          if (this.tokens >= this.limits.maxTotalTokens) this.hit('tokens')
        }
        if (event.phase === 'end' && ['sdk.model.call', 'sdk.tool.call'].includes(event.name)
          && ['error', 'aborted'].includes(String(event.data.status))) {
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
    const reportedTokens = input + output + cacheReadTokens + cacheWriteTokens
    return { inputTokens: usageComplete ? input : null, outputTokens: usageComplete ? output : null,
      cacheReadTokens, cacheWriteTokens, totalTokens: usageComplete ? reportedTokens : null,
      reportedTokens, usageComplete, leadModelCalls: starts.filter(s => s.member === 'lead').length,
      totalModelCalls: starts.length, toolCalls: this.tools.length, capHits: { ...this.capHits }, spawns: this.spawns,
      wastedLeadTurns: this.requests.filter(r => r.repeated).length, wallMs, errors: [...this.errors] }
  }
}
