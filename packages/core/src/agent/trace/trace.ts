import { deepFreeze } from '../../primitives/index.ts'
import { createSpanId, createTraceId, traceparent, type SpanId, type TraceId } from '../../observation/index.ts'
import type { TokenUsage } from '../../stream/index.ts'
export { createSpanId, createTraceId, traceparent }
export type { SpanId, TraceId }

export interface TraceRef {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
}

export type AgentSpanKind = 'invoke_agent' | 'chat' | 'execute_tool' | 'compact'
export type AgentSpanStatus = 'success' | 'error' | 'aborted' | 'unknown'

export interface TraceSpanStart {
  readonly type: 'span-start'
  readonly trace: TraceRef
  readonly at: string
  readonly name: string
  readonly kind: AgentSpanKind
  readonly attributes?: Readonly<Record<string, unknown>>
}

export interface TraceSpanEnd {
  readonly type: 'span-end'
  readonly trace: TraceRef
  readonly at: string
  readonly status: AgentSpanStatus
  readonly output?: unknown
  readonly usage?: TokenUsage
  readonly error?: { readonly type: string; readonly message: string; readonly code?: string }
}

export type TraceEvent = TraceSpanStart | TraceSpanEnd

export interface AgentProcessSpan {
  readonly traceId: TraceId
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
  readonly name: string
  readonly kind: AgentSpanKind
  readonly startedAt: string
  readonly durationMs: number | null
  readonly status: AgentSpanStatus
  readonly attributes?: Readonly<Record<string, unknown>>
  readonly output?: unknown
  readonly usage?: TokenUsage
  readonly error?: TraceSpanEnd['error']
  readonly children: readonly AgentProcessSpan[]
}

/** Project span lifecycle events into the nested shape expected by call-graph UIs. */
export function buildTraceTree(events: readonly TraceEvent[]): readonly AgentProcessSpan[] {
  interface Mutable {
    traceId: TraceId
    spanId: SpanId
    parentSpanId: SpanId | null
    name: string
    kind: AgentSpanKind
    startedAt: string
    durationMs: number | null
    status: AgentSpanStatus
    attributes?: Readonly<Record<string, unknown>>
    output?: unknown
    usage?: TokenUsage
    error?: TraceSpanEnd['error']
    children: Mutable[]
  }
  const roots: Mutable[] = []
  const byId = new Map<SpanId, Mutable>()
  for (const event of events) {
    if (event.type === 'span-start') {
      const span: Mutable = {
        traceId: event.trace.traceId,
        spanId: event.trace.spanId,
        parentSpanId: event.trace.parentSpanId,
        name: event.name,
        kind: event.kind,
        startedAt: event.at,
        durationMs: null,
        status: 'unknown',
        ...event.attributes === undefined ? {} : { attributes: event.attributes },
        children: [],
      }
      byId.set(span.spanId, span)
      const parent = span.parentSpanId === null ? undefined : byId.get(span.parentSpanId)
      if (parent === undefined) roots.push(span)
      else parent.children.push(span)
      continue
    }
    const span = byId.get(event.trace.spanId)
    if (span === undefined) continue
    span.status = event.status
    const start = Date.parse(span.startedAt)
    const end = Date.parse(event.at)
    span.durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
    if (event.output !== undefined) span.output = event.output
    if (event.usage !== undefined) span.usage = event.usage
    if (event.error !== undefined) span.error = event.error
  }
  return deepFreeze(structuredClone(roots))
}
