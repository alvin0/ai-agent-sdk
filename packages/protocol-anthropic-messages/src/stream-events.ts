import {
  CONTEXT_WINDOW_EXCEEDED_CODE, MODEL_ERROR_CODES, ModelError, QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError, isQuotaExceededError,
} from '@alvin0/ai-agent-sdk-core'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolStreamChunk } from './contract.ts'
import type { WireStopReason, WireStreamEvent } from './wire.ts'
import { blockKind, closedBlock, citationAnnotation, type OpenBlock } from './stream-blocks.ts'
import { absorbUsage, finalUsage, finishReason, type UsageAccumulator } from './stream-usage.ts'

export interface StreamState {
  open: Map<number, OpenBlock>
  usage: UsageAccumulator
  stop: WireStopReason | null | undefined
  emittedBlocks: number
}

export function* translateEvent(
  state: StreamState, event: WireStreamEvent, displayName: string,
): Generator<ProtocolStreamChunk> {
  switch (event.type) {
    case 'message_start': yield* messageStart(state, event); return
    case 'content_block_start': yield* contentStart(state, event); return
    case 'content_block_delta': yield* contentDelta(state, event); return
    case 'content_block_stop': yield* contentStop(state, event); return
    case 'message_delta': yield* messageDelta(state, event); return
    case 'message_stop': yield* messageStop(state, displayName); return
    case 'error': yield* streamError(event, displayName); return
    default: return
  }
}

function* messageStart(
  state: StreamState, event: Extract<WireStreamEvent, { type: 'message_start' }>,
): Generator<ProtocolStreamChunk> {
  absorbUsage(state.usage, event.message.usage)
  const progress = finalUsage(state.usage)
  if (progress !== undefined) yield { type: 'usage-progress', usage: progress }
}

function* contentStart(
  state: StreamState, event: Extract<WireStreamEvent, { type: 'content_block_start' }>,
): Generator<ProtocolStreamChunk> {
  if (event.content_block.type === 'web_search_tool_result') {
    yield* webSearchResult(state, event)
    return
  }
  const kind = blockKind(event.content_block.type)
  if (kind === undefined) return
  const block = event.content_block
  const entry: OpenBlock = {
    kind,
    text: initialText(block),
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
  state.open.set(event.index, entry)
  state.emittedBlocks += 1
  yield { type: 'block-start', index: event.index, blockType: kind }
}

function* contentDelta(
  state: StreamState, event: Extract<WireStreamEvent, { type: 'content_block_delta' }>,
): Generator<ProtocolStreamChunk> {
  const entry = state.open.get(event.index)
  if (entry === undefined) return
  const delta = event.delta
  switch (delta.type) {
    case 'text_delta':
      entry.text += delta.text
      yield { type: 'text-delta', index: event.index, text: delta.text }
      return
    case 'thinking_delta':
      entry.text += delta.thinking
      yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
      return
    case 'signature_delta':
      // Arrives once, just before the block closes. It carries no visible
      // content, so it produces no chunk — only the state needed to replay
      // this thinking block on a later request.
      entry.signature = delta.signature
      return
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
      return
    case 'citations_delta': {
      const annotation = citationAnnotation(delta.citation)
      if (annotation !== undefined) entry.annotations.push(annotation)
      return
    }
    default:
      return
  }
}

function* contentStop(
  state: StreamState, event: Extract<WireStreamEvent, { type: 'content_block_stop' }>,
): Generator<ProtocolStreamChunk> {
  const entry = state.open.get(event.index)
  if (entry === undefined) return
  if (entry.kind === 'native-tool-call') return
  const block = closedBlock(entry)
  if (block !== undefined && !entry.closed) {
    entry.closed = true
    yield { type: 'block-end', index: event.index, block }
  }
}

function* messageDelta(
  state: StreamState, event: Extract<WireStreamEvent, { type: 'message_delta' }>,
): Generator<ProtocolStreamChunk> {
  state.stop = event.delta.stop_reason
  absorbUsage(state.usage, event.usage)
  const progress = finalUsage(state.usage)
  if (progress !== undefined) yield { type: 'usage-progress', usage: progress }
}

function* messageStop(
  state: StreamState, displayName: string,
): Generator<ProtocolStreamChunk> {
  for (const [index, entry] of state.open) {
    if (entry.kind !== 'native-tool-call' || entry.closed) continue
    const block = closedBlock(entry)
    if (block !== undefined) yield { type: 'block-end', index, block }
    entry.closed = true
  }
  const mapped = finalUsage(state.usage)
  if (mapped !== undefined) yield { type: 'usage', usage: mapped }
  if (state.emittedBlocks === 0) {
    // A clean stop with no content at all. Reported as a failure rather
    // than an empty message, because an empty message ends the turn with
    // nothing for the caller to act on — and it is safe to retry.
    throw new ModelError(
      `${displayName} returned a response with no content`,
      'EMPTY_RESPONSE',
    )
  }
  yield { type: 'finish', reason: finishReason(state.stop) }
}

function* streamError(
  event: Extract<WireStreamEvent, { type: 'error' }>, displayName: string,
): Generator<ProtocolStreamChunk> {
  const detail = [event.error.type, event.error.message]
    .filter((part): part is string => part !== undefined)
    .join(' ')
  throw new ModelError(
    event.error.message ?? `${displayName} reported a stream error`,
    // `overloaded_error` mid-stream is the common case and must stay
    // retryable, which the shared 5xx mapping gives us.
    event.error.type === 'overloaded_error'
      ? MODEL_ERROR_CODES.SERVER
      : anthropicStreamErrorCode(event.error.type, detail),
  )
}

function initialText(block: Extract<WireStreamEvent, { type: 'content_block_start' }>['content_block']): string {
  if (block.type === 'text') return block.text
  if (block.type === 'thinking') return block.thinking
  return ''
}

function anthropicStreamErrorCode(type: string | undefined, detail: string): string {
  if (type === 'authentication_error' || type === 'permission_error') {
    return MODEL_ERROR_CODES.AUTH
  }
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (type === 'rate_limit_error') return MODEL_ERROR_CODES.RATE_LIMIT
  if (type === 'api_error') return MODEL_ERROR_CODES.SERVER
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  return MODEL_ERROR_CODES.INVALID_REQUEST
}

function* webSearchResult(
  state: StreamState, event: Extract<WireStreamEvent, { type: 'content_block_start' }>,
): Generator<ProtocolStreamChunk> {
  if (event.content_block.type !== 'web_search_tool_result') return
  const result = event.content_block
  const owner = [...state.open.values()].find(entry => entry.kind === 'native-tool-call'
    && entry.callId === result.tool_use_id)
  if (owner !== undefined) {
    owner.nativeResult = result
    const block = closedBlock(owner)
    if (block !== undefined && !owner.closed) {
      owner.closed = true
      yield {
        type: 'block-end',
        index: [...state.open.entries()].find(([, entry]) => entry === owner)?.[0] ?? event.index,
        block,
      }
    }
  }
}
