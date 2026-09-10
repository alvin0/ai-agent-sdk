/**
 * In-memory request traces for the Edge sample.
 *
 * Edge isolates do not provide a filesystem or SQLite, so the trace has the
 * same lifetime as the warm conversation session. The browser receives spans
 * live over SSE and can read completed runs back while that isolate remains
 * warm. A cold start intentionally loses both model history and traces.
 */

import type {
  RuntimeAgentRunEvent,
} from '@alvin0/ai-agent-sdk-core'
import type { AgentRunEvent } from '@alvin0/ai-agent-sdk-core/agent'

export interface WireSpanUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly totalTokens?: number
}

export interface WireSpan {
  readonly runId: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly seq: number
  readonly name: string
  readonly kind: 'invoke_agent' | 'chat' | 'execute_tool' | 'compact'
  readonly startedAt: number
  readonly durationMs: number | null
  readonly status: 'success' | 'error' | 'aborted' | 'unknown'
  readonly member?: string
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly input?: unknown
  readonly output?: unknown
  readonly usage?: WireSpanUsage
  readonly error?: { readonly type: string; readonly message: string; readonly code?: string }
}

export interface TraceSummary {
  readonly runId: string
  readonly traceId: string
  readonly startedAt: number
  readonly durationMs: number | null
  readonly status: WireSpan['status']
  readonly spans: number
  readonly prompt: string
  readonly members: readonly string[]
  readonly usage: {
    readonly inputTokens: number
    readonly cacheReadTokens: number
    readonly outputTokens: number
  }
}

export type TraceEvent = AgentRunEvent | RuntimeAgentRunEvent

const TRACE_LIMIT = 50

/** A run's merged span rows, updated as the SDK opens and closes steps. */
export class RunTrace {
  private readonly rows = new Map<string, WireSpan>()
  private sequence = 0

  constructor(
    private readonly runId: string,
    private readonly prompt: string,
  ) {}

  /** Fold one SDK span lifecycle event into this run. */
  observe(event: TraceEvent, member?: string): WireSpan | undefined {
    if (event.type === 'span-start') {
      const isRoot = event.kind === 'invoke_agent' && event.trace.parentSpanId === null
      const input = event.input ?? (isRoot ? this.prompt : undefined)
      const span: WireSpan = {
        runId: this.runId,
        traceId: event.trace.traceId,
        spanId: event.trace.spanId,
        parentSpanId: event.trace.parentSpanId,
        seq: this.sequence++,
        name: event.name,
        kind: event.kind,
        startedAt: stamp(event.at),
        durationMs: null,
        status: 'unknown',
        ...(member === undefined ? {} : { member }),
        ...(event.attributes === undefined ? {} : { attributes: event.attributes }),
        ...(input === undefined ? {} : { input }),
      }
      this.rows.set(span.spanId, span)
      return span
    }
    if (event.type !== 'span-end') return undefined
    const known = this.rows.get(event.trace.spanId)
    if (known === undefined) return undefined
    const usage = usageOf(event.usage)
    const span: WireSpan = {
      ...known,
      durationMs: Math.max(0, stamp(event.at) - known.startedAt),
      status: event.status,
      ...(event.output === undefined ? {} : { output: event.output }),
      ...(usage === undefined ? {} : { usage }),
      ...(event.error === undefined ? {} : { error: event.error }),
    }
    this.rows.set(span.spanId, span)
    return span
  }

  /** Return rows in the order their spans opened. */
  spans(): readonly WireSpan[] {
    return [...this.rows.values()].sort((left, right) => left.seq - right.seq)
  }

  summary(): TraceSummary {
    const spans = this.spans()
    const root = spans.find(span => span.parentSpanId === null)
    const startedAt = spans.length === 0 ? Date.now() : Math.min(...spans.map(span => span.startedAt))
    const ends = spans
      .filter(span => span.durationMs !== null)
      .map(span => span.startedAt + (span.durationMs ?? 0))
    return {
      runId: this.runId,
      traceId: spans[0]?.traceId ?? '',
      startedAt,
      durationMs: root?.durationMs === null || root === undefined || ends.length === 0
        ? null
        : Math.max(...ends) - startedAt,
      status: root === undefined || root.durationMs === null ? 'unknown' : root.status,
      spans: spans.length,
      prompt: this.prompt,
      members: [...new Set(spans.flatMap(span => span.member === undefined ? [] : [span.member]))],
      usage: totalUsage(spans),
    }
  }
}

/** The trace collection attached to one warm conversation. */
export class TraceStore {
  private readonly runs = new Map<string, RunTrace>()

  start(runId: string, prompt: string): RunTrace {
    const trace = new RunTrace(runId, prompt)
    this.runs.set(runId, trace)
    while (this.runs.size > TRACE_LIMIT) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
    }
    return trace
  }

  list(): readonly TraceSummary[] {
    return [...this.runs.values()]
      .map(trace => trace.summary())
      .sort((left, right) => right.startedAt - left.startedAt)
  }

  read(runId: string): readonly WireSpan[] {
    return this.runs.get(runId)?.spans() ?? []
  }

  has(runId: string): boolean {
    return this.runs.has(runId)
  }

  clear(): void {
    this.runs.clear()
  }
}

function stamp(at: string): number {
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function usageOf(value: unknown): WireSpanUsage | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const result: Record<string, number> = {}
  for (const key of [
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'reasoningTokens', 'totalTokens',
  ]) {
    if (typeof source[key] === 'number') result[key] = source[key] as number
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function totalUsage(spans: readonly WireSpan[]): TraceSummary['usage'] {
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  for (const span of spans) {
    if (span.kind !== 'chat' || span.usage === undefined) continue
    inputTokens += span.usage.inputTokens ?? 0
    cacheReadTokens += span.usage.cacheReadTokens ?? 0
    outputTokens += span.usage.outputTokens ?? 0
  }
  return { inputTokens, cacheReadTokens, outputTokens }
}
