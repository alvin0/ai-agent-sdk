import { createHash } from 'node:crypto'
import { createCoreSpan, type Message, type ObservationEvent } from '@alvin0/ai-agent-sdk-core'
import type { AgentSessionOptions } from '@alvin0/ai-agent-sdk-core/agent'

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
  spawns: number
  wastedLeadTurns: number
  wallMs: number
  errors: string[]
}
const numeric = (value: unknown) => typeof value === 'number' ? value : 0

// Identity fields are not evidence. Deduplicate semantic tool results and messages.
export function evidenceFingerprint(messages: readonly Message[]): string {
  const facts = messages.filter(message => message.role !== 'assistant'
    && !(message.source.kind === 'app' && message.source.producer === 'managed-team'))
    .map(message => JSON.stringify(message.content, (key, value: unknown) =>
      ['id', 'callId', 'messageId', 'conversationId', 'createdAt', 'teamId'].includes(key) ? undefined : value))
  return createHash('sha256').update(JSON.stringify([...new Set(facts)].sort())).digest('hex')
}

export class Collector {
  readonly events: { member: string; event: ObservationEvent }[] = []
  readonly requests: { member: string; evidence: string; repeated: boolean }[] = []
  readonly tools: { member: string; name: string }[] = []
  readonly errors: string[] = []
  lastText = ''
  spawns = 0
  private previousEvidence: string | undefined

  options(member: string): Partial<AgentSessionOptions> {
    return {
      compaction: false,
      runtimeLimits: { maxTotalTokens: 80000, hookTimeoutMs: 120000 },
      observation: { mode: 'operational', openSpan: createCoreSpan, capture: event => {
        this.events.push({ member, event })
        if (event.phase === 'end' && ['sdk.model.call', 'sdk.tool.call'].includes(event.name)
          && ['error', 'aborted'].includes(String(event.data.status))) {
          this.errors.push(`${member} ${event.name}: ${JSON.stringify(event.data)}`)
        }
        return { eventId: event.eventId, status: 'accepted', durable: false, boundary: 'none' }
      } },
      hooks: {
        checkpoint: context => {
          if (context.kind === 'before-tool-dispatch') {
            this.tools.push({ member, name: context.call.toolName })
          } else {
            const evidence = evidenceFingerprint(context.request.messages)
            const repeated = member === 'lead' && evidence === this.previousEvidence
            this.requests.push({ member, evidence, repeated })
            if (member === 'lead') this.previousEvidence = evidence
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
      totalModelCalls: starts.length, spawns: this.spawns,
      wastedLeadTurns: this.requests.filter(r => r.repeated).length, wallMs, errors: [...this.errors] }
  }
}
