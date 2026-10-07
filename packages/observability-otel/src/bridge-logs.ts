import {
  ROOT_CONTEXT,
  TraceFlags,
  trace,
  type Context,
} from '@opentelemetry/api'
import {
  type ObservationEvent,
} from '@alvin0/ai-agent-sdk-core'
import {
  projectLog,
  type LogLevel,
} from '@alvin0/ai-agent-sdk-core/observability'

import type { OpenTelemetryLogger, SpanState } from './bridge-types.ts'
export const LOG_SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
})

export function logContext(event: ObservationEvent, states: Map<string, SpanState>): Context {
  const state = states.get(event.correlation.spanId)
  if (state !== undefined) return state.context
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: event.correlation.traceId,
    spanId: event.correlation.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  })
}

export function emitLog(logger: OpenTelemetryLogger | undefined, event: ObservationEvent,
  states: Map<string, SpanState>): void {
  if (logger === undefined) return
  const projected = projectLog(event)
  if (projected === undefined) return
  const severityNumber = LOG_SEVERITY[projected.level]
  const context = logContext(event, states)
  if (logger.enabled?.({ context, severityNumber, eventName: 'ai_agent_sdk.log' }) === false) return
  logger.emit({
    eventName: 'ai_agent_sdk.log',
    timestamp: new Date(event.occurredAt),
    severityNumber,
    severityText: projected.level.toUpperCase(),
    body: projected.message,
    attributes: {
      ...projected.fields,
      'ai_agent_sdk.event.id': projected.eventId,
      'ai_agent_sdk.run.id': event.correlation.runId,
    },
    context,
  })
}
