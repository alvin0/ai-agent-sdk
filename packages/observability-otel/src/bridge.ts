import {
  deepFreeze,
  type ObservationEvent,
  type ObservationSpan,
  type OpenObservationSpanInput,
  type SafeErrorRecord,
} from '@alvin0/ai-agent-sdk-core'
import {
  type ObservationProcessor,
} from '@alvin0/ai-agent-sdk-core/observability'

import type { OpenTelemetryBridgeOptions, OpenTelemetryBridge, SpanState, MetricSinks } from './bridge-types.ts'
export { OTEL_SEMANTIC_CONVENTIONS_COMMIT, OpenTelemetryBridgeError } from './bridge-types.ts'
export type { OpenTelemetryBridgeOptions, OpenTelemetryBridge, OpenTelemetryLogger,
  OpenTelemetryLogRecord, OpenTelemetryLogEnabledOptions } from './bridge-types.ts'
import { diagnosticRecorder, finishSpan, openBridgeSpan, type BridgeContext } from './bridge-lifecycle.ts'
import { applySpanEvent, statusAttributes } from './bridge-spans.ts'
import { createMetricSinks, recordMetrics } from './bridge-metrics.ts'
import { emitLog } from './bridge-logs.ts'

function validateProviders(options: OpenTelemetryBridgeOptions): void {
  if (typeof options?.tracer?.startSpan !== 'function') throw new TypeError('OpenTelemetry bridge requires a tracer')
  if (typeof options?.meter?.createHistogram !== 'function' || typeof options.meter.createCounter !== 'function') {
    throw new TypeError('OpenTelemetry bridge requires a meter')
  }
}

function validateOptions(options: OpenTelemetryBridgeOptions): void {
  validateProviders(options)
  if (!['none', 'metadata', 'redacted', 'full'].includes(options.content ?? 'none')) {
    throw new TypeError('OpenTelemetry bridge content policy is invalid')
  }
  if (options.logger !== undefined && typeof options.logger.emit !== 'function') {
    throw new TypeError('OpenTelemetry bridge logger is invalid')
  }
}

function transformSpan(ctx: BridgeContext, event: ObservationEvent) {
  const state = ctx.states.get(event.correlation.spanId)
  if (state === undefined) return
  applySpanEvent(state, event, ctx.options.content === 'full')
  if (event.phase === 'end') {
    state.terminalSeen = true
    finishSpan(ctx.states, state)
  } else if (event.phase === 'point') {
    state.span.addEvent(event.name, statusAttributes(event), new Date(event.occurredAt))
  }
}

function createProcessor(ctx: BridgeContext, sinks: MetricSinks): ObservationProcessor {
  return Object.freeze({
    id: 'otel',
    transform(event: ObservationEvent): ObservationEvent {
      try {
        transformSpan(ctx, event)
        recordMetrics(sinks, event)
        emitLog(ctx.options.logger, event, ctx.states)
        return event
      } catch (error) { ctx.recordDiagnostic(error); throw error }
    },
  })
}

/** Build a mapping-only bridge around caller-owned OpenTelemetry API objects. */
export function createOpenTelemetryBridge(options: OpenTelemetryBridgeOptions): OpenTelemetryBridge {
  validateOptions(options)
  const states = new Map<string, SpanState>()
  const diagnostics: SafeErrorRecord[] = []
  const recordDiagnostic = diagnosticRecorder(options, diagnostics)
  const ctx = { options, states, recordDiagnostic }
  const sinks = createMetricSinks(options.meter)
  const openSpan = (input: OpenObservationSpanInput): ObservationSpan => {
    try { return openBridgeSpan(input, ctx) }
    catch (error) { recordDiagnostic(error); throw error }
  }
  return Object.freeze({
    openSpan, processor: createProcessor(ctx, sinks), diagnostics: () => deepFreeze([...diagnostics]),
  })
}
