import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRunEvent } from '../../src/agent/mode/run-agent.ts'
import type { AgentTeamEvent } from '../../src/agent/team/types.ts'
import { label, paint } from '../console.ts'

interface AgentStats {
  readonly tools: Map<string, number>
  readonly toolResults: Map<string, number>
  compactionStarts: number
  compactionEnds: number
  completed: boolean
  finalText: string
}

export interface A2AStressEventRecord {
  readonly at: string
  readonly agent: string
  readonly type: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export class A2AStressObserver {
  private readonly resultsRoot: string
  private readonly records: A2AStressEventRecord[] = []
  private readonly stats = new Map<string, AgentStats>()
  private readonly teamRecords: Array<Readonly<Record<string, unknown>>> = []

  constructor(resultsRoot: string) { this.resultsRoot = resultsRoot }

  recordAgent(agent: string, event: AgentRunEvent): void {
    const stats = this.agentStats(agent)
    const detail = eventDetail(event)
    this.records.push(Object.freeze({
      at: new Date().toISOString(), agent, type: event.type,
      ...(detail === undefined ? {} : { detail }),
    }))

    if (event.type === 'tool-call') {
      stats.tools.set(event.call.toolName, (stats.tools.get(event.call.toolName) ?? 0) + 1)
      console.log(label(agent), paint(35, `tool → ${event.call.toolName}`), truncate(event.call.rawArguments, 220))
    } else if (event.type === 'tool-result') {
      stats.toolResults.set(event.call.toolName, (stats.toolResults.get(event.call.toolName) ?? 0) + 1)
      console.log(label(agent), event.result.isError
        ? paint(31, `tool ✗ ${event.call.toolName}`)
        : paint(32, `tool ✓ ${event.call.toolName}`))
    } else if (event.type === 'compaction-start') {
      stats.compactionStarts++
      console.log(label(agent), paint(33, `compaction start (${event.estimatedInputTokens} estimated tokens)`))
    } else if (event.type === 'compaction-end') {
      stats.compactionEnds++
      console.log(label(agent), paint(33,
        `compaction ${event.status}: ${event.estimatedTokensBefore} → ${event.estimatedTokensAfter}`))
    } else if (event.type === 'assistant-text' && event.phase === 'final-answer') {
      stats.finalText += event.text
    } else if (event.type === 'agent-end') {
      stats.completed = event.outcome.completed
      if (stats.finalText.length === 0) stats.finalText = event.outcome.text
      console.log(label(agent), event.outcome.completed
        ? paint(32, 'agent completed')
        : paint(31, `agent ended: ${event.outcome.reason.kind}`))
    }
  }

  recordTeam(event: AgentTeamEvent): void {
    this.teamRecords.push(Object.freeze(structuredClone(event) as unknown as Record<string, unknown>))
    if (event.type === 'member-attached' || event.type === 'member-linked') {
      console.log(label('team'), `${event.type}: ${event.member.name} (${event.member.kind})`)
    } else if (event.type === 'message-accepted') {
      console.log(label('team'), `message ${event.message.sender} → ${event.message.target} [${event.message.delivery}]`)
    } else if (event.type === 'member-run-start' || event.type === 'member-run-end') {
      console.log(label('team'), `${event.type}: ${event.member}`)
    } else if (event.type === 'member-run-error') {
      console.log(label('team'), paint(31, `${event.member}: ${event.error}`))
    }
  }

  toolCount(agent: string, tool: string): number {
    return this.stats.get(agent)?.tools.get(tool) ?? 0
  }

  toolResultCount(agent: string, tool: string): number {
    return this.stats.get(agent)?.toolResults.get(tool) ?? 0
  }

  compactions(agent: string): { readonly starts: number; readonly ends: number } {
    const stats = this.stats.get(agent)
    return { starts: stats?.compactionStarts ?? 0, ends: stats?.compactionEnds ?? 0 }
  }

  completed(agent: string): boolean { return this.stats.get(agent)?.completed ?? false }

  agentNames(): readonly string[] { return Object.freeze([...this.stats.keys()]) }

  finalText(agent: string): string { return this.stats.get(agent)?.finalText ?? '' }

  async flush(extra: Readonly<Record<string, unknown>> = {}): Promise<void> {
    await mkdir(this.resultsRoot, { recursive: true })
    const agents = Object.fromEntries([...this.stats].map(([name, stats]) => [name, {
      tools: Object.fromEntries(stats.tools),
      toolResults: Object.fromEntries(stats.toolResults),
      compactionStarts: stats.compactionStarts,
      compactionEnds: stats.compactionEnds,
      completed: stats.completed,
      finalText: stats.finalText,
    }]))
    await Promise.all([
      writeFile(join(this.resultsRoot, 'events.json'), `${JSON.stringify(this.records, null, 2)}\n`, 'utf8'),
      writeFile(join(this.resultsRoot, 'team-events.json'), `${JSON.stringify(this.teamRecords, null, 2)}\n`, 'utf8'),
      writeFile(join(this.resultsRoot, 'summary.json'), `${JSON.stringify({ agents, ...extra }, null, 2)}\n`, 'utf8'),
    ])
  }

  private agentStats(agent: string): AgentStats {
    let stats = this.stats.get(agent)
    if (stats === undefined) {
      stats = {
        tools: new Map(), toolResults: new Map(), compactionStarts: 0, compactionEnds: 0,
        completed: false, finalText: '',
      }
      this.stats.set(agent, stats)
    }
    return stats
  }
}

function eventDetail(event: AgentRunEvent): Readonly<Record<string, unknown>> | undefined {
  if (event.type === 'tool-call') {
    return { tool: event.call.toolName, callId: event.call.callId, arguments: truncate(event.call.rawArguments, 2_000) }
  }
  if (event.type === 'tool-result') {
    return {
      tool: event.call.toolName,
      callId: event.call.callId,
      isError: event.result.isError,
      output: truncate(JSON.stringify(event.result.isError ? event.result.error : event.result.value), 2_000),
    }
  }
  if (event.type === 'compaction-start') {
    return {
      compactionId: event.compactionId,
      trigger: event.trigger,
      estimatedInputTokens: event.estimatedInputTokens,
    }
  }
  if (event.type === 'compaction-end') {
    return {
      compactionId: event.compactionId, status: event.status,
      before: event.estimatedTokensBefore, after: event.estimatedTokensAfter,
      shadowed: event.shadowedSeqs.length,
    }
  }
  if (event.type === 'assistant-text') {
    return { phase: event.phase, text: truncate(event.text, 2_000) }
  }
  if (event.type === 'agent-end') {
    return {
      completed: event.outcome.completed,
      reason: event.outcome.reason.kind,
      text: truncate(event.outcome.text, 2_000),
      steps: event.outcome.steps,
      toolCalls: event.outcome.toolCalls,
    }
  }
  return undefined
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated]`
}
