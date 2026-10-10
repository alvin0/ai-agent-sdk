import {
  ROOT_CONTEXT,
  SpanKind,
  TraceFlags,
  trace,
  type Attributes,
  type Context,
  type Span,
  type SpanContext,
} from '@opentelemetry/api'
import {
  type ObservationEvent,
  type OpenObservationSpanInput,
} from '@alvin0/ai-agent-sdk-core'

import type { SpanState } from './bridge-types.ts'
import { object, counter, string } from './bridge-values.ts'
import { reportedUsageAttributes } from './bridge-usage.ts'
export function initialSpan(input: OpenObservationSpanInput): {
  readonly name: string
  readonly kind: SpanKind
  readonly attributes: Attributes
} {
  const operation = operationName(input.name)
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

export function explicitParent(input: OpenObservationSpanInput, states: Map<string, SpanState>): Context {
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

export function traceparent(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, '0')
  return `00-${context.traceId}-${context.spanId}-${flags}`
}

export function statusAttributes(event: ObservationEvent): Attributes {
  const status = string(event.data.status)
  const error = object(event.data.error)
  const errorType = string(error?.code) ?? string(error?.type) ?? (status === 'success' ? undefined : status)
  return {
    ...status === undefined ? {} : { 'ai_agent_sdk.operation.status': status },
    ...errorType === undefined ? {} : { 'error.type': errorType },
  }
}

export function contentAttributes(event: ObservationEvent): Attributes {
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

export function applySpanEvent(state: SpanState, event: ObservationEvent, allowContent: boolean): void {
  const span = state.span
  const attributes: Attributes = {
    'ai_agent_sdk.event.id': event.eventId,
    'ai_agent_sdk.event.sequence': event.sequence,
    ...statusAttributes(event),
  }
  if (event.correlation.conversationId !== undefined) {
    attributes['gen_ai.conversation.id'] = event.correlation.conversationId
  }
  switch (event.name) {
    case 'sdk.agent.run': applyAgentSpan(span, event, attributes); break
    case 'sdk.model.call': applyModelSpan(span, event, attributes, allowContent); break
    case 'sdk.provider.attempt': applyProviderSpan(event, attributes); break
    case 'sdk.tool.call': applyToolSpan(span, event, attributes); break
  }
  span.setAttributes(attributes)
}

function operationName(name: string): string | undefined {
  if (name === 'sdk.agent.run') return 'invoke_agent'
  if (name === 'sdk.model.call') return 'chat'
  if (name === 'sdk.tool.call') return 'execute_tool'
  return undefined
}

function applyAgentSpan(span: Span, event: ObservationEvent, attributes: Attributes): void {
    const agentId = string(event.data.agentId)
    if (agentId !== undefined) attributes['gen_ai.agent.id'] = agentId
    span.updateName('invoke_agent')
}

function applyModelSpan(span: Span, event: ObservationEvent, attributes: Attributes, allowContent: boolean): void {
    const provider = string(event.data.provider)
    const model = string(event.data.model)
    if (provider !== undefined) attributes['gen_ai.provider.name'] = provider
    if (model !== undefined) {
      attributes[event.phase === 'start' ? 'gen_ai.request.model' : 'gen_ai.response.model'] = model
      span.updateName(`chat ${model}`)
    }
    if (allowContent) Object.assign(attributes, contentAttributes(event))
    if (event.phase === 'end') Object.assign(attributes, reportedUsageAttributes(event))
}

function applyProviderSpan(event: ObservationEvent, attributes: Attributes): void {
    const provider = string(event.data.provider)
    const model = string(event.data.model)
    const method = string(event.data.method)
    const origin = string(event.data.origin)
    if (provider !== undefined) attributes['gen_ai.provider.name'] = provider
    if (model !== undefined) attributes['gen_ai.request.model'] = model
    if (method !== undefined) attributes['http.request.method'] = method
    if (counter(event.data.httpStatus) !== undefined) {
      attributes['http.response.status_code'] = event.data.httpStatus as number
    }
    if (origin !== undefined) {
      try {
        const url = new URL(origin)
        attributes['server.address'] = url.hostname
        attributes['url.scheme'] = url.protocol.slice(0, -1)
        if (url.port.length > 0) attributes['server.port'] = Number(url.port)
      } catch { /* origin was already validated upstream; omit it if a custom event is malformed */ }
    }
}

function applyToolSpan(span: Span, event: ObservationEvent, attributes: Attributes): void {
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
