import type { JsonObject, ObservationEvent } from '@ai-agent-sdk/core'
import type { LogLevel, LogProjection, MetricProjection, TraceProjection } from './types.ts'

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Project one lifecycle event into a backend-neutral trace record. */
export function projectTrace(event: ObservationEvent): TraceProjection | undefined {
  if (event.name === 'sdk.log' || event.name === 'sdk.exporter.state' || event.name === 'sdk.observer.failure') {
    return undefined
  }
  const status = typeof event.data.status === 'string' ? event.data.status : undefined
  const durationMs = finite(event.data.durationMs)
  return Object.freeze({
    eventId: event.eventId,
    name: event.name,
    phase: event.phase,
    traceId: event.correlation.traceId,
    spanId: event.correlation.spanId,
    parentSpanId: event.correlation.parentSpanId,
    ...status === undefined ? {} : { status },
    ...durationMs === undefined ? {} : { durationMs },
  })
}

/** Project `sdk.log` while retaining explicit correlation. */
export function projectLog(event: ObservationEvent): LogProjection | undefined {
  if (event.name !== 'sdk.log') return undefined
  const level = event.data.level
  const message = event.data.message
  const fields = object(event.data.fields)
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(String(level))
    || typeof message !== 'string' || fields === undefined) return undefined
  return Object.freeze({
    eventId: event.eventId,
    level: level as LogLevel,
    message,
    fields: fields as JsonObject,
    traceId: event.correlation.traceId,
    spanId: event.correlation.spanId,
  })
}

function safeAttributes(event: ObservationEvent): JsonObject {
  const error = object(event.data.error)
  return Object.freeze({
    ...typeof event.data.provider === 'string' ? { provider: event.data.provider } : {},
    ...typeof event.data.operation === 'string' ? { operation: event.data.operation } : {},
    ...typeof event.data.status === 'string' ? { status: event.data.status } : {},
    ...typeof error?.code === 'string' ? { errorCode: error.code } : {},
    ...typeof event.data.executionMode === 'string' ? { executionMode: event.data.executionMode } : {},
  })
}

function usageMetrics(event: ObservationEvent): MetricProjection[] {
  const report = object(event.data.usageReport)
  if (report === undefined) return []
  const coverage = report.coverage
  const output: MetricProjection[] = []
  if (typeof coverage === 'string') output.push(Object.freeze({
    name: 'ai_agent_sdk.usage.coverage', value: 1,
    attributes: Object.freeze({ ...safeAttributes(event), coverage }),
  }))
  for (const [source, counters] of [['reported', object(report.reported)], ['estimated', object(report.estimated)]] as const) {
    if (counters === undefined) continue
    for (const [key, tokenType] of [
      ['inputTokens', 'input'], ['outputTokens', 'output'], ['cacheReadTokens', 'cache-read'],
      ['cacheWriteTokens', 'cache-write'], ['reasoningTokens', 'reasoning'],
    ] as const) {
      const value = finite(counters[key])
      if (value === undefined) continue
      output.push(Object.freeze({
        name: 'ai_agent_sdk.token.usage', value,
        attributes: Object.freeze({ ...safeAttributes(event), tokenType, source }),
      }))
    }
  }
  return output
}

/** Project bounded-cardinality metrics; IDs, URLs, model IDs, and tool names are excluded. */
export function projectMetrics(event: ObservationEvent): readonly MetricProjection[] {
  const output: MetricProjection[] = []
  const durationMs = finite(event.data.durationMs)
  const durationName = event.name === 'sdk.model.call'
    ? 'ai_agent_sdk.model.call.duration'
    : event.name === 'sdk.provider.attempt'
      ? 'ai_agent_sdk.provider.attempt.duration'
      : event.name === 'sdk.tool.call'
        ? 'ai_agent_sdk.tool.call.duration'
        : undefined
  if (event.phase === 'end' && durationName !== undefined && durationMs !== undefined) {
    output.push(Object.freeze({ name: durationName, value: durationMs, attributes: safeAttributes(event) }))
  }
  if (event.name === 'sdk.provider.retry.scheduled') {
    output.push(Object.freeze({ name: 'ai_agent_sdk.provider.retry', value: 1, attributes: safeAttributes(event) }))
  }
  output.push(...usageMetrics(event))
  return Object.freeze(output)
}
