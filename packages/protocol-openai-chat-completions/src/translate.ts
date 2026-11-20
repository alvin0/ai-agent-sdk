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

import { MODEL_ERROR_CODES, ModelError, TextAccumulator, ToolCallId  } from '@alvin0/ai-agent-sdk-core'
import type { UsageCounters  } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolSseEvent, ProtocolStreamChunk  } from './contract.ts'
import { CHAT_COMPLETIONS_REPLAY_MARKER } from './reasoning.ts'
import type { ChatCompletionsReasoningField, ChatCompletionsReasoningState } from './reasoning.ts'
import type {
  WireFinishReason,
  WireStreamChoice,
  WireStreamChunk,
} from './wire.ts'
import { LeadingThinkSplitter } from './think-tags.ts'

import { chatCompletionsStreamError } from './errors.ts'
import { malformed, recordOrUndefined, mapUsage, finishReasonOf, releasesToolCalls,
  absorbToolCall, toolCallBlocks, type OpenToolCall, type OpenTextBlock ,
} from './stream-support.ts'

interface StreamState {
  toolCalls: Map<number, OpenToolCall>
  nextIndex: number
  text: OpenTextBlock | undefined
  reasoning: OpenTextBlock | undefined
  /** First field reasoning arrived on; decides how it may be replayed. */
  reasoningField: ChatCompletionsReasoningField | undefined
  /** Absent when the endpoint's `content` must never be read for `<think>` tags. */
  think: LeadingThinkSplitter | undefined
  /** Upstream model id stamped on reasoning, so replay can tell who produced it. */
  model: string | undefined
  /** The caller asked for JSON output; see {@link jsonAnswerFromReasoning}. */
  jsonOutput: boolean
  followedChoice: number | undefined
  finish: WireFinishReason | undefined
  usage: UsageCounters | undefined
}

function parseChunk(payload: string, displayName: string): WireStreamChunk {
  let chunk: WireStreamChunk
  try { chunk = JSON.parse(payload) as WireStreamChunk }
  catch (error: unknown) { throw malformed(displayName, 'the event data is not JSON', error) }
  if (recordOrUndefined(chunk) === undefined || Array.isArray(chunk)) {
    throw malformed(displayName, 'the event data is not an object')
  }
  // Typed as an object, but some gateways send a plain string; both are handled.
  const inline: unknown = chunk.error
  if (inline !== undefined && inline !== null) {
    throw chatCompletionsStreamError(inline as Parameters<typeof chatCompletionsStreamError>[0], displayName)
  }
  return chunk
}


function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Reasoning from a dedicated field. Endpoints disagree on the spelling, and a
 * transitional server may send BOTH with the same text, so exactly one is read
 * per delta, `reasoning_content` first.
 */
function* reasoningDelta(state: StreamState, delta: WireStreamChoice['delta']): Generator<ProtocolStreamChunk> {
  const fromContentField = nonEmpty(delta?.reasoning_content)
  const text = fromContentField ?? nonEmpty(delta?.reasoning)
  if (text === undefined) return
  yield* appendReasoning(state, text, fromContentField === undefined ? 'reasoning' : 'reasoning_content')
}

function* appendReasoning(state: StreamState, text: string, field: ChatCompletionsReasoningField)
  : Generator<ProtocolStreamChunk> {
  state.reasoningField ??= field
  if (state.reasoning === undefined) {
    state.reasoning = { index: state.nextIndex++, content: new TextAccumulator() }
    yield { type: 'block-start', index: state.reasoning.index, blockType: 'reasoning' }
  }
  state.reasoning.content.append(text)
  yield { type: 'reasoning-delta', index: state.reasoning.index, text, kind: 'content' }
}

function* textDelta(state: StreamState, delta: WireStreamChoice['delta']): Generator<ProtocolStreamChunk> {
  const content = nonEmpty(delta?.content)
  if (content !== undefined) {
    const segments = state.think === undefined ? [{ kind: 'text' as const, text: content }] : state.think.push(content)
    for (const segment of segments) yield* emitSegment(state, segment)
    return
  }
  // A refusal is the answer itself; it is never read for think tags. Content the
  // splitter still holds came first, so it is released ahead of the refusal and
  // tag detection stops.
  const refusal = nonEmpty(delta?.refusal)
  if (refusal === undefined) return
  for (const segment of state.think?.flush() ?? []) yield* emitSegment(state, segment)
  state.think = undefined
  yield* emitSegment(state, { kind: 'text', text: refusal })
}

function* emitSegment(state: StreamState, segment: { kind: 'reasoning' | 'text'; text: string })
  : Generator<ProtocolStreamChunk> {
  if (segment.kind === 'reasoning') {
    yield* appendReasoning(state, segment.text, 'think-tag')
    return
  }
  const content = segment.text
  if (state.text === undefined) {
    state.text = { index: state.nextIndex++, content: new TextAccumulator() }
    yield { type: 'block-start', index: state.text.index, blockType: 'text' }
  }
  state.text.content.append(content)
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
  for (const segment of state.think?.flush() ?? []) yield* emitSegment(state, segment)
  yield* closeReasoning(state)
  if (state.text !== undefined) {
    yield { type: 'block-end', index: state.text.index, block: { type: 'text', text: state.text.content.text } }
  } else if (recoversJsonAnswer(state, reason)) {
    yield* recoveredJsonAnswer(state)
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

function* closeReasoning(state: StreamState): Generator<ProtocolStreamChunk> {
  if (state.reasoning === undefined) return
  const providerState: ChatCompletionsReasoningState = {
    protocol: 'openai-chat-completions', field: state.reasoningField ?? 'reasoning_content',
    ...state.model === undefined ? {} : { model: state.model },
  }
  yield { type: 'block-end', index: state.reasoning.index,
    block: { type: 'reasoning', text: state.reasoning.content.text, kind: 'content', providerState } }
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

/** Whether a turn that ended with no text may take its answer from the reasoning. */
function recoversJsonAnswer(state: StreamState, reason: WireFinishReason): boolean {
  // `<think>` content is the model's own scratch work, never a misfiled answer.
  return state.jsonOutput && reason === 'stop' && state.toolCalls.size === 0 && state.reasoningField !== 'think-tag'
}

/**
 * Recover a structured answer that a reasoning parser misfiled.
 *
 * vLLM-style servers running a reasoning parser alongside guided decoding can
 * return the whole JSON answer in `reasoning_content` with no `content` at all
 * (seen live on DeepSeek V4 behind FPT AI Marketplace). The caller asked for
 * JSON and is about to parse the text, so when the turn ended normally with no
 * text and the reasoning IS a JSON document, it is also emitted as the answer.
 */
function* recoveredJsonAnswer(state: StreamState): Generator<ProtocolStreamChunk> {
  const json = jsonAnswerFromReasoning(state.reasoning?.content.text)
  if (json === undefined) return
  const index = state.nextIndex++
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text: json }
  yield { type: 'block-end', index, block: { type: 'text', text: json } }
}

/** The reasoning text when it is, in full, a JSON object or array. */
export function jsonAnswerFromReasoning(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  if (trimmed === undefined || !/^[[{]/.test(trimmed)) return undefined
  try { JSON.parse(trimmed) } catch { return undefined }
  return trimmed
}

/** Options the translator reads from the request. */
export interface ChatCompletionsTranslateOptions {
  /** The request asked for JSON output (`outputFormat: json_schema`). */
  readonly jsonOutput?: boolean
  /** Read a leading `<think>…</think>` in `content` as reasoning. Defaults to true. */
  readonly thinkTags?: boolean
  /** Upstream model id, recorded on reasoning blocks for replay decisions. */
  readonly model?: string
}

/** Translate a single choice while draining trailing usage after its terminal finish. */
export async function* translateChatCompletionsStream(
  events: AsyncIterable<ProtocolSseEvent>, displayName: string, options: ChatCompletionsTranslateOptions = {},
): AsyncGenerator<ProtocolStreamChunk> {
  const state: StreamState = { toolCalls: new Map(), nextIndex: 0, text: undefined,
    reasoning: undefined, reasoningField: undefined,
    think: options.thinkTags === false ? undefined : new LeadingThinkSplitter(),
    model: options.model, jsonOutput: options.jsonOutput === true,
    followedChoice: undefined, finish: undefined, usage: undefined }
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
  yield finishChunk(state.finish, state.reasoning !== undefined)
}

function finishChunk(reason: WireFinishReason, reasoned: boolean): ProtocolStreamChunk {
  // Marks reasoning as replayable to this endpoint only; see `replaysFrom`.
  return { type: 'finish', reason: finishReasonOf(reason),
    ...reasoned ? { replayState: { response: CHAT_COMPLETIONS_REPLAY_MARKER } } : {} }
}

function updateUsage(state: StreamState, chunk: WireStreamChunk) {
  if (chunk.usage !== undefined && chunk.usage !== null) state.usage = mapUsage(chunk.usage) ?? state.usage
}
