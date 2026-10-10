import {
  SpanStatusCode,
  isSpanContextValid,
  trace,
  type Span,
  type SpanContext,
} from '@opentelemetry/api'
import {
  OBSERVATION_ERROR_CODES,
  deepFreeze,
  freezeCorrelation,
  isSpanId,
  isTraceId,
  safeErrorRecord,
  type ObservationSpan,
  type OpenObservationSpanInput,
  type OperationStatus,
  type SafeErrorRecord,
} from '@alvin0/ai-agent-sdk-core'

import { OpenTelemetryBridgeError, type SpanState, type OpenTelemetryBridgeOptions } from './bridge-types.ts'
import { initialSpan, explicitParent, traceparent } from './bridge-spans.ts'

export interface BridgeContext {
  options: OpenTelemetryBridgeOptions
  states: Map<string, SpanState>
  recordDiagnostic: (error: unknown) => void
}

const MAX_DIAGNOSTICS = 100
export function diagnosticRecorder(options: OpenTelemetryBridgeOptions, diagnostics: SafeErrorRecord[]) {
  return (error: unknown): void => {
    const source = safeErrorRecord(error)
    const safe = deepFreeze({
      type: source.type,
      message: source.code === OBSERVATION_ERROR_CODES.OTEL_PROVIDER_UNCONFIGURED
        ? 'OpenTelemetry tracer provider is unconfigured or returned an invalid context'
        : 'OpenTelemetry bridge API call failed',
      ...source.code === undefined ? {} : { code: source.code },
    })
    diagnostics.push(safe)
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift()
    try { options.onDiagnostic?.(safe) } catch { /* caller diagnostics are contained */ }
  }
}

export function finishSpan(states: Map<string, SpanState>, state: SpanState): void {
  if (state.finished || state.endRequested === undefined) return
  state.finished = true
  states.delete(state.sdkSpanId)
  const request = state.endRequested
  const success = request.status === 'success'
  let failure: unknown
  try {
    state.span.setStatus({
      code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      ...success ? {} : { message: request.status },
    })
  } catch (error) { failure = error }
  try { state.span.end(new Date(request.endedAt)) }
  catch (error) { failure ??= error }
  if (failure !== undefined) throw failure
}

type CheckedSpanContext = SpanContext & Pick<ObservationSpan['correlation'], 'traceId' | 'spanId'>

function checkedSpanContext(
  span: Span, input: OpenObservationSpanInput, states: Map<string, SpanState>,
): CheckedSpanContext {
  let spanContext: SpanContext
  try { spanContext = span.spanContext() }
  catch (error) {
    try { span.end() } catch { /* original failure remains authoritative */ }
    throw error
  }
  if (!validContext(spanContext) || (input.parent !== undefined && spanContext.traceId !== input.parent.traceId)
    || states.has(spanContext.spanId)) {
    try { span.end() } catch { /* invalid identity remains authoritative */ }
    throw new OpenTelemetryBridgeError('supplied tracer returned an invalid or disconnected span context')
  }
  return spanContext
}

function validContext(value: SpanContext): value is CheckedSpanContext {
  return isSpanContextValid(value) && isTraceId(value.traceId) && isSpanId(value.spanId)
    && Number.isInteger(value.traceFlags) && value.traceFlags >= 0 && value.traceFlags <= 255
}

function makeSpanHandle(
  state: SpanState, correlation: ObservationSpan['correlation'], ctx: BridgeContext,
): ObservationSpan {
  let ended = false
  return Object.freeze({
    correlation, traceparent: traceparent(state.spanContext),
    end(status: OperationStatus, endedAt: string): void {
      if (ended) return
      ended = true
      state.endRequested = { status, endedAt }
      if (state.terminalSeen) {
        try { finishSpan(ctx.states, state) }
        catch (error) { ctx.recordDiagnostic(error); throw error }
        return
      }
      queueMicrotask(() => {
        try { finishSpan(ctx.states, state) } catch (error) { ctx.recordDiagnostic(error) }
      })
    },
  })
}

export function openBridgeSpan(input: OpenObservationSpanInput, ctx: BridgeContext): ObservationSpan {
  const initial = initialSpan(input)
  const parentContext = explicitParent(input, ctx.states)
  const span = ctx.options.tracer.startSpan(initial.name, {
    kind: initial.kind, attributes: initial.attributes, startTime: new Date(input.startedAt),
    root: input.parent === undefined,
  }, parentContext)
  const spanContext = checkedSpanContext(span, input, ctx.states)
  const correlation = freezeCorrelation({
    traceId: spanContext.traceId, spanId: spanContext.spanId, parentSpanId: input.parent?.spanId ?? null,
    runId: input.runId, ...(input.correlation ?? {}),
  })
  const state: SpanState = { span, spanContext, context: trace.setSpan(parentContext, span),
    sdkSpanId: spanContext.spanId, terminalSeen: false, finished: false }
  ctx.states.set(state.sdkSpanId, state)
  return makeSpanHandle(state, correlation, ctx)
}
