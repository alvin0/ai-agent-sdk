import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentRunEvent } from '@ai-agent-sdk/agent'
import { buildTraceTree, type TraceEvent } from '@ai-agent-sdk/agent'
import type { GenerateOptions } from '@ai-agent-sdk/core'
import type { StressInvariant } from './types.ts'

export type StressRequestKind = 'model' | 'compaction'

export interface StressSkillIoEvent {
  readonly phase: 'discovery' | 'activation' | 'resource'
  readonly operation: 'read' | 'scan'
  readonly path: string
  readonly skillId?: string
  readonly bytesRead?: number
  readonly entriesScanned?: number
}

export interface RequestObservation {
  readonly ordinal: number
  readonly kind: StressRequestKind
  readonly provider: string
  readonly model: string
  readonly systemChars: number
  readonly messageChars: number
  readonly toolCount: number
  readonly systemHasCatalog: boolean
  readonly systemHasSkillContent: boolean
  readonly messagesHaveSkillContent: boolean
  readonly messagesHaveResourceChunk: boolean
  readonly probes: Readonly<Record<string, { readonly system: boolean; readonly messages: boolean }>>
}

export class InvariantRecorder {
  private readonly values: StressInvariant[] = []

  check(name: string, passed: boolean, detail?: string): void {
    this.values.push(Object.freeze({ name, passed, ...(detail === undefined ? {} : { detail }) }))
  }

  equal(name: string, actual: unknown, expected: unknown): void {
    const passed = Object.is(actual, expected)
    this.check(name, passed, passed ? undefined : `expected ${brief(expected)}, received ${brief(actual)}`)
  }

  items(): readonly StressInvariant[] { return Object.freeze([...this.values]) }
}

/** Bounded per-case event/request recorder used by both scripted and live suites. */
export class StressObserver {
  readonly reportDirectory: string
  private readonly eventLog: AgentRunEvent[] = []
  private readonly requestLog: RequestObservation[] = []
  private readonly ioLog: StressSkillIoEvent[] = []
  private readonly probes: Readonly<Record<string, string>>

  constructor(
    reportDirectory: string,
    probes: Readonly<Record<string, string>> = {},
  ) {
    this.reportDirectory = reportDirectory
    this.probes = Object.freeze({ ...probes })
  }

  recordEvent(event: AgentRunEvent): void { this.eventLog.push(event) }

  recordRequest(options: GenerateOptions, kind: StressRequestKind = 'model'): void {
    const system = options.system ?? ''
    const messages = JSON.stringify(options.messages)
    this.requestLog.push(Object.freeze({
      ordinal: this.requestLog.length + 1,
      kind,
      provider: options.provider,
      model: options.model,
      systemChars: system.length,
      messageChars: messages.length,
      toolCount: options.tools?.length ?? 0,
      systemHasCatalog: system.includes('<available_skills>'),
      systemHasSkillContent: system.includes('<skill_content'),
      messagesHaveSkillContent: messages.includes('<skill_content'),
      messagesHaveResourceChunk: messages.includes('[resource chunk'),
      probes: Object.freeze(Object.fromEntries(Object.entries(this.probes).map(([name, probe]) => [
        name, Object.freeze({ system: system.includes(probe), messages: messages.includes(probe) }),
      ]))),
    }))
  }

  recordSkillIo(event: StressSkillIoEvent): void { this.ioLog.push(Object.freeze({ ...event })) }

  events(): readonly AgentRunEvent[] { return Object.freeze([...this.eventLog]) }
  requests(): readonly RequestObservation[] { return Object.freeze([...this.requestLog]) }
  skillIo(): readonly StressSkillIoEvent[] { return Object.freeze([...this.ioLog]) }

  toolNames(): readonly string[] {
    return Object.freeze(this.eventLog.flatMap(event => event.type === 'tool-call' ? [event.call.toolName] : []))
  }

  traceProblems(): readonly string[] {
    const starts = new Map<string, Extract<TraceEvent, { type: 'span-start' }>>()
    const ended = new Set<string>()
    const problems: string[] = []
    for (const event of this.traceEvents()) {
      const id = event.trace.spanId
      if (event.type === 'span-start') {
        if (starts.has(id)) problems.push(`duplicate span start ${id}`)
        starts.set(id, event)
      } else {
        if (!starts.has(id)) problems.push(`span end without start ${id}`)
        if (ended.has(id)) problems.push(`duplicate span end ${id}`)
        ended.add(id)
      }
    }
    for (const id of starts.keys()) if (!ended.has(id)) problems.push(`span without end ${id}`)
    for (const start of starts.values()) {
      const parent = start.trace.parentSpanId
      if (parent !== null && !starts.has(parent)) problems.push(`orphan span ${start.trace.spanId}`)
    }
    return Object.freeze(problems)
  }

  metrics(): Readonly<Record<string, unknown>> {
    const types = this.eventLog.map(event => event.type)
    return Object.freeze({
      events: types.length,
      requests: this.requestLog.length,
      toolCalls: types.filter(type => type === 'tool-call').length,
      toolResults: types.filter(type => type === 'tool-result').length,
      compactionsStarted: types.filter(type => type === 'compaction-start').length,
      compactionsEnded: types.filter(type => type === 'compaction-end').length,
      spansStarted: types.filter(type => type === 'span-start').length,
      spansEnded: types.filter(type => type === 'span-end').length,
      skillIoEvents: this.ioLog.length,
      skillBytes: sum(this.ioLog.map(event => event.bytesRead ?? 0)),
      peakRssBytes: process.memoryUsage().rss,
    })
  }

  async flush(): Promise<void> {
    await mkdir(this.reportDirectory, { recursive: true })
    const eventLines = this.eventLog.map(event => JSON.stringify(sanitize(event))).join('\n')
    await Promise.all([
      writeFile(join(this.reportDirectory, 'events.jsonl'), `${eventLines}${eventLines.length === 0 ? '' : '\n'}`, 'utf8'),
      writeFile(join(this.reportDirectory, 'requests.json'), `${JSON.stringify(this.requestLog, null, 2)}\n`, 'utf8'),
      writeFile(join(this.reportDirectory, 'skill-io.json'), `${JSON.stringify(this.ioLog, null, 2)}\n`, 'utf8'),
      writeFile(join(this.reportDirectory, 'trace.json'), `${JSON.stringify(sanitize(buildTraceTree(this.traceEvents())), null, 2)}\n`, 'utf8'),
    ])
  }

  private traceEvents(): TraceEvent[] {
    return this.eventLog.filter((event): event is TraceEvent =>
      event.type === 'span-start' || event.type === 'span-end')
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length <= 2_000 ? value : `${value.slice(0, 1_900)}… <${value.length} chars>`
  if (value === null || typeof value !== 'object') return value
  if (depth >= 8) return '<max-depth>'
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
    result[key] = key === 'data' && typeof child === 'string'
      ? `<omitted ${child.length} chars>`
      : sanitize(child, depth + 1)
  }
  return result
}

function brief(value: unknown): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  return rendered.length <= 240 ? rendered : `${rendered.slice(0, 216)}… <${rendered.length} chars>`
}

function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0) }
