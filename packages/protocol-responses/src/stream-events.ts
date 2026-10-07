import type { WireOutputItem } from './wire.ts'
import type { ItemKind } from './stream-items.ts'
import { MODEL_ERROR_CODES, ModelError } from '@alvin0/ai-agent-sdk-core'
import { ToolCallId } from '@alvin0/ai-agent-sdk-core'
import type { ImageMediaType } from '@alvin0/ai-agent-sdk-core'
import type { FinishReason } from '@alvin0/ai-agent-sdk-core'
import type { ProtocolStreamChunk } from './contract.ts'
import type { WireErrorBody, WireStreamEvent } from './wire.ts'
import { textPhase, itemKind, nativeName, kindToBlockType, doneBlock, type OpenItem } from './stream-items.ts'
import { mapUsage } from './stream-usage.ts'
import { failedError } from './stream-errors.ts'

export interface StreamState {
  open: Map<string, OpenItem>
  nextIndex: number
  sawToolCall: boolean
  imageMediaType: ImageMediaType
}

export function* translateEvent(
  state: StreamState, event: WireStreamEvent, displayName: string,
): Generator<ProtocolStreamChunk> {
  switch (event.type) {
    case 'response.output_item.added': yield* itemAdded(state, event); return
    case 'response.output_item.done': yield* itemDone(state, event); return
    case 'response.completed': yield* completed(state, event); return
    case 'response.incomplete': yield* incomplete(event, displayName); return
    case 'response.failed': yield* failed(event, displayName); return
    case 'error': yield* inlineError(event, displayName); return
    default: yield* deltaEvent(state, event); return
  }
}

function* itemAdded(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const item = event.item
  const id = item?.id ?? event.item_id
  const kind = itemKind(item?.type)
  if (item === undefined || id === undefined || kind === undefined) return
  if (state.open.has(id)) return
  const entry = createOpenItem(state, item, { id, kind })
  state.open.set(id, entry)
  if (kind === 'tool-call') state.sawToolCall = true
  yield { type: 'block-start', index: entry.index, blockType: kindToBlockType(kind) }
}

function* textDelta(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const entry = event.item_id === undefined ? undefined : state.open.get(event.item_id)
  if (entry === undefined || event.delta === undefined) return
  entry.text += event.delta
  yield {
    type: 'text-delta', index: entry.index, text: event.delta,
    ...entry.phase === undefined ? {} : { phase: entry.phase },
  }
}

function* summaryDelta(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const entry = event.item_id === undefined ? undefined : state.open.get(event.item_id)
  if (entry === undefined || event.delta === undefined) return
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
}

function* reasoningDelta(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const entry = event.item_id === undefined ? undefined : state.open.get(event.item_id)
  if (entry === undefined || event.delta === undefined) return
  entry.text += event.delta
  yield { type: 'reasoning-delta', index: entry.index, text: event.delta }
}

function* toolDelta(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const entry = event.item_id === undefined ? undefined : state.open.get(event.item_id)
  if (entry === undefined || event.delta === undefined) return
  entry.args += event.delta
  yield {
    type: 'tool-call-delta',
    index: entry.index,
    id: ToolCallId(entry.callId),
    ...entry.name.length > 0 ? { name: entry.name } : {},
    argumentsDelta: event.delta,
  }
}

function* partialImage(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const itemId = event.item_id
  const entry = itemId === undefined ? undefined : state.open.get(itemId)
  if (itemId === undefined || entry === undefined || event.partial_image_b64 === undefined) return
  yield {
    type: 'image-delta',
    index: entry.index,
    itemId,
    data: event.partial_image_b64,
    mediaType: state.imageMediaType,
    ...event.partial_image_index === undefined
      ? {}
      : { partialIndex: event.partial_image_index },
  }
}

function* itemDone(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const item = event.item
  const id = item?.id ?? event.item_id
  const entry = id === undefined ? undefined : state.open.get(id)
  if (item === undefined || entry === undefined) return
  const block = doneBlock(item, entry, state.imageMediaType)
  if (block !== undefined) yield { type: 'block-end', index: entry.index, block }
}

function* completed(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  const usage = event.response?.usage ?? undefined
  const mapped = usage === undefined ? undefined : mapUsage(usage)
  if (mapped !== undefined) yield { type: 'usage', usage: mapped }
  // This API has no explicit stop reason. Tool calls in the output ARE the
  // signal that the turn expects results back, which is what an agent loop
  // branches on.
  const reason: FinishReason = state.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
  yield { type: 'finish', reason }
}

function* incomplete(event: WireStreamEvent, displayName: string): Generator<ProtocolStreamChunk> {
  const usage = event.response?.usage ?? undefined
  const mapped = usage === undefined ? undefined : mapUsage(usage)
  if (mapped !== undefined) yield { type: 'usage', usage: mapped }
  const why = event.response?.incomplete_details?.reason
  if (why === 'max_output_tokens') {
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
    return
  }
  throw new ModelError(
    `${displayName} returned an incomplete response (${why ?? 'unknown reason'})`,
    MODEL_ERROR_CODES.SERVER,
  )
}

function* failed(event: WireStreamEvent, displayName: string): Generator<ProtocolStreamChunk> {
  // A failed generation can still be billed. Preserve the provider's
  // counters before the transport records the failure and retry admission.
  const usage = event.response?.usage ?? undefined
  const mapped = usage === undefined ? undefined : mapUsage(usage)
  if (mapped !== undefined) yield { type: 'usage', usage: mapped }
  throw failedError(event.response, displayName)
}

function* inlineError(event: WireStreamEvent, displayName: string): Generator<ProtocolStreamChunk> {
  // A top-level error event carries its fields inline rather than under a
  // `response` object, so it is reshaped to reuse the same classifier.
  const inline: WireErrorBody = {
    ...event.code === undefined ? {} : { code: event.code },
    ...event.message === undefined ? {} : { message: event.message },
  }
  throw failedError({ error: inline }, displayName)
}

function* deltaEvent(state: StreamState, event: WireStreamEvent): Generator<ProtocolStreamChunk> {
  switch (event.type) {
    case 'response.output_text.delta': yield* textDelta(state, event); return
    case 'response.reasoning_summary_text.delta': yield* summaryDelta(state, event); return
    case 'response.reasoning_text.delta': yield* reasoningDelta(state, event); return
    case 'response.function_call_arguments.delta': yield* toolDelta(state, event); return
    case 'response.image_generation_call.partial_image': yield* partialImage(state, event); return
    default: return
  }
}

function createOpenItem(
  state: StreamState, item: WireOutputItem, identity: { id: string; kind: ItemKind },
): OpenItem {
  const { id, kind } = identity
  return {
    index: state.nextIndex++,
    kind,
    text: '',
    args: '',
    callId: item.call_id ?? id,
    name: item.name ?? '',
    nativeName: nativeName(item.type),
    summaryIndex: undefined,
    phase: textPhase(item.phase),
  }
}
