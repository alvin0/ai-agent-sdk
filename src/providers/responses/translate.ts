/**
 * Responses API SSE events to the SDK's chunk protocol.
 *
 * Two design notes worth reading before changing anything here.
 *
 * First, block correlation is keyed on `item_id`, not on the provider's
 * `output_index`. Item ids are stable and present on every delta event, whereas
 * index fields vary by event type, so keying on the id and assigning our OWN
 * indices in first-seen order is both simpler and closer to what our protocol
 * promises.
 *
 * Second, reasoning state is carried on the reasoning BLOCK
 * (`ReasoningBlock.providerState`) rather than in the stream's `replayState`
 * envelope. The envelope has to stay positionally aligned with emitted blocks and
 * is discarded whole when it drifts; attaching the state to the block it belongs
 * to cannot drift, and it survives assembly for free.
 *
 * @module ai-agent-sdk/providers/responses/translate
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
} from '../../core/errors/agent-sdk-error.ts'
import { MODEL_ERROR_CODES, ModelError } from '../../core/errors/model-error.ts'
import { ToolCallId } from '../../core/primitives/brand.ts'
import { isJsonValue } from '../../core/primitives/json.ts'
import type {
  AssistantTextPhase,
  ContentBlock,
  ImageMediaType,
  TextAnnotation,
} from '../../core/message/content.ts'
import type { FinishReason, StreamChunk, TokenUsage } from '../../core/stream/chunk.ts'
import type { SseEvent } from '../../core/stream/sse.ts'
import type { ProviderRequest } from '../base/http-adapter.ts'
import type { ResponsesReasoningState } from './serialize.ts'
import type {
  WireErrorBody,
  WireOutputItem,
  WireResponse,
  WireStreamEvent,
  WireUsage,
} from './wire.ts'

/** Which of our block types one output item maps to. */
type ItemKind = 'text' | 'reasoning' | 'tool-call' | 'native-tool-call'

interface OpenItem {
  readonly index: number
  readonly kind: ItemKind
  text: string
  args: string
  callId: string
  name: string
  nativeName: string
  /** Last `summary_index` seen, so a new paragraph gets a separator. */
  summaryIndex: number | undefined
  phase: AssistantTextPhase | undefined
}

function textPhase(value: string | undefined): AssistantTextPhase | undefined {
  if (value === 'commentary') return 'commentary'
  if (value === 'final_answer') return 'final-answer'
  return undefined
}

/** Map an output item's wire type onto one of our block types. */
function itemKind(type: string | undefined): ItemKind | undefined {
  switch (type) {
    case 'message': return 'text'
    case 'reasoning': return 'reasoning'
    case 'function_call': return 'tool-call'
    case 'web_search_call': return 'native-tool-call'
    case 'image_generation_call': return 'native-tool-call'
    default: return undefined
  }
}

function nativeName(type: string | undefined): string {
  if (type === 'web_search_call') return 'web-search'
  if (type === 'image_generation_call') return 'image-generation'
  return type?.replace(/_call$/, '').replaceAll('_', '-') ?? 'native-tool'
}

function textAnnotations(item: WireOutputItem): TextAnnotation[] {
  if (!Array.isArray(item.content)) return []
  return item.content.flatMap((part) => {
    if (typeof part !== 'object' || part === null) return []
    const annotations = (part as Record<string, unknown>).annotations
    if (!Array.isArray(annotations)) return []
    return annotations.flatMap((annotation): TextAnnotation[] => {
      if (typeof annotation !== 'object' || annotation === null) return []
      const record = annotation as Record<string, unknown>
      if (record.type !== 'url_citation' || typeof record.url !== 'string') return []
      return [{
        type: 'url-citation',
        url: record.url,
        ...typeof record.title === 'string' ? { title: record.title } : {},
        ...typeof record.start_index === 'number' ? { startIndex: record.start_index } : {},
        ...typeof record.end_index === 'number' ? { endIndex: record.end_index } : {},
      }]
    })
  })
}

/** Collect the text of a done item's `content` array. */
function itemText(item: WireOutputItem): string {
  const content = item.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const record = part as Record<string, unknown>
      return typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

/** Collect the summary paragraphs of a done reasoning item. */
function itemSummary(item: WireOutputItem): string[] {
  const summary = item.summary
  if (!Array.isArray(summary)) return []
  return summary
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const record = part as Record<string, unknown>
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(text => text.length > 0)
}

/**
 * Normalize usage, honouring the SDK's disjoint-count convention.
 *
 * This API reports `input_tokens` as the TOTAL input and
 * `input_tokens_details.cached_tokens` as a subset of it. Our convention is that
 * the three input figures are disjoint and sum to what is billed, so the cached
 * portion is subtracted back out here. Skip that and every cost estimate
 * double-counts cache hits.
 */
function mapUsage(usage: WireUsage): TokenUsage | undefined {
  const rawInput = usage.input_tokens
  const output = usage.output_tokens
  if (typeof rawInput !== 'number' && typeof output !== 'number') return undefined

  const details = usage.input_tokens_details ?? undefined
  const cacheRead = typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0
  const cacheWrite = typeof details?.cache_write_tokens === 'number'
    ? details.cache_write_tokens
    : undefined
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  const inputTokens = Math.max((rawInput ?? 0) - cacheRead, 0)
  const outputTokens = output ?? 0

  const total = usage.total_tokens
  // Only keep a total that agrees with the parts; a contradictory one is worse
  // than none, because a caller cannot tell it is wrong.
  const derived = inputTokens + cacheRead + (cacheWrite ?? 0) + outputTokens
  const totalTokens = typeof total === 'number' && Number.isSafeInteger(total) && total >= derived
    ? total
    : undefined

  return {
    inputTokens,
    outputTokens,
    ...totalTokens === undefined ? {} : { totalTokens },
    ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
    ...cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {},
    ...typeof reasoning === 'number' && reasoning > 0 ? { reasoningTokens: reasoning } : {},
  }
}

/** Codes that mean "do not retry this"; everything else stays retryable. */
const TERMINAL_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  context_length_exceeded: CONTEXT_WINDOW_EXCEEDED_CODE,
  insufficient_quota: QUOTA_EXCEEDED_CODE,
  invalid_prompt: MODEL_ERROR_CODES.INVALID_REQUEST,
  bio_policy: MODEL_ERROR_CODES.INVALID_REQUEST,
  cyber_policy: MODEL_ERROR_CODES.INVALID_REQUEST,
  misalignment_policy_violation: MODEL_ERROR_CODES.INVALID_REQUEST,
  rate_limit_exceeded: MODEL_ERROR_CODES.RATE_LIMIT,
})

/** Turn a `response.failed` payload into a typed, correctly classified error. */
function failedError(response: WireResponse | undefined, displayName: string): ModelError {
  const error = response?.error ?? undefined
  const code = error?.code ?? error?.type
  const message = error?.message ?? `${displayName} reported a failed response`
  const mapped = code === undefined ? undefined : TERMINAL_ERROR_CODES[code]
  return new ModelError(
    message,
    // An unrecognized failure defaults to SERVER, which IS in the retryable set:
    // the request produced nothing, so repeating it is safe and often works.
    mapped ?? MODEL_ERROR_CODES.SERVER,
    {},
  )
}

/** Build the authoritative block for a completed item. */
function doneBlock(
  item: WireOutputItem,
  open: OpenItem,
  imageMediaType: ImageMediaType,
): ContentBlock | undefined {
  switch (open.kind) {
    case 'text': {
      const text = itemText(item)
      const phase = textPhase(item.phase) ?? open.phase
      return {
        type: 'text',
        text: text.length > 0 ? text : open.text,
        ...phase === undefined ? {} : { phase },
        ...textAnnotations(item).length === 0 ? {} : { annotations: textAnnotations(item) },
      }
    }
    case 'reasoning': {
      const summary = itemSummary(item)
      const state: ResponsesReasoningState = {
        ...typeof item.id === 'string' ? { id: item.id } : {},
        ...typeof item.encrypted_content === 'string'
          ? { encryptedContent: item.encrypted_content }
          : {},
        ...summary.length > 0 ? { summary } : {},
      }
      return {
        type: 'reasoning',
        text: summary.length > 0 ? summary.join('\n\n') : open.text,
        providerState: state,
      }
    }
    case 'tool-call': {
      const args = typeof item.arguments === 'string' && item.arguments.length > 0
        ? item.arguments
        : open.args
      return {
        type: 'tool-call',
        id: ToolCallId(item.call_id ?? open.callId),
        name: item.name ?? open.name,
        arguments: args.length > 0 ? args : '{}',
      }
    }
    case 'native-tool-call': {
      const content: ContentBlock[] = open.nativeName === 'image-generation'
        && typeof item.result === 'string' && item.result.length > 0
        ? [{
          type: 'image',
          source: { kind: 'base64', mediaType: imageMediaType, data: item.result },
        }]
        : []
      return {
        type: 'native-tool-call',
        id: item.id ?? open.callId,
        name: open.nativeName,
        ...typeof item.status === 'string' ? { status: item.status } : {},
        ...isJsonValue(item.action) ? { arguments: item.action } : {},
        content,
        providerState: item,
      }
    }
    default:
      return undefined
  }
}

/**
 * Translate one Responses SSE stream.
 *
 * Owns termination. This API sends no `[DONE]` sentinel: the stream ends on
 * `response.completed`, `response.failed`, or `response.incomplete`, and a body
 * that ends without one of those was truncated — which is a failure, not an
 * empty success, because a truncated turn cannot be trusted.
 * @param events - decoded SSE events.
 * @param displayName - provider name, used in diagnostics.
 * @returns the chunk stream.
 */
export async function* translateResponsesStream(
  events: AsyncIterable<SseEvent>,
  displayName: string,
  request?: ProviderRequest,
): AsyncGenerator<StreamChunk> {
  const open = new Map<string, OpenItem>()
  let nextIndex = 0
  let sawToolCall = false
  let terminated = false
  const imageMediaType = requestedImageMediaType(request)

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
      case 'response.output_item.added': {
        const item = event.item
        const id = item?.id ?? event.item_id
        const kind = itemKind(item?.type)
        if (item === undefined || id === undefined || kind === undefined) break
        if (open.has(id)) break
        const entry: OpenItem = {
          index: nextIndex++,
          kind,
          text: '',
          args: '',
          callId: item.call_id ?? id,
          name: item.name ?? '',
          nativeName: nativeName(item.type),
          summaryIndex: undefined,
          phase: textPhase(item.phase),
        }
        open.set(id, entry)
        if (kind === 'tool-call') sawToolCall = true
        yield { type: 'block-start', index: entry.index, blockType: kindToBlockType(kind) }
        break
      }

      case 'response.output_text.delta': {
        const entry = event.item_id === undefined ? undefined : open.get(event.item_id)
        if (entry === undefined || event.delta === undefined) break
        entry.text += event.delta
        yield {
          type: 'text-delta', index: entry.index, text: event.delta,
          ...entry.phase === undefined ? {} : { phase: entry.phase },
        }
        break
      }

      case 'response.reasoning_summary_text.delta': {
        const entry = event.item_id === undefined ? undefined : open.get(event.item_id)
        if (entry === undefined || event.delta === undefined) break
        // A new summary paragraph starts; separate it from the previous one so the
        // assembled text does not run two thoughts together.
        const separator = entry.summaryIndex !== undefined
          && event.summary_index !== undefined
          && event.summary_index !== entry.summaryIndex
          ? '\n\n'
          : ''
        entry.summaryIndex = event.summary_index
        const text = `${separator}${event.delta}`
        entry.text += text
        yield { type: 'reasoning-delta', index: entry.index, text }
        break
      }

      case 'response.reasoning_text.delta': {
        const entry = event.item_id === undefined ? undefined : open.get(event.item_id)
        if (entry === undefined || event.delta === undefined) break
        entry.text += event.delta
        yield { type: 'reasoning-delta', index: entry.index, text: event.delta }
        break
      }

      case 'response.function_call_arguments.delta': {
        const entry = event.item_id === undefined ? undefined : open.get(event.item_id)
        if (entry === undefined || event.delta === undefined) break
        entry.args += event.delta
        yield {
          type: 'tool-call-delta',
          index: entry.index,
          id: ToolCallId(entry.callId),
          ...entry.name.length > 0 ? { name: entry.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }

      case 'response.image_generation_call.partial_image': {
        const itemId = event.item_id
        const entry = itemId === undefined ? undefined : open.get(itemId)
        if (itemId === undefined || entry === undefined || event.partial_image_b64 === undefined) break
        yield {
          type: 'image-delta',
          index: entry.index,
          itemId,
          data: event.partial_image_b64,
          mediaType: imageMediaType,
          ...event.partial_image_index === undefined
            ? {}
            : { partialIndex: event.partial_image_index },
        }
        break
      }

      case 'response.output_item.done': {
        const item = event.item
        const id = item?.id ?? event.item_id
        const entry = id === undefined ? undefined : open.get(id)
        if (item === undefined || entry === undefined) break
        const block = doneBlock(item, entry, imageMediaType)
        if (block !== undefined) yield { type: 'block-end', index: entry.index, block }
        break
      }

      case 'response.completed': {
        const usage = event.response?.usage ?? undefined
        const mapped = usage === undefined ? undefined : mapUsage(usage)
        if (mapped !== undefined) yield { type: 'usage', usage: mapped }
        // This API has no explicit stop reason. Tool calls in the output ARE the
        // signal that the turn expects results back, which is what an agent loop
        // branches on.
        const reason: FinishReason = sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
        yield { type: 'finish', reason }
        terminated = true
        return
      }

      case 'response.incomplete': {
        const usage = event.response?.usage ?? undefined
        const mapped = usage === undefined ? undefined : mapUsage(usage)
        if (mapped !== undefined) yield { type: 'usage', usage: mapped }
        const why = event.response?.incomplete_details?.reason
        if (why === 'max_output_tokens') {
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
          terminated = true
          return
        }
        throw new ModelError(
          `${displayName} returned an incomplete response (${why ?? 'unknown reason'})`,
          MODEL_ERROR_CODES.SERVER,
        )
      }

      case 'response.failed':
        throw failedError(event.response, displayName)

      case 'error': {
        // A top-level error event carries its fields inline rather than under a
        // `response` object, so it is reshaped to reuse the same classifier.
        const inline: WireErrorBody = {
          ...event.code === undefined ? {} : { code: event.code },
          ...event.message === undefined ? {} : { message: event.message },
        }
        throw failedError({ error: inline }, displayName)
      }

      default:
        // Every other lifecycle and progress event (`response.created`,
        // `content_part.*`, `*.done` text echoes, `ping`) carries nothing this
        // protocol needs. Falling through is correct and keeps new event types
        // from breaking the stream.
        break
    }
  }

  if (!terminated) {
    throw new ModelError(
      `${displayName} stream ended before the response completed`,
      MODEL_ERROR_CODES.STREAM_CLOSED,
    )
  }
}

/** Our block-type tag for one item kind. */
function kindToBlockType(kind: ItemKind): 'text' | 'reasoning' | 'tool-call' | 'native-tool-call' {
  return kind
}

function requestedImageMediaType(request: ProviderRequest | undefined): ImageMediaType {
  const tool = request?.options.tools?.find(candidate => 'type' in candidate
    && candidate.type === 'native'
    && candidate.name === 'image-generation')
  if (tool === undefined || !('format' in tool)) return 'image/png'
  if (tool.format === 'jpeg') return 'image/jpeg'
  if (tool.format === 'webp') return 'image/webp'
  return 'image/png'
}
