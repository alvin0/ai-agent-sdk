/**
 * Chat Completions SSE events to the SDK's chunk protocol.
 *
 * Four rules drive everything below, and each one exists because the obvious
 * implementation is wrong.
 *
 * First, the tool-call accumulator is keyed on `index`, never on `id`. `id` and
 * `function.name` arrive ONCE, on the first fragment of that call, while
 * `function.arguments` arrives in many fragments that carry only `index`. So
 * `index` is the only correlation key present on every fragment.
 *
 * Second, `arguments` fragments are CONCATENATED as strings and never parsed
 * per fragment. A fragment can split in the middle of a JSON escape sequence or
 * in the middle of a multi-byte character, so an early parse fails on traffic
 * that is perfectly valid once joined.
 *
 * Third, a tool call is emitted only once `finish_reason === 'tool_calls'` has
 * arrived, and the accumulated `arguments` is parsed at exactly that moment. A
 * parse failure there is a protocol error, not an empty tool call: handing a
 * caller `{}` invents an argument list the model never produced.
 *
 * Fourth, `[DONE]` is NOT the terminal finish. Terminal finish is a chunk
 * carrying a `finish_reason` other than `null`. A stream that runs out of
 * events, or reaches `[DONE]`, or is cut mid-way without one is a failure —
 * because a truncated stream is byte-for-byte indistinguishable from a short
 * answer, and nothing above this layer can tell them apart if the translator
 * stays quiet.
 *
 * @module ai-agent-sdk/protocols/openai-chat-completions/translate
 */

import { MODEL_ERROR_CODES, ModelError, ToolCallId  } from '@alvin0/ai-agent-sdk-core'
import type { UsageCounters  } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolSseEvent, ProtocolStreamChunk  } from './contract.ts'
import type {
  WireFinishReason,
  WireStreamChoice,
  WireStreamChunk,
} from './wire.ts'

import { malformed, recordOrUndefined, mapUsage, finishReasonOf, releasesToolCalls,
  inlineError, absorbToolCall, toolCallBlocks, type OpenToolCall, type OpenTextBlock ,
} from './stream-support.ts'

interface StreamState {
  toolCalls: Map<number, OpenToolCall>
  nextIndex: number
  text: OpenTextBlock | undefined
  reasoning: OpenTextBlock | undefined
  followedChoice: number | undefined
  finish: WireFinishReason | undefined
  usage: UsageCounters | undefined
}

function parseChunk(payload: string, displayName: string): WireStreamChunk {
  let chunk: WireStreamChunk
  try { chunk = JSON.parse(payload) as WireStreamChunk }
  catch (error: unknown) { throw malformed(displayName, 'the event data is not JSON', error) }
  if (recordOrUndefined(chunk) === undefined) throw malformed(displayName, 'the event data is not an object')
  if (chunk.error !== undefined && chunk.error !== null) throw inlineError(chunk.error, displayName)
  return chunk
}

function contentOf(delta: WireStreamChoice['delta']): string | undefined {
  if (typeof delta?.content === 'string' && delta.content.length > 0) return delta.content
  if (typeof delta?.refusal === 'string' && delta.refusal.length > 0) return delta.refusal
  return undefined
}

function* reasoningDelta(state: StreamState, delta: WireStreamChoice['delta']): Generator<ProtocolStreamChunk> {
  const text = delta?.reasoning_content
  if (typeof text !== 'string' || text.length === 0) return
  if (state.reasoning === undefined) {
    state.reasoning = { index: state.nextIndex++, text: '' }
    yield { type: 'block-start', index: state.reasoning.index, blockType: 'reasoning' }
  }
  state.reasoning.text += text
  yield { type: 'reasoning-delta', index: state.reasoning.index, text }
}

function* textDelta(state: StreamState, delta: WireStreamChoice['delta']): Generator<ProtocolStreamChunk> {
  const content = contentOf(delta)
  if (content === undefined) return
  if (state.text === undefined) {
    state.text = { index: state.nextIndex++, text: '' }
    yield { type: 'block-start', index: state.text.index, blockType: 'text' }
  }
  state.text.text += content
  yield { type: 'text-delta', index: state.text.index, text: content }
}

function absorbTools(state: StreamState, delta: WireStreamChoice['delta']) {
  if (!Array.isArray(delta?.tool_calls)) return
  for (const fragment of delta.tool_calls) {
    if (recordOrUndefined(fragment) === undefined) continue
    absorbToolCall(state.toolCalls, fragment, () => state.nextIndex++)
  }
}

function* closeBlocks(state: StreamState, reason: WireFinishReason, displayName: string)
  : Generator<ProtocolStreamChunk> {
  state.finish = reason
  if (state.reasoning !== undefined) {
    yield { type: 'block-end', index: state.reasoning.index,
      block: { type: 'reasoning', text: state.reasoning.text } }
  }
  if (state.text !== undefined) {
    yield { type: 'block-end', index: state.text.index, block: { type: 'text', text: state.text.text } }
  }
  if (releasesToolCalls(reason)) {
    for (const call of toolCallBlocks(state.toolCalls, displayName)) {
      yield { type: 'block-start', index: call.index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: call.index, id: ToolCallId(call.id),
        name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: call.index, block: call.block }
    }
  }
  // Other finishes truncate or contradict the accumulated calls; never release them.
  state.toolCalls.clear()
}

function* processChoice(state: StreamState, choice: WireStreamChoice, displayName: string)
  : Generator<ProtocolStreamChunk> {
  if (recordOrUndefined(choice) === undefined) return
  const index = typeof choice.index === 'number' ? choice.index : 0
  state.followedChoice ??= index
  if (index !== state.followedChoice || state.finish !== undefined) return
  const delta = recordOrUndefined(choice.delta) === undefined ? undefined : choice.delta
  yield* reasoningDelta(state, delta)
  yield* textDelta(state, delta)
  absorbTools(state, delta)
  const reason = choice.finish_reason
  if (reason !== undefined && reason !== null) yield* closeBlocks(state, reason, displayName)
}

/** Translate a single choice while draining trailing usage after its terminal finish. */
export async function* translateChatCompletionsStream(
  events: AsyncIterable<ProtocolSseEvent>, displayName: string,
): AsyncGenerator<ProtocolStreamChunk> {
  const state: StreamState = { toolCalls: new Map(), nextIndex: 0, text: undefined,
    reasoning: undefined, followedChoice: undefined, finish: undefined, usage: undefined }
  for await (const raw of events) {
    const payload = raw.data.trim()
    if (payload.length === 0 || payload === '[DONE]') continue
    const chunk = parseChunk(payload, displayName)
    updateUsage(state, chunk)
    const choices: readonly WireStreamChoice[] = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) yield* processChoice(state, choice, displayName)
  }
  if (state.finish === undefined) {
    throw new ModelError(`${displayName} stream ended without a finish reason`, MODEL_ERROR_CODES.STREAM_CLOSED)
  }
  if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
  yield { type: 'finish', reason: finishReasonOf(state.finish) }
}

function updateUsage(state: StreamState, chunk: WireStreamChunk) {
  if (chunk.usage !== undefined && chunk.usage !== null) state.usage = mapUsage(chunk.usage) ?? state.usage
}
