import {
  ToolCallId,
  type ContentBlock,
  type TextAnnotation,
} from '@alvin0/ai-agent-sdk-core'
import type { ProtocolStreamChunk  } from './contract.ts'
import type {
  GeminiThoughtState,
  WireAnnotation,
  WireContent,
  WireStepData,
  WireStreamEvent,
} from './wire.ts'

type StepKind = 'text' | 'reasoning' | 'tool-call'

export interface OpenStep {
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

export function createOpenStep(step: WireStepData, index: number): OpenStep | undefined {
  const kind = stepKind(step.type)
  if (kind === undefined) return undefined
  const content = contentList(step.content)
  const summary = contentList(step.summary)
  return {
    index,
    kind,
    text: initialStepText(kind, content, summary),
    arguments: '',
    initialArguments: step.arguments,
    callId: step.id ?? `call-${index}`,
    name: step.name ?? '',
    signature: step.signature,
    summary,
    annotations: contentAnnotations(content),
  }
}

export function blockOf(step: OpenStep): ContentBlock {
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

function initialStepText(kind: StepKind, content: WireContent[], summary: WireContent[]) {
  if (kind === 'text') return textOf(content)
  if (kind === 'reasoning') return textOf(summary)
  return ''
}

function* textDelta(step: OpenStep, delta: NonNullable<WireStreamEvent['delta']>): Generator<ProtocolStreamChunk> {
  if (delta.type === 'text' && typeof delta.text === 'string') {
    step.text += delta.text
    yield { type: 'text-delta', index: step.index, text: delta.text }
  } else if (delta.type === 'text_annotation_delta') {
    step.annotations.push(...annotationsOf(delta.annotations))
  }
}

function* reasoningDelta(step: OpenStep, delta: NonNullable<WireStreamEvent['delta']>)
  : Generator<ProtocolStreamChunk> {
  if (delta.type === 'thought_signature' && typeof delta.signature === 'string') {
    step.signature = delta.signature
  } else if (delta.type === 'thought_summary') {
    const content = thoughtSummaryContent(delta.content)
    const text = textOf(content)
    step.summary.push(...content)
    step.text += text
    if (text.length > 0) yield { type: 'reasoning-delta', index: step.index, text }
  }
}

export function* translateStepDelta(step: OpenStep, delta: NonNullable<WireStreamEvent['delta']>)
  : Generator<ProtocolStreamChunk> {
  if (step.kind === 'text') { yield* textDelta(step, delta); return }
  if (step.kind === 'reasoning') { yield* reasoningDelta(step, delta); return }
  if (delta.type !== 'arguments_delta' || typeof delta.arguments !== 'string') return
  step.arguments += delta.arguments
  yield { type: 'tool-call-delta', index: step.index, id: ToolCallId(step.callId),
    ...(step.name.length === 0 ? {} : { name: step.name }), argumentsDelta: delta.arguments }
}
