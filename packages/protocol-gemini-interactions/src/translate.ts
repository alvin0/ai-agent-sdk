import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  MODEL_ERROR_CODES,
  ModelError,
  QUOTA_EXCEEDED_CODE,
  type FinishReason,
  type UsageCounters,
} from '@alvin0/ai-agent-sdk-core'
import type { ProtocolRequest, ProtocolSseEvent, ProtocolStreamChunk  } from './contract.ts'
import type {
  WireInteraction,
  WireStreamEvent,
  WireUsage,
} from './wire.ts'

import { createOpenStep, blockOf, translateStepDelta, type OpenStep  } from './stream-step.ts'

function uncachedInput(rawInput: unknown, cached: unknown): unknown {
  return typeof rawInput === 'number' && (cached === undefined || typeof cached === 'number')
    ? rawInput - (cached ?? 0) : rawInput
}

function fullOutput(visible: unknown, reasoning: unknown): unknown {
  return typeof visible === 'number' && typeof reasoning === 'number' ? visible + reasoning : visible
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
  const output = fullOutput(visibleOutput, reasoning)

  const normalized: Record<string, unknown> = {
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(total === undefined ? {} : { totalTokens: total }),
    ...(cached === undefined || cached === 0 ? {} : { cacheReadTokens: cached }),
    ...(reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning }),
  }
  if (rawInput !== undefined) normalized.inputTokens = uncachedInput(rawInput, cached)
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

interface StreamState {
  open: Map<number, OpenStep>
  nextIndex: number
  sawToolCall: boolean
}

function parseEvent(raw: ProtocolSseEvent, displayName: string): WireStreamEvent {
  try { return JSON.parse(raw.data) as WireStreamEvent }
  catch (error: unknown) {
    throw new ModelError(
      `${displayName} sent a malformed stream event`, MODEL_ERROR_CODES.MALFORMED_RESPONSE, { cause: error },
    )
  }
}

function* startStep(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  if (event.index === undefined || event.step === undefined || state.open.has(event.index)) return
  const step = createOpenStep(event.step, state.nextIndex++)
  if (step === undefined) return
  state.open.set(event.index, step)
  if (step.kind === 'tool-call') state.sawToolCall = true
  yield { type: 'block-start', index: step.index, blockType: step.kind }
  if (step.text.length > 0) {
    yield step.kind === 'reasoning'
      ? { type: 'reasoning-delta', index: step.index, text: step.text }
      : { type: 'text-delta', index: step.index, text: step.text }
  }
}

function* updateStep(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const step = event.index === undefined ? undefined : state.open.get(event.index)
  if (step !== undefined && event.delta !== undefined) yield* translateStepDelta(step, event.delta)
}

function* stopStep(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const step = event.index === undefined ? undefined : state.open.get(event.index)
  if (step === undefined) return
  yield { type: 'block-end', index: step.index, block: blockOf(step) }
  state.open.delete(event.index!)
}

function* completeInteraction(state: StreamState, event: WireStreamEvent, displayName: string)
  : Generator<ProtocolStreamChunk> {
  const interaction = event.interaction
  if (interaction?.status === 'failed' || interaction?.status === 'cancelled') {
    throw new ModelError(`${displayName} interaction ${interaction.status}`, MODEL_ERROR_CODES.SERVER)
  }
  // Close steps defensively if the provider omitted their step.stop frames.
  for (const step of state.open.values()) yield { type: 'block-end', index: step.index, block: blockOf(step) }
  const usage = interaction?.usage ?? undefined
  const mapped = usage === undefined ? undefined : mapUsage(usage)
  if (mapped !== undefined) yield { type: 'usage', usage: mapped }
  yield { type: 'finish', reason: finishReason(interaction, state.sawToolCall) }
}

export async function* translateGeminiInteractionsStream(
  events: AsyncIterable<ProtocolSseEvent>, displayName: string, _request?: ProtocolRequest,
): AsyncGenerator<ProtocolStreamChunk> {
  const state: StreamState = { open: new Map(), nextIndex: 0, sawToolCall: false }
  for await (const raw of events) {
    if (raw.data === '[DONE]') continue
    const event = parseEvent(raw, displayName)
    switch (event.event_type ?? raw.event) {
      case 'step.start': yield* startStep(state, event); break
      case 'step.delta': yield* updateStep(state, event); break
      case 'step.stop': yield* stopStep(state, event); break
      case 'error': throw streamError(event, displayName)
      case 'interaction.completed': yield* completeInteraction(state, event, displayName); return
    }
  }
  throw new ModelError(
    `${displayName} stream ended before the interaction completed`, MODEL_ERROR_CODES.STREAM_CLOSED,
  )
}
