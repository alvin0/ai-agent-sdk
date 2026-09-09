import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  MODEL_ERROR_CODES,
  ModelError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
  type ContentBlock,
  type FinishReason,
  type TextAnnotation,
  type UsageCounters,
} from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk } from './contract.ts'
import type {
  GeminiThoughtState,
  WireAnnotation,
  WireContent,
  WireInteraction,
  WireStepData,
  WireStreamEvent,
  WireUsage,
} from './wire.ts'

type StepKind = 'text' | 'reasoning' | 'tool-call'

interface OpenStep {
  readonly index: number
  readonly kind: StepKind
  text: string
  arguments: string
  readonly initialArguments: unknown
  callId: string
  name: string
  signature: string | undefined
  summary: WireContent[]
  annotations: TextAnnotation[]
}

function stepKind(type: string | undefined): StepKind | undefined {
  if (type === 'model_output') return 'text'
  if (type === 'thought') return 'reasoning'
  if (type === 'function_call') return 'tool-call'
  return undefined
}

function contentList(value: unknown): WireContent[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is WireContent => typeof item === 'object' && item !== null
    && ((item as { type?: unknown }).type === 'text' || (item as { type?: unknown }).type === 'image'))
}

function textOf(contents: readonly WireContent[]): string {
  return contents.filter((item): item is Extract<WireContent, { type: 'text' }> => item.type === 'text')
    .map(item => item.text)
    .join('')
}

function annotationsOf(value: unknown): TextAnnotation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): TextAnnotation[] => {
    if (typeof item !== 'object' || item === null) return []
    const annotation = item as WireAnnotation
    if (annotation.type !== 'url_citation' || typeof annotation.url !== 'string') return []
    return [{
      type: 'url-citation',
      url: annotation.url,
      ...(typeof annotation.title === 'string' ? { title: annotation.title } : {}),
      ...(typeof annotation.start_index === 'number' ? { startIndex: annotation.start_index } : {}),
      ...(typeof annotation.end_index === 'number' ? { endIndex: annotation.end_index } : {}),
      providerState: structuredClone(annotation),
    }]
  })
}

function contentAnnotations(contents: readonly WireContent[]): TextAnnotation[] {
  return contents.flatMap(item => item.type === 'text' ? annotationsOf(item.annotations) : [])
}

function createOpenStep(step: WireStepData, index: number): OpenStep | undefined {
  const kind = stepKind(step.type)
  if (kind === undefined) return undefined
  const content = contentList(step.content)
  const summary = contentList(step.summary)
  return {
    index,
    kind,
    text: kind === 'text' ? textOf(content) : kind === 'reasoning' ? textOf(summary) : '',
    arguments: '',
    initialArguments: step.arguments,
    callId: step.id ?? `call-${index}`,
    name: step.name ?? '',
    signature: step.signature,
    summary,
    annotations: contentAnnotations(content),
  }
}

function blockOf(step: OpenStep): ContentBlock {
  if (step.kind === 'text') {
    return {
      type: 'text', text: step.text,
      ...(step.annotations.length === 0 ? {} : { annotations: step.annotations }),
    }
  }
  if (step.kind === 'reasoning') {
    const state: GeminiThoughtState = {
      ...(step.signature === undefined ? {} : { signature: step.signature }),
      ...(step.summary.length === 0 ? {} : { summary: step.summary }),
    }
    return { type: 'reasoning', text: step.text, providerState: state }
  }
  const argumentsText = step.arguments.length > 0
    ? step.arguments
    : jsonArguments(step.initialArguments)
  return {
    type: 'tool-call', id: ToolCallId(step.callId), name: step.name,
    arguments: argumentsText,
  }
}

function jsonArguments(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '{}'
  return JSON.stringify(value)
}

function thoughtSummaryContent(value: unknown): WireContent[] {
  if (Array.isArray(value)) return contentList(value)
  if (typeof value === 'object' && value !== null) return contentList([value])
  return []
}

function mapUsage(usage: WireUsage): UsageCounters | undefined {
  const source = usage as unknown as Record<string, unknown>
  const rawInput = source.total_input_tokens
  const visibleOutput = source.total_output_tokens
  const cached = source.total_cached_tokens
  const reasoning = source.total_thought_tokens
  const total = source.total_tokens
  if ([rawInput, visibleOutput, cached, reasoning, total].every(value => value === undefined)) return undefined

  // Gemini reports thought tokens beside visible output, while the SDK models
  // reasoning as a subset of the full output bucket. Fold them into output once,
  // then retain the subset for cost breakdowns.
  const output = typeof visibleOutput === 'number' && typeof reasoning === 'number'
    ? visibleOutput + reasoning
    : visibleOutput

  const normalized: Record<string, unknown> = {
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cached === undefined || cached === 0 ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  }
  if (rawInput !== undefined) {
    normalized.inputTokens = typeof rawInput === 'number'
      && (cached === undefined || typeof cached === 'number')
      ? rawInput - (cached ?? 0)
      : rawInput
  }
  return normalized as UsageCounters
}

function errorCode(code: string | undefined, message: string): string {
  const joined = `${code ?? ''} ${message}`.toLowerCase()
  if (/context|token limit|too many tokens/.test(joined)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (/quota|resource_exhausted/.test(joined)) return QUOTA_EXCEEDED_CODE
  if (/invalid_argument|bad request/.test(joined)) return MODEL_ERROR_CODES.INVALID_REQUEST
  if (/rate|too many requests/.test(joined)) return MODEL_ERROR_CODES.RATE_LIMIT
  return MODEL_ERROR_CODES.SERVER
}

function streamError(event: WireStreamEvent, displayName: string): ModelError {
  const message = event.error?.message ?? `${displayName} reported a streaming error`
  return new ModelError(message, errorCode(event.error?.code, message))
}

function finishReason(interaction: WireInteraction | undefined, sawToolCall: boolean): FinishReason {
  const status = interaction?.status
  if (status === 'requires_action' || sawToolCall) return { kind: 'tool-calls' }
  if (status === 'incomplete' || status === 'budget_exceeded') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

export async function* translateGeminiInteractionsStream(
  events: AsyncIterable<ProtocolSseEvent>,
  displayName: string,
  _request?: ProtocolRequest,
): AsyncGenerator<ProtocolStreamChunk> {
  const open = new Map<number, OpenStep>()
  let nextIndex = 0
  let sawToolCall = false

  for await (const raw of events) {
    if (raw.data === '[DONE]') continue
    let event: WireStreamEvent
    try {
      event = JSON.parse(raw.data) as WireStreamEvent
    } catch (error: unknown) {
      throw new ModelError(
        `${displayName} sent a malformed stream event`,
        MODEL_ERROR_CODES.MALFORMED_RESPONSE,
        { cause: error },
      )
    }
    const eventType = event.event_type ?? raw.event

    if (eventType === 'step.start') {
      if (event.index === undefined || event.step === undefined || open.has(event.index)) continue
      const step = createOpenStep(event.step, nextIndex++)
      if (step === undefined) continue
      open.set(event.index, step)
      if (step.kind === 'tool-call') sawToolCall = true
      yield { type: 'block-start', index: step.index, blockType: step.kind }
      if (step.text.length > 0) {
        yield step.kind === 'reasoning'
          ? { type: 'reasoning-delta', index: step.index, text: step.text }
          : { type: 'text-delta', index: step.index, text: step.text }
      }
      continue
    }

    if (eventType === 'step.delta') {
      const step = event.index === undefined ? undefined : open.get(event.index)
      if (step === undefined || event.delta === undefined) continue
      const delta = event.delta
      if (delta.type === 'text' && typeof delta.text === 'string' && step.kind === 'text') {
        step.text += delta.text
        yield { type: 'text-delta', index: step.index, text: delta.text }
      } else if (delta.type === 'arguments_delta' && typeof delta.arguments === 'string'
        && step.kind === 'tool-call') {
        step.arguments += delta.arguments
        yield {
          type: 'tool-call-delta', index: step.index, id: ToolCallId(step.callId),
          ...(step.name.length === 0 ? {} : { name: step.name }),
          argumentsDelta: delta.arguments,
        }
      } else if (delta.type === 'thought_signature' && typeof delta.signature === 'string'
        && step.kind === 'reasoning') {
        step.signature = delta.signature
      } else if (delta.type === 'thought_summary' && step.kind === 'reasoning') {
        const content = thoughtSummaryContent(delta.content)
        const text = textOf(content)
        step.summary.push(...content)
        step.text += text
        if (text.length > 0) yield { type: 'reasoning-delta', index: step.index, text }
      } else if (delta.type === 'text_annotation_delta' && step.kind === 'text') {
        step.annotations.push(...annotationsOf(delta.annotations))
      }
      continue
    }

    if (eventType === 'step.stop') {
      const step = event.index === undefined ? undefined : open.get(event.index)
      if (step === undefined) continue
      yield { type: 'block-end', index: step.index, block: blockOf(step) }
      open.delete(event.index!)
      continue
    }

    if (eventType === 'error') throw streamError(event, displayName)

    if (eventType === 'interaction.completed') {
      const interaction = event.interaction
      if (interaction?.status === 'failed' || interaction?.status === 'cancelled') {
        throw new ModelError(
          `${displayName} interaction ${interaction.status}`,
          MODEL_ERROR_CODES.SERVER,
        )
      }
      // Close any step defensively if a provider omitted its `step.stop` frame.
      for (const step of open.values()) {
        yield { type: 'block-end', index: step.index, block: blockOf(step) }
      }
      const usage = interaction?.usage ?? undefined
      const mapped = usage === undefined ? undefined : mapUsage(usage)
      if (mapped !== undefined) yield { type: 'usage', usage: mapped }
      yield { type: 'finish', reason: finishReason(interaction, sawToolCall) }
      return
    }
  }

  throw new ModelError(
    `${displayName} stream ended before the interaction completed`,
    MODEL_ERROR_CODES.STREAM_CLOSED,
  )
}
