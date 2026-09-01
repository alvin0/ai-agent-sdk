/**
 * Anthropic Messages API SSE events to the SDK's chunk protocol.
 *
 * Notable differences from the Responses translation:
 *
 * - Block indices come straight from the provider. This API numbers content
 *   blocks contiguously from zero in emission order, which is already exactly
 *   what our protocol wants, so no remapping is needed.
 * - Usage arrives in TWO places: input counts on `message_start`, output counts on
 *   `message_delta`. They are accumulated and emitted once, before the finish.
 * - `input_tokens` here already EXCLUDES cached tokens, so unlike the Responses
 *   translation nothing is subtracted. Getting this backwards would under-report
 *   input on every cached call.
 *
 * @module ai-agent-sdk/providers/anthropic/translate
 */

import { MODEL_ERROR_CODES, ModelError } from '../../core/errors/model-error.ts'
import { ToolCallId } from '../../core/primitives/brand.ts'
import { isJsonValue, type JsonValue } from '../../core/primitives/json.ts'
import type { ContentBlock, TextAnnotation } from '../../core/message/content.ts'
import type { FinishReason, StreamChunk, TokenUsage } from '../../core/stream/chunk.ts'
import type { SseEvent } from '../../core/stream/sse.ts'
import { httpErrorCode } from '../base/http-errors.ts'
import type { AnthropicReasoningState } from './serialize.ts'
import type {
  WireCitation,
  WireServerToolUseBlock,
  WireStopReason,
  WireStreamEvent,
  WireUsage,
  WireWebSearchToolResultBlock,
} from './wire.ts'

/** Which of our block types one wire block maps to. */
type BlockKind = 'text' | 'reasoning' | 'tool-call' | 'native-tool-call'

interface OpenBlock {
  readonly kind: BlockKind
  text: string
  args: string
  callId: string
  name: string
  signature: string | undefined
  redactedData: string | undefined
  annotations: TextAnnotation[]
  nativeCall: WireServerToolUseBlock | undefined
  nativeResult: WireWebSearchToolResultBlock | undefined
  closed: boolean
}

function blockKind(type: string | undefined): BlockKind | undefined {
  switch (type) {
    case 'text': return 'text'
    case 'thinking':
    case 'redacted_thinking': return 'reasoning'
    case 'tool_use': return 'tool-call'
    case 'server_tool_use': return 'native-tool-call'
    default: return undefined
  }
}

/** Accumulated token counts, filled from two different events. */
interface UsageAccumulator {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  seen: boolean
}

function absorbUsage(target: UsageAccumulator, usage: WireUsage | undefined): void {
  if (usage === undefined) return
  if (typeof usage.input_tokens === 'number') target.input = usage.input_tokens
  if (typeof usage.output_tokens === 'number') target.output = usage.output_tokens
  if (typeof usage.cache_read_input_tokens === 'number') {
    target.cacheRead = usage.cache_read_input_tokens
  }
  if (typeof usage.cache_creation_input_tokens === 'number') {
    target.cacheWrite = usage.cache_creation_input_tokens
  }
  target.seen = true
}

function finalUsage(accumulated: UsageAccumulator): TokenUsage | undefined {
  if (!accumulated.seen) return undefined
  return {
    // No subtraction: this API already reports these three disjointly.
    inputTokens: accumulated.input,
    outputTokens: accumulated.output,
    totalTokens: accumulated.input + accumulated.cacheRead
      + accumulated.cacheWrite + accumulated.output,
    ...accumulated.cacheRead > 0 ? { cacheReadTokens: accumulated.cacheRead } : {},
    ...accumulated.cacheWrite > 0 ? { cacheWriteTokens: accumulated.cacheWrite } : {},
  }
}

/** Map this API's stop reason onto ours. */
function finishReason(stop: WireStopReason | null | undefined): FinishReason {
  switch (stop) {
    case 'tool_use': return { kind: 'tool-calls' }
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'refusal':
      return {
        kind: 'error',
        failure: {
          message: 'the model refused to answer',
          code: MODEL_ERROR_CODES.INVALID_REQUEST,
        },
      }
    // `end_turn`, `stop_sequence`, and `pause_turn` all mean the turn produced a
    // complete answer as far as a caller is concerned.
    default: return { kind: 'stop' }
  }
}

/** Build the authoritative block for a completed content block. */
function closedBlock(open: OpenBlock): ContentBlock | undefined {
  switch (open.kind) {
    case 'text':
      return {
        type: 'text', text: open.text,
        ...open.annotations.length === 0 ? {} : { annotations: open.annotations },
      }
    case 'reasoning': {
      const state: AnthropicReasoningState = open.redactedData !== undefined
        ? { kind: 'redacted_thinking', data: open.redactedData }
        : {
          kind: 'thinking',
          ...open.signature === undefined ? {} : { signature: open.signature },
        }
      return { type: 'reasoning', text: open.text, providerState: state }
    }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: ToolCallId(open.callId),
        name: open.name,
        arguments: open.args.length > 0 ? open.args : '{}',
      }
    case 'native-tool-call': {
      const parsed = parsedArguments(open.args, open.nativeCall?.input)
      const call: WireServerToolUseBlock = open.nativeCall ?? {
        type: 'server_tool_use', id: open.callId, name: 'web_search', input: parsed,
      }
      return {
        type: 'native-tool-call', id: open.callId,
        name: open.name === 'web_search' ? 'web-search' : open.name.replaceAll('_', '-'),
        arguments: parsed,
        content: [],
        providerState: {
          call: { ...call, input: parsed },
          ...open.nativeResult === undefined ? {} : { result: open.nativeResult },
        },
      }
    }
    default:
      return undefined
  }
}

function parsedArguments(raw: string, fallback?: unknown): JsonValue {
  if (raw.length === 0) return isJsonValue(fallback) ? fallback : {}
  try {
    const value: unknown = JSON.parse(raw)
    return isJsonValue(value) ? value : {}
  } catch {
    return {}
  }
}

function citationAnnotation(citation: WireCitation): TextAnnotation | undefined {
  if (citation.type !== 'web_search_result_location' || typeof citation.url !== 'string') {
    return undefined
  }
  return {
    type: 'url-citation', url: citation.url,
    ...typeof citation.title === 'string' ? { title: citation.title } : {},
    providerState: structuredClone(citation),
  }
}

/**
 * Translate one Messages SSE stream.
 *
 * Owns termination. There is no `[DONE]` sentinel: the stream ends on
 * `message_stop`, and a body that ends before that was truncated — a failure
 * rather than a short answer.
 * @param events - decoded SSE events.
 * @param displayName - provider name, used in diagnostics.
 * @returns the chunk stream.
 */
export async function* translateAnthropicStream(
  events: AsyncIterable<SseEvent>,
  displayName: string,
): AsyncGenerator<StreamChunk> {
  const open = new Map<number, OpenBlock>()
  const usage: UsageAccumulator = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, seen: false,
  }
  let stop: WireStopReason | null | undefined
  let terminated = false
  let emittedBlocks = 0

  for await (const raw of events) {
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

    switch (event.type) {
      case 'message_start': {
        absorbUsage(usage, event.message.usage)
        break
      }

      case 'content_block_start': {
        if (event.content_block.type === 'web_search_tool_result') {
          const result = event.content_block
          const owner = [...open.values()].find(entry => entry.kind === 'native-tool-call'
            && entry.callId === result.tool_use_id)
          if (owner !== undefined) {
            owner.nativeResult = result
            const block = closedBlock(owner)
            if (block !== undefined && !owner.closed) {
              owner.closed = true
              yield {
                type: 'block-end',
                index: [...open.entries()].find(([, entry]) => entry === owner)?.[0] ?? event.index,
                block,
              }
            }
          }
          break
        }
        const kind = blockKind(event.content_block.type)
        if (kind === undefined) break
        const block = event.content_block
        const entry: OpenBlock = {
          kind,
          text: block.type === 'text'
            ? block.text
            : block.type === 'thinking' ? block.thinking : '',
          args: '',
          callId: block.type === 'tool_use' ? block.id : `block-${event.index}`,
          name: block.type === 'tool_use' || block.type === 'server_tool_use' ? block.name : '',
          signature: block.type === 'thinking' ? block.signature : undefined,
          redactedData: block.type === 'redacted_thinking' ? block.data : undefined,
          annotations: [],
          nativeCall: block.type === 'server_tool_use' ? block : undefined,
          nativeResult: undefined,
          closed: false,
        }
        if (block.type === 'server_tool_use') {
          entry.callId = block.id
          entry.args = ''
        }
        open.set(event.index, entry)
        emittedBlocks += 1
        yield { type: 'block-start', index: event.index, blockType: kind }
        break
      }

      case 'content_block_delta': {
        const entry = open.get(event.index)
        if (entry === undefined) break
        const delta = event.delta
        switch (delta.type) {
          case 'text_delta':
            entry.text += delta.text
            yield { type: 'text-delta', index: event.index, text: delta.text }
            break
          case 'thinking_delta':
            entry.text += delta.thinking
            yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
            break
          case 'signature_delta':
            // Arrives once, just before the block closes. It carries no visible
            // content, so it produces no chunk — only the state needed to replay
            // this thinking block on a later request.
            entry.signature = delta.signature
            break
          case 'input_json_delta':
            entry.args += delta.partial_json
            if (entry.kind === 'tool-call') {
              yield {
                type: 'tool-call-delta',
                index: event.index,
                id: ToolCallId(entry.callId),
                ...entry.name.length > 0 ? { name: entry.name } : {},
                argumentsDelta: delta.partial_json,
              }
            }
            break
          case 'citations_delta': {
            const annotation = citationAnnotation(delta.citation)
            if (annotation !== undefined) entry.annotations.push(annotation)
            break
          }
          default:
            break
        }
        break
      }

      case 'content_block_stop': {
        const entry = open.get(event.index)
        if (entry === undefined) break
        if (entry.kind === 'native-tool-call') break
        const block = closedBlock(entry)
        if (block !== undefined && !entry.closed) {
          entry.closed = true
          yield { type: 'block-end', index: event.index, block }
        }
        break
      }

      case 'message_delta': {
        stop = event.delta.stop_reason
        absorbUsage(usage, event.usage)
        break
      }

      case 'message_stop': {
        for (const [index, entry] of open) {
          if (entry.kind !== 'native-tool-call' || entry.closed) continue
          const block = closedBlock(entry)
          if (block !== undefined) yield { type: 'block-end', index, block }
          entry.closed = true
        }
        const mapped = finalUsage(usage)
        if (mapped !== undefined) yield { type: 'usage', usage: mapped }
        if (emittedBlocks === 0) {
          // A clean stop with no content at all. Reported as a failure rather
          // than an empty message, because an empty message ends the turn with
          // nothing for the caller to act on — and it is safe to retry.
          throw new ModelError(
            `${displayName} returned a response with no content`,
            'EMPTY_RESPONSE',
          )
        }
        yield { type: 'finish', reason: finishReason(stop) }
        terminated = true
        return
      }

      case 'error': {
        const detail = [event.error.type, event.error.message]
          .filter((part): part is string => part !== undefined)
          .join(' ')
        throw new ModelError(
          event.error.message ?? `${displayName} reported a stream error`,
          // `overloaded_error` mid-stream is the common case and must stay
          // retryable, which the shared 5xx mapping gives us.
          event.error.type === 'overloaded_error'
            ? MODEL_ERROR_CODES.SERVER
            : httpErrorCode(400, detail),
        )
      }

      // `ping` and any future event carry nothing this protocol needs.
      default:
        break
    }
  }

  if (!terminated) {
    throw new ModelError(
      `${displayName} stream ended before message_stop`,
      MODEL_ERROR_CODES.STREAM_CLOSED,
    )
  }
}
