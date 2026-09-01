import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  isSpanContextValid,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api'
import {
  OBSERVATION_ERROR_CODES,
  deepFreeze,
  freezeCorrelation,
  isSpanId,
  isTraceId,
  safeErrorRecord,
  type ObservationEvent,
  type ObservationPort,
  type ObservationSpan,
  type OpenObservationSpanInput,
  type OperationStatus,
  type SafeErrorRecord,
} from '@ai-agent-sdk/core'
import {
  projectLog,
  projectMetrics,
  type LogLevel,
  type ObservationContentPolicy,
  type ObservationProcessor,
} from '@ai-agent-sdk/observability'

export const OTEL_SEMANTIC_CONVENTIONS_COMMIT = '5ca9052bc796ef1e497200b1d558fd87a201f335'

const MAX_DIAGNOSTICS = 100
const LOG_SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
})

export class OpenTelemetryBridgeError extends Error {
  override readonly name = 'OpenTelemetryBridgeError'
  readonly code = OBSERVATION_ERROR_CODES.OTEL_PROVIDER_UNCONFIGURED
}

export interface OpenTelemetryBridgeOptions {
  readonly tracer: Tracer
  readonly meter: Meter
  readonly logger?: OpenTelemetryLogger
  /** Exact prompt/completion span attributes remain disabled unless this is explicitly `full`. */
  readonly content?: ObservationContentPolicy
  readonly onDiagnostic?: (error: SafeErrorRecord) => void
}

export interface OpenTelemetryBridge {
  readonly openSpan: ObservationPort['openSpan']
  readonly processor: ObservationProcessor
  diagnostics(): readonly SafeErrorRecord[]
}

/** Structural log API so consumers that omit logging need not install the optional logs peer. */
export interface OpenTelemetryLogger {
  emit(record: OpenTelemetryLogRecord): void
  enabled?(options?: OpenTelemetryLogEnabledOptions): boolean
}

export interface OpenTelemetryLogRecord {
  readonly context?: Context
  readonly [key: string]: unknown
}

export interface OpenTelemetryLogEnabledOptions {
  readonly context?: Context
  readonly [key: string]: unknown
}

interface SpanState {
  readonly span: Span
  readonly context: Context
  readonly spanContext: SpanContext
  readonly sdkSpanId: string
  endRequested?: { readonly status: OperationStatus; readonly endedAt: string }
  terminalSeen: boolean
  finished: boolean
}

interface MetricSinks {
  readonly sdkModelDuration: Histogram
  readonly sdkProviderDuration: Histogram
  readonly sdkToolDuration: Histogram
  readonly sdkTokenUsage: Counter
  readonly sdkUsageCoverage: Counter
  readonly sdkProviderRetry: Counter
  readonly genAiClientDuration: Histogram
  readonly genAiTokenUsage: Histogram
  readonly genAiAgentDuration: Histogram
  readonly genAiToolDuration: Histogram
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function counter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function initialSpan(input: OpenObservationSpanInput): {
  readonly name: string
  readonly kind: SpanKind
  readonly attributes: Attributes
} {
  const operation = input.name === 'sdk.agent.run'
    ? 'invoke_agent'
    : input.name === 'sdk.model.call'
      ? 'chat'
      : input.name === 'sdk.tool.call'
        ? 'execute_tool'
        : undefined
  return {
    name: operation ?? input.name,
    kind: input.name === 'sdk.model.call' || input.name === 'sdk.provider.attempt'
      ? SpanKind.CLIENT
      : SpanKind.INTERNAL,
    attributes: {
      'ai_agent_sdk.operation.name': input.name,
      'ai_agent_sdk.run.id': input.runId,
      ...operation === undefined ? {} : { 'gen_ai.operation.name': operation },
    },
  }
}

function explicitParent(input: OpenObservationSpanInput, states: Map<string, SpanState>): Context {
  if (input.parent === undefined) return ROOT_CONTEXT
  const owned = states.get(input.parent.spanId)
  if (owned !== undefined) return owned.context
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: input.parent.traceId,
    spanId: input.parent.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  })
}

function traceparent(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, '0')
  return `00-${context.traceId}-${context.spanId}-${flags}`
}

function statusAttributes(event: ObservationEvent): Attributes {
  const status = string(event.data.status)
  const error = object(event.data.error)
  const errorType = string(error?.code) ?? string(error?.type) ?? (status === 'success' ? undefined : status)
  return {
    ...status === undefined ? {} : { 'ai_agent_sdk.operation.status': status },
    ...errorType === undefined ? {} : { 'error.type': errorType },
  }
}

function contentAttributes(event: ObservationEvent): Attributes {
  const input = event.data.inputMessages ?? event.data.prompt
  const output = event.data.outputMessages ?? event.data.completion ?? event.data.response
  const render = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  const renderedInput = render(input)
  const renderedOutput = render(output)
  return {
    ...renderedInput === undefined ? {} : { 'gen_ai.input.messages': renderedInput },
    ...renderedOutput === undefined ? {} : { 'gen_ai.output.messages': renderedOutput },
  }
}

function applySpanEvent(state: SpanState, event: ObservationEvent, allowContent: boolean): void {
  const span = state.span
  const attributes: Attributes = {
    'ai_agent_sdk.event.id': event.eventId,
    'ai_agent_sdk.event.sequence': event.sequence,
    ...statusAttributes(event),
  }
  if (event.correlation.conversationId !== undefined) {
    attributes['gen_ai.conversation.id'] = event.correlation.conversationId
  }
  if (event.name === 'sdk.agent.run') {
    const agentId = string(event.data.agentId)
    if (agentId !== undefined) attributes['gen_ai.agent.id'] = agentId
    span.updateName('invoke_agent')
  } else if (event.name === 'sdk.model.call') {
    const provider = string(event.data.provider)
    const model = string(event.data.model)
    if (provider !== undefined) attributes['gen_ai.provider.name'] = provider
    if (model !== undefined) {
      attributes[event.phase === 'start' ? 'gen_ai.request.model' : 'gen_ai.response.model'] = model
      span.updateName(`chat ${model}`)
    }
    if (allowContent) Object.assign(attributes, contentAttributes(event))
    if (event.phase === 'end') Object.assign(attributes, reportedUsageAttributes(event))
  } else if (event.name === 'sdk.provider.attempt') {
    const provider = string(event.data.provider)
    const model = string(event.data.model)
    const method = string(event.data.method)
    const origin = string(event.data.origin)
    if (provider !== undefined) attributes['gen_ai.provider.name'] = provider
    if (model !== undefined) attributes['gen_ai.request.model'] = model
    if (method !== undefined) attributes['http.request.method'] = method
    if (counter(event.data.httpStatus) !== undefined) attributes['http.response.status_code'] = event.data.httpStatus as number
    if (origin !== undefined) {
      try {
        const url = new URL(origin)
        attributes['server.address'] = url.hostname
        attributes['url.scheme'] = url.protocol.slice(0, -1)
        if (url.port.length > 0) attributes['server.port'] = Number(url.port)
      } catch { /* origin was already validated upstream; omit it if a custom event is malformed */ }
    }
  } else if (event.name === 'sdk.tool.call') {
    const explicitName = string(event.data.toolName)
    const legacyName = string(event.data.name)?.replace(/^execute_tool\s+/, '')
    const toolName = explicitName ?? legacyName
    if (toolName !== undefined) {
      attributes['gen_ai.tool.name'] = toolName
      span.updateName(`execute_tool ${toolName}`)
    }
    if (event.correlation.toolCallId !== undefined) {
      attributes['gen_ai.tool.call.id'] = event.correlation.toolCallId
    }
  }
  span.setAttributes(attributes)
}

function reportedUsage(event: ObservationEvent): Readonly<Record<string, unknown>> | undefined {
  const direct = object(event.data.reported)
  if (direct !== undefined) return direct
  return object(object(event.data.usageReport)?.reported) ?? object(object(event.data.usage)?.reported)
}

function estimatedUsage(event: ObservationEvent): Readonly<Record<string, unknown>> | undefined {
  return object(object(event.data.usageReport)?.estimated) ?? object(object(event.data.usage)?.estimated)
}

function reportedUsageAttributes(event: ObservationEvent): Attributes {
  const usage = reportedUsage(event)
  if (usage === undefined) return {}
  const uncached = counter(usage.inputTokens)
  const cacheRead = counter(usage.cacheReadTokens)
  const cacheWrite = counter(usage.cacheWriteTokens)
  const output = counter(usage.outputTokens)
  const inputParts = [uncached, cacheRead, cacheWrite].filter((value): value is number => value !== undefined)
  const input = inputParts.length === 0 ? undefined : inputParts.reduce((sum, value) => sum + value, 0)
  return {
    ...input === undefined || !Number.isSafeInteger(input) ? {} : { 'gen_ai.usage.input_tokens': input },
    ...output === undefined ? {} : { 'gen_ai.usage.output_tokens': output },
    ...cacheRead === undefined ? {} : { 'gen_ai.usage.cache_read.input_tokens': cacheRead },
    ...cacheWrite === undefined ? {} : { 'gen_ai.usage.cache_write.input_tokens': cacheWrite },
    ...counter(usage.reasoningTokens) === undefined
      ? {}
      : { 'gen_ai.usage.reasoning.output_tokens': usage.reasoningTokens as number },
  }
}

function metricAttributes(event: ObservationEvent): Attributes {
  const error = object(event.data.error)
  return {
    ...string(event.data.provider) === undefined ? {} : { 'gen_ai.provider.name': event.data.provider as string },
    ...string(event.data.operation) === undefined ? {} : { 'ai_agent_sdk.operation': event.data.operation as string },
    ...string(event.data.status) === undefined ? {} : { 'ai_agent_sdk.status': event.data.status as string },
    ...string(error?.code) === undefined ? {} : { 'error.type': error?.code as string },
  }
}

function recordInternalUsage(sinks: MetricSinks, event: ObservationEvent): void {
  if (event.phase !== 'end') return
  const reported = reportedUsage(event)
  const estimated = estimatedUsage(event)
  const base = metricAttributes(event)
  if (event.name === 'sdk.model.call') {
    recordCounterSet(sinks.sdkTokenUsage, reported, 'reported', base)
    recordCounterSet(sinks.sdkTokenUsage, estimated, 'estimated', base)
    const coverage = string(event.data.coverage) ?? string(object(event.data.usageReport)?.coverage)
    if (coverage !== undefined) sinks.sdkUsageCoverage.add(1, { ...base, 'ai_agent_sdk.usage.coverage': coverage })
    recordSemanticUsage(sinks, reported, base)
  } else if (event.name === 'sdk.agent.run') {
    recordCounterSet(sinks.sdkTokenUsage, estimated, 'estimated', base)
    const coverage = object(object(event.data.usage)?.coverage)
    for (const state of ['complete', 'partial', 'estimated', 'missing', 'notApplicable'] as const) {
      const value = counter(coverage?.[state])
      if (value !== undefined && value > 0) sinks.sdkUsageCoverage.add(value, {
        ...base,
        'ai_agent_sdk.usage.coverage': state === 'notApplicable' ? 'not-applicable' : state,
      })
    }
  }
}

function recordCounterSet(
  instrument: Counter,
  values: Readonly<Record<string, unknown>> | undefined,
  source: 'reported' | 'estimated',
  base: Attributes,
): void {
  if (values === undefined) return
  for (const [key, tokenType] of [
    ['inputTokens', 'input'],
    ['outputTokens', 'output'],
    ['cacheReadTokens', 'cache-read'],
    ['cacheWriteTokens', 'cache-write'],
    ['reasoningTokens', 'reasoning'],
  ] as const) {
    const value = counter(values[key])
    if (value !== undefined) instrument.add(value, {
      ...base,
      'ai_agent_sdk.token.type': tokenType,
      'ai_agent_sdk.usage.source': source,
    })
  }
}

function recordSemanticUsage(
  sinks: MetricSinks,
  values: Readonly<Record<string, unknown>> | undefined,
  base: Attributes,
): void {
  if (values === undefined) return
  const uncached = counter(values.inputTokens)
  const cacheRead = counter(values.cacheReadTokens) ?? 0
  const cacheWrite = counter(values.cacheWriteTokens) ?? 0
  const output = counter(values.outputTokens)
  const hasInput = uncached !== undefined
    || counter(values.cacheReadTokens) !== undefined
    || counter(values.cacheWriteTokens) !== undefined
  if (hasInput) {
    const input = (uncached ?? 0) + cacheRead + cacheWrite
    if (Number.isSafeInteger(input)) sinks.genAiTokenUsage.record(input, {
      ...base,
      'gen_ai.operation.name': 'chat',
      'gen_ai.token.type': 'input',
      'ai_agent_sdk.usage.source': 'reported',
    })
  }
  if (output !== undefined) sinks.genAiTokenUsage.record(output, {
    ...base,
    'gen_ai.operation.name': 'chat',
    'gen_ai.token.type': 'output',
    'ai_agent_sdk.usage.source': 'reported',
  })
}

function recordMetrics(sinks: MetricSinks, event: ObservationEvent): void {
  const base = metricAttributes(event)
  for (const projection of projectMetrics(event)) {
    const attributes = { ...base, ...projection.attributes } as Attributes
    switch (projection.name) {
      case 'ai_agent_sdk.model.call.duration':
        sinks.sdkModelDuration.record(projection.value, attributes)
        sinks.genAiClientDuration.record(projection.value / 1_000, {
          ...base, 'gen_ai.operation.name': 'chat',
        })
        break
      case 'ai_agent_sdk.provider.attempt.duration': sinks.sdkProviderDuration.record(projection.value, attributes); break
      case 'ai_agent_sdk.tool.call.duration':
        sinks.sdkToolDuration.record(projection.value, attributes)
        sinks.genAiToolDuration.record(projection.value / 1_000, {
          ...base, 'gen_ai.operation.name': 'execute_tool',
        })
        break
      case 'ai_agent_sdk.provider.retry': sinks.sdkProviderRetry.add(projection.value, attributes); break
      // Usage is mapped from the canonical reported/estimated shapes below so
      // model, attempt, and run aggregates cannot double count one call.
      case 'ai_agent_sdk.token.usage':
      case 'ai_agent_sdk.usage.coverage': break
    }
  }
  if (event.name === 'sdk.agent.run' && event.phase === 'end') {
    const duration = finite(event.data.durationMs)
    if (duration !== undefined) sinks.genAiAgentDuration.record(duration / 1_000, {
      ...base, 'gen_ai.operation.name': 'invoke_agent',
    })
  }
  recordInternalUsage(sinks, event)
}

function createMetricSinks(meter: Meter): MetricSinks {
  return {
    sdkModelDuration: meter.createHistogram('ai_agent_sdk.model.call.duration', { unit: 'ms' }),
    sdkProviderDuration: meter.createHistogram('ai_agent_sdk.provider.attempt.duration', { unit: 'ms' }),
    sdkToolDuration: meter.createHistogram('ai_agent_sdk.tool.call.duration', { unit: 'ms' }),
    sdkTokenUsage: meter.createCounter('ai_agent_sdk.token.usage', { unit: '{token}' }),
    sdkUsageCoverage: meter.createCounter('ai_agent_sdk.usage.coverage', { unit: '{call}' }),
    sdkProviderRetry: meter.createCounter('ai_agent_sdk.provider.retry', { unit: '{retry}' }),
    genAiClientDuration: meter.createHistogram('gen_ai.client.operation.duration', { unit: 's' }),
    genAiTokenUsage: meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}' }),
    genAiAgentDuration: meter.createHistogram('gen_ai.invoke_agent.duration', { unit: 's' }),
    genAiToolDuration: meter.createHistogram('gen_ai.execute_tool.duration', { unit: 's' }),
  }
}

function logContext(event: ObservationEvent, states: Map<string, SpanState>): Context {
  const state = states.get(event.correlation.spanId)
  if (state !== undefined) return state.context
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: event.correlation.traceId,
    spanId: event.correlation.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  })
}

function emitLog(logger: OpenTelemetryLogger | undefined, event: ObservationEvent, states: Map<string, SpanState>): void {
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

/** Build a mapping-only bridge around caller-owned OpenTelemetry API objects. */
export function createOpenTelemetryBridge(options: OpenTelemetryBridgeOptions): OpenTelemetryBridge {
  if (typeof options?.tracer?.startSpan !== 'function') throw new TypeError('OpenTelemetry bridge requires a tracer')
  if (typeof options?.meter?.createHistogram !== 'function' || typeof options.meter.createCounter !== 'function') {
    throw new TypeError('OpenTelemetry bridge requires a meter')
  }
  if (!['none', 'metadata', 'redacted', 'full'].includes(options.content ?? 'none')) {
    throw new TypeError('OpenTelemetry bridge content policy is invalid')
  }
  if (options.logger !== undefined && typeof options.logger.emit !== 'function') {
    throw new TypeError('OpenTelemetry bridge logger is invalid')
  }
  const states = new Map<string, SpanState>()
  const diagnostics: SafeErrorRecord[] = []
  const sinks = createMetricSinks(options.meter)
  const recordDiagnostic = (error: unknown): void => {
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
  const finish = (state: SpanState): void => {
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
  const openSpanImpl = (input: OpenObservationSpanInput): ObservationSpan => {
    const initial = initialSpan(input)
    const parentContext = explicitParent(input, states)
    const span = options.tracer.startSpan(initial.name, {
      kind: initial.kind,
      attributes: initial.attributes,
      startTime: new Date(input.startedAt),
      root: input.parent === undefined,
    }, parentContext)
    let spanContext: SpanContext
    try { spanContext = span.spanContext() }
    catch (error) {
      try { span.end() } catch { /* original failure remains authoritative */ }
      throw error
    }
    if (!isSpanContextValid(spanContext) || !isTraceId(spanContext.traceId) || !isSpanId(spanContext.spanId)
      || !Number.isInteger(spanContext.traceFlags) || spanContext.traceFlags < 0 || spanContext.traceFlags > 255
      || (input.parent !== undefined && spanContext.traceId !== input.parent.traceId)
      || states.has(spanContext.spanId)) {
      try { span.end() } catch { /* invalid identity remains authoritative */ }
      const error = new OpenTelemetryBridgeError('supplied tracer returned an invalid or disconnected span context')
      throw error
    }
    const correlation = freezeCorrelation({
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId: input.parent?.spanId ?? null,
      runId: input.runId,
      ...(input.correlation ?? {}),
    })
    const state: SpanState = {
      span,
      spanContext,
      context: trace.setSpan(parentContext, span),
      sdkSpanId: spanContext.spanId,
      terminalSeen: false,
      finished: false,
    }
    states.set(state.sdkSpanId, state)
    let ended = false
    return Object.freeze({
      correlation,
      traceparent: traceparent(spanContext),
      end(status: OperationStatus, endedAt: string): void {
        if (ended) return
        ended = true
        state.endRequested = { status, endedAt }
        if (state.terminalSeen) {
          try { finish(state) }
          catch (error) { recordDiagnostic(error); throw error }
          return
        }
        queueMicrotask(() => {
          try { finish(state) } catch (error) { recordDiagnostic(error) }
        })
      },
    })
  }
  const openSpan = (input: OpenObservationSpanInput): ObservationSpan => {
    try { return openSpanImpl(input) }
    catch (error) { recordDiagnostic(error); throw error }
  }
  const processor: ObservationProcessor = Object.freeze({
    id: 'otel',
    transform(event: ObservationEvent): ObservationEvent {
      try {
        const state = states.get(event.correlation.spanId)
        if (state !== undefined) {
          applySpanEvent(state, event, options.content === 'full')
          if (event.phase === 'end') {
            state.terminalSeen = true
            finish(state)
          } else if (event.phase === 'point') {
            state.span.addEvent(event.name, statusAttributes(event), new Date(event.occurredAt))
          }
        }
        recordMetrics(sinks, event)
        emitLog(options.logger, event, states)
        return event
      } catch (error) {
        recordDiagnostic(error)
        throw error
      }
    },
  })
  return Object.freeze({
    openSpan,
    processor,
    diagnostics: () => deepFreeze([...diagnostics]),
  })
}
