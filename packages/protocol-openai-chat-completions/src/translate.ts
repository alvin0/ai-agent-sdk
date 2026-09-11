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

import { MODEL_ERROR_CODES, ModelError, ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { ContentBlock, FinishReason, UsageCounters } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolSseEvent, ProtocolStreamChunk } from './contract.ts'
import type {
  WireErrorBody,
  WireFinishReason,
  WireStreamChoice,
  WireStreamChunk,
  WireToolCallDelta,
  WireUsage,
} from './wire.ts'

/** The `data:` payload that ends the body; not a finish, and not a chunk. */
const DONE_SENTINEL = '[DONE]'

/** Substituted when a zero-parameter tool sends no `arguments` at all. */
const EMPTY_ARGUMENTS = '{}'

/** One in-flight tool call, correlated by the wire's `index`. */
interface OpenToolCall {
  /** Our own block index, assigned in first-seen order at emit time. */
  readonly order: number
  id: string | undefined
  name: string | undefined
  /** Fragments joined verbatim. Never parsed until the terminal finish. */
  args: string
}

/** One in-flight text or reasoning block. */
interface OpenTextBlock {
  readonly index: number
  text: string
}

function malformed(displayName: string, detail: string, cause?: unknown): ModelError {
  return new ModelError(
    `${displayName} sent a malformed stream event: ${detail}`,
    MODEL_ERROR_CODES.MALFORMED_RESPONSE,
    cause === undefined ? {} : { cause },
  )
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Normalize usage, honouring the SDK's disjoint-count convention.
 *
 * This API reports `prompt_tokens` as the TOTAL input and
 * `prompt_tokens_details.cached_tokens` as a SUBSET of it, while the SDK's three
 * input figures are disjoint and sum to what is billed. So the cached portion is
 * subtracted back out here; skip that and every cost estimate double-counts
 * cache hits.
 *
 * Otherwise the counters travel RAW: malformed values are passed through rather
 * than dropped, and nothing here decides whether the report is complete. That
 * judgement belongs to the accounting boundary above, which is the only layer
 * that knows what the caller asked for.
 */
function mapUsage(usage: WireUsage): UsageCounters | undefined {
  const source = usage as unknown as Record<string, unknown>
  const promptDetails = recordOrUndefined(source.prompt_tokens_details)
  const completionDetails = recordOrUndefined(source.completion_tokens_details)
  const promptTokens = source.prompt_tokens
  const outputTokens = source.completion_tokens
  const totalTokens = source.total_tokens
  const cacheRead = promptDetails?.cached_tokens
  const reasoning = completionDetails?.reasoning_tokens

  const present = [promptTokens, outputTokens, totalTokens, cacheRead, reasoning]
    .some(value => value !== undefined)
  if (!present) return undefined

  const counters: Record<string, unknown> = {
    ...outputTokens === undefined ? {} : { outputTokens },
    ...totalTokens === undefined ? {} : { totalTokens },
    // An omitted or zero cache figure is authoritative zero for this API; a
    // present-but-invalid one is retained for the accounting validator.
    ...cacheRead === undefined || cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined || reasoning === 0 ? {} : { reasoningTokens: reasoning },
  }
  if (promptTokens !== undefined) {
    counters.inputTokens = typeof promptTokens === 'number'
      && (cacheRead === undefined || typeof cacheRead === 'number')
      ? promptTokens - (cacheRead ?? 0)
      : promptTokens
  }
  return counters as UsageCounters
}

/**
 * Map this API's finish reason onto ours.
 *
 * `content_filter` becomes a terminal `error` finish rather than a thrown
 * exception, so whatever text arrived before the filter tripped still reaches
 * the caller. `function_call` is the pre-`tools` spelling of `tool_calls` and
 * means the same thing.
 */
function finishReasonOf(reason: WireFinishReason): FinishReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return {
        kind: 'error',
        failure: {
          message: 'the endpoint filtered this response',
          code: MODEL_ERROR_CODES.INVALID_REQUEST,
        },
      }
    default:
      return { kind: 'stop' }
  }
}

/** Whether this finish reason is the one that releases accumulated tool calls. */
function releasesToolCalls(reason: WireFinishReason): boolean {
  return reason === 'tool_calls' || reason === 'function_call'
}

/** Turn an inline stream error into a typed failure. */
function inlineError(error: WireErrorBody, displayName: string): ModelError {
  const message = error.message ?? `${displayName} reported an error mid-stream`
  const code = error.code ?? error.type
  // An unrecognized inline error defaults to SERVER, which IS retryable: the
  // turn produced nothing usable, so repeating it is safe and often works.
  return new ModelError(
    code === undefined ? message : `${message} (${String(code)})`,
    MODEL_ERROR_CODES.SERVER,
  )
}

/** Fold one tool-call fragment into the accumulator. */
function absorbToolCall(
  open: Map<number, OpenToolCall>,
  fragment: WireToolCallDelta,
  nextOrder: () => number,
): void {
  const key = typeof fragment.index === 'number' ? fragment.index : 0
  let entry = open.get(key)
  if (entry === undefined) {
    entry = { order: nextOrder(), id: undefined, name: undefined, args: '' }
    open.set(key, entry)
  }
  // `id` and `name` arrive once. A later fragment repeating them is harmless;
  // a later fragment CLEARING them would not be, so only truthy values land.
  if (typeof fragment.id === 'string' && fragment.id.length > 0) entry.id = fragment.id
  const name = fragment.function?.name
  if (typeof name === 'string' && name.length > 0) entry.name = name
  const args = fragment.function?.arguments
  // Concatenation only. The joined string is the model's own bytes, replayed
  // verbatim on the next turn, so no reformatting happens anywhere on this path.
  if (typeof args === 'string') entry.args += args
}

/**
 * Build the authoritative tool-call blocks, parsing `arguments` right here.
 *
 * This is the single moment the accumulated string is allowed to be parsed, and
 * a failure is a protocol error. The alternative — emitting the call with empty
 * arguments — would hand the agent loop a call the model never made.
 */
function toolCallBlocks(
  open: Map<number, OpenToolCall>,
  displayName: string,
): {
  index: number
  id: string
  name: string
  arguments: string
  block: ContentBlock
}[] {
  return [...open.entries()]
    .sort(([left], [right]) => left - right)
    .map(([wireIndex, entry]) => {
      if (entry.id === undefined || entry.name === undefined) {
        throw malformed(
          displayName,
          `tool call at index ${wireIndex} never carried an id and a name`,
        )
      }
      const args = entry.args.length > 0 ? entry.args : EMPTY_ARGUMENTS
      try {
        JSON.parse(args)
      } catch (error: unknown) {
        throw malformed(
          displayName,
          `tool call "${entry.name}" produced arguments that are not valid JSON`,
          error,
        )
      }
      return {
        index: entry.order,
        id: entry.id,
        name: entry.name,
        arguments: args,
        block: {
          type: 'tool-call',
          id: ToolCallId(entry.id),
          name: entry.name,
          arguments: args,
        } satisfies ContentBlock,
      }
    })
}

/**
 * Translate one Chat Completions SSE stream.
 *
 * Owns termination, and refuses to invent one: the stream is complete only when
 * a `finish_reason` other than `null` has been seen. Events after that point are
 * still read, because the `usage` chunk arrives there — with `choices: []`,
 * which is normal traffic rather than a malformed event.
 * @param events - decoded SSE events.
 * @param displayName - provider name, used in diagnostics.
 * @returns the chunk stream.
 */
export async function* translateChatCompletionsStream(
  events: AsyncIterable<ProtocolSseEvent>,
  displayName: string,
): AsyncGenerator<ProtocolStreamChunk> {
  const toolCalls = new Map<number, OpenToolCall>()
  let nextIndex = 0
  const nextOrder = (): number => nextIndex++
  let text: OpenTextBlock | undefined
  let reasoning: OpenTextBlock | undefined
  let followedChoice: number | undefined
  let finish: WireFinishReason | undefined
  let usage: UsageCounters | undefined

  for await (const raw of events) {
    const payload = raw.data.trim()
    if (payload.length === 0) continue
    // Read past the sentinel rather than terminating on it. It says the BODY
    // ended, which is a different claim from "the response completed".
    if (payload === DONE_SENTINEL) continue

    let chunk: WireStreamChunk
    try {
      chunk = JSON.parse(payload) as WireStreamChunk
    } catch (error: unknown) {
      throw malformed(displayName, 'the event data is not JSON', error)
    }
    if (recordOrUndefined(chunk) === undefined) {
      throw malformed(displayName, 'the event data is not an object')
    }

    if (chunk.error !== undefined && chunk.error !== null) {
      throw inlineError(chunk.error, displayName)
    }

    // Last non-null report wins; the usage-bearing chunk normally arrives after
    // the terminal finish, and earlier chunks carry an explicit `null`.
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = mapUsage(chunk.usage) ?? usage
    }

    const choices: readonly WireStreamChoice[] = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      if (recordOrUndefined(choice) === undefined) continue
      const index = typeof choice.index === 'number' ? choice.index : 0
      // One choice is followed for the whole stream — the first one seen. The
      // SDK never asks for more than one, and interleaving two into a single
      // block stream would silently splice two different answers together.
      followedChoice ??= index
      if (index !== followedChoice) continue
      // Everything after the terminal finish is read for `usage` only; a late
      // delta cannot be appended to a block that has already been closed.
      if (finish !== undefined) continue

      const delta = recordOrUndefined(choice.delta) === undefined ? undefined : choice.delta

      const reasoningText = delta?.reasoning_content
      if (typeof reasoningText === 'string' && reasoningText.length > 0) {
        if (reasoning === undefined) {
          reasoning = { index: nextOrder(), text: '' }
          yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
        }
        reasoning.text += reasoningText
        yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningText }
      }

      // `refusal` is model-authored prose explaining why it declined, so it
      // belongs in the text block; the finish reason is what marks it a refusal.
      const content = typeof delta?.content === 'string' && delta.content.length > 0
        ? delta.content
        : typeof delta?.refusal === 'string' && delta.refusal.length > 0
          ? delta.refusal
          : undefined
      if (content !== undefined) {
        if (text === undefined) {
          text = { index: nextOrder(), text: '' }
          yield { type: 'block-start', index: text.index, blockType: 'text' }
        }
        text.text += content
        yield { type: 'text-delta', index: text.index, text: content }
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const fragment of delta.tool_calls) {
          if (recordOrUndefined(fragment) === undefined) continue
          absorbToolCall(toolCalls, fragment, nextOrder)
        }
      }

      const reason = choice.finish_reason
      if (reason === undefined || reason === null) continue

      // Terminal finish. Close what is open, in first-seen order, then keep
      // draining the stream so the trailing `usage` chunk is still read.
      finish = reason
      if (reasoning !== undefined) {
        yield {
          type: 'block-end',
          index: reasoning.index,
          block: { type: 'reasoning', text: reasoning.text },
        }
      }
      if (text !== undefined) {
        yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.text } }
      }
      if (releasesToolCalls(reason)) {
        for (const call of toolCallBlocks(toolCalls, displayName)) {
          yield { type: 'block-start', index: call.index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index: call.index,
            id: ToolCallId(call.id),
            name: call.name,
            argumentsDelta: call.arguments,
          }
          yield { type: 'block-end', index: call.index, block: call.block }
        }
      }
      // Any other finish reason with fragments still in the accumulator means
      // the call never completed — `length` truncated it, `stop` contradicts it
      // — and an incomplete tool call must not escape this function.
      toolCalls.clear()
    }
  }

  if (finish === undefined) {
    throw new ModelError(
      `${displayName} stream ended without a finish reason`,
      MODEL_ERROR_CODES.STREAM_CLOSED,
    )
  }

  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: finishReasonOf(finish) }
}
