import type { Message } from '../../message/index.ts'
import { MAX_CONTENT_DEPTH } from './config.ts'
import { isRecord, nonEmptyString, nonNegativeInteger,
  type SnapshotValidationState } from './validation-primitives.ts'

export function validateMessage(value: unknown, path: string,
  state: SnapshotValidationState): asserts value is Message {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const id = nonEmptyString(value.id, `${path}.id`)
  if (state.messageIds.has(id)) throw new TypeError(`duplicate message id '${id}'`)
  state.messageIds.add(id)
  if (!['system', 'user', 'assistant'].includes(String(value.role))) {
    throw new TypeError(`${path}.role is invalid`)
  }
  if (!Array.isArray(value.content)) throw new TypeError(`${path}.content must be an array`)
  for (let index = 0; index < value.content.length; index++) {
    validateContentBlock(value.content[index], `${path}.content[${index}]`, { state, ancestors: new Set(), depth: 0 })
  }
  validateMessageSource(value.source, `${path}.source`)
}

export function validateMessageSource(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const kind = nonEmptyString(value.kind, `${path}.kind`)
  switch (kind) {
    case 'user': return
    case 'app': nonEmptyString(value.producer, `${path}.producer`); return
    case 'model':
      nonEmptyString(value.provider, `${path}.provider`)
      nonEmptyString(value.model, `${path}.model`)
      return
    case 'tool': nonEmptyString(value.callId, `${path}.callId`); return
    default:
      // Message sources and content blocks are declaration-merge extensible.
      // Preserve third-party kinds while still requiring their discriminator.
      return
  }
}

export function validateContentBlock(
  value: unknown,
  path: string,
  context: ContentValidationContext,
): void {
  if (context.depth > MAX_CONTENT_DEPTH) throw new TypeError(`${path} exceeds the maximum content depth`)
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  if (context.ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`)
  const nextContext = { ...context, ancestors: new Set(context.ancestors).add(value) }
  const type = nonEmptyString(value.type, `${path}.type`)
  validateKnownContentBlock(value, path, nextContext, type)
}

interface ContentValidationContext {
  readonly state: SnapshotValidationState
  readonly ancestors: Set<object>
  readonly depth: number
}

function validateKnownContentBlock(
  value: Record<string, unknown>, path: string, context: ContentValidationContext, type: string,
): void {
  switch (type) {
    case 'text': return validateTextBlock(value, path)
    case 'reasoning': return validateReasoningBlock(value, path)
    case 'image': return validateImageBlock(value, path)
    case 'document': return validateDocumentBlock(value, path)
    case 'native-tool-call': return validateNativeToolCallBlock(value, path, context)
    case 'tool-call': return validateToolCallBlock(value, path, context)
    case 'tool-result': return validateToolResultBlock(value, path, context)
    default: return
  }
}

function validateTextBlock(
  value: Record<string, unknown>, path: string,
): void {
  if (typeof value.text !== 'string') throw new TypeError(`${path}.text must be a string`)
  if (value.phase !== undefined && !['commentary', 'final-answer'].includes(String(value.phase))) {
    throw new TypeError(`${path}.phase is invalid`)
  }
  if (value.annotations !== undefined) {
    if (!Array.isArray(value.annotations)) throw new TypeError(`${path}.annotations must be an array`)
    for (let index = 0; index < value.annotations.length; index++) {
      validateTextAnnotation(value.annotations[index], `${path}.annotations[${index}]`)
    }
  }
}

function validateReasoningBlock(
  value: Record<string, unknown>, path: string,
): void {
  if (typeof value.text !== 'string') throw new TypeError(`${path}.text must be a string`)
}

function validateImageBlock(
  value: Record<string, unknown>, path: string,
): void {
  validateImageSource(value.source, `${path}.source`)
}

function validateDocumentBlock(
  value: Record<string, unknown>, path: string,
): void {
  validateDocumentSource(value.source, `${path}.source`)
  for (const field of ['filename', 'title', 'context'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      throw new TypeError(`${path}.${field} must be a string`)
    }
  }
  if (value.citations !== undefined && typeof value.citations !== 'boolean') {
    throw new TypeError(`${path}.citations must be a boolean`)
  }
  if (value.pages !== undefined) {
    if (!Number.isSafeInteger(value.pages) || (value.pages as number) <= 0) {
      throw new TypeError(`${path}.pages must be a positive integer`)
    }
  }
}

function validateNativeToolCallBlock(
  value: Record<string, unknown>, path: string, context: ContentValidationContext,
): void {
  {
    const id = nonEmptyString(value.id, `${path}.id`)
    if (context.state.nativeToolIds.has(id)) throw new TypeError(`duplicate native tool id '${id}'`)
    context.state.nativeToolIds.add(id)
  }
  nonEmptyString(value.name, `${path}.name`)
  if (value.status !== undefined && typeof value.status !== 'string') {
    throw new TypeError(`${path}.status must be a string`)
  }
  validateContentArray(value.content, `${path}.content`, { ...context, depth: context.depth + 1 })
}

function validateToolCallBlock(
  value: Record<string, unknown>, path: string, context: ContentValidationContext,
): void {
  const id = nonEmptyString(value.id, `${path}.id`)
  if (context.state.toolCallIds.has(id)) throw new TypeError(`duplicate tool call id '${id}'`)
  context.state.toolCallIds.add(id)
  nonEmptyString(value.name, `${path}.name`)
  if (typeof value.arguments !== 'string') throw new TypeError(`${path}.arguments must be a string`)
}

function validateToolResultBlock(
  value: Record<string, unknown>, path: string, context: ContentValidationContext,
): void {
  nonEmptyString(value.toolCallId, `${path}.toolCallId`)
  if (value.isError !== undefined && typeof value.isError !== 'boolean') {
    throw new TypeError(`${path}.isError must be a boolean`)
  }
  validateContentArray(value.content, `${path}.content`, { ...context, depth: context.depth + 1 })
}

export function validateContentArray(
  value: unknown,
  path: string,
  context: ContentValidationContext,
): void {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  for (let index = 0; index < value.length; index++) {
    validateContentBlock(value[index], `${path}[${index}]`, context)
  }
}

export function validateTextAnnotation(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const type = nonEmptyString(value.type, `${path}.type`)
  if (type !== 'url-citation') return
  nonEmptyString(value.url, `${path}.url`)
  if (value.title !== undefined
    && typeof value.title !== 'string') throw new TypeError(`${path}.title must be a string`)
  for (const field of ['startIndex', 'endIndex'] as const) {
    if (value[field] !== undefined) nonNegativeInteger(value[field], `${path}.${field}`)
  }
}

export function validateImageSource(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const kind = nonEmptyString(value.kind, `${path}.kind`)
  if (kind === 'base64') {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(value.mediaType))) {
      throw new TypeError(`${path}.mediaType is invalid`)
    }
    if (typeof value.data !== 'string') throw new TypeError(`${path}.data must be a string`)
  } else if (kind === 'url') {
    nonEmptyString(value.url, `${path}.url`)
  } else if (kind === 'file') {
    nonEmptyString(value.fileId, `${path}.fileId`)
  } else {
    throw new TypeError(`${path}.kind is invalid`)
  }
}

export function validateDocumentSource(value: unknown, path: string): void {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  const kind = nonEmptyString(value.kind, `${path}.kind`)
  if (kind === 'base64') {
    if (String(value.mediaType) !== 'application/pdf') throw new TypeError(`${path}.mediaType is invalid`)
    if (typeof value.data !== 'string') throw new TypeError(`${path}.data must be a string`)
  } else if (kind === 'url') {
    nonEmptyString(value.url, `${path}.url`)
  } else if (kind === 'file') {
    nonEmptyString(value.fileId, `${path}.fileId`)
  } else {
    throw new TypeError(`${path}.kind is invalid`)
  }
}

export function validateToolResultMessage(message: Message, callId: string, path: string): void {
  if (message.source.kind !== 'tool' || message.source.callId !== callId) {
    throw new TypeError(`${path}.source.callId must match its tool-result event`)
  }
  if (message.role !== 'user' || message.content.length !== 1
    || message.content[0]?.type !== 'tool-result'
    || message.content[0].toolCallId !== callId) {
    throw new TypeError(`${path} must carry exactly one matching tool-result block`)
  }
}

export function validateToolExecutionResult(value: unknown, path: string): void {
  if (!isRecord(value) || typeof value.isError !== 'boolean') {
    throw new TypeError(`${path}.isError must be a boolean`)
  }
  validateDetachedContent(value.content, `${path}.content`)
  if (value.additionalContext !== undefined) {
    validateDetachedContent(value.additionalContext, `${path}.additionalContext`)
  }
  if (value.meta !== undefined && (!isRecord(value.meta))) throw new TypeError(`${path}.meta must be an object`)
  validateToolExecutionOutcome(value, path)
}

function validateToolExecutionOutcome(value: Record<string, unknown>, path: string): void {
  if (value.isError) {
    if (!isRecord(value.error)) throw new TypeError(`${path}.error must be an object`)
    nonEmptyString(value.error.message, `${path}.error.message`)
    nonEmptyString(value.error.code, `${path}.error.code`)
    if (value.concludesTurn !== undefined) throw new TypeError(`${path}.concludesTurn is invalid for a failure`)
  } else if (value.concludesTurn !== undefined && value.concludesTurn !== true) {
    throw new TypeError(`${path}.concludesTurn must be true when present`)
  }
}

export function validateDetachedContent(value: unknown, path: string): void {
  const state: SnapshotValidationState = {
    messageIds: new Set(), toolCallIds: new Set(), nativeToolIds: new Set(), toolCallEventIds: new Set(),
    compactions: new Map(), visibleMessageSeqs: new Set(),
  }
  validateContentArray(value, path, { state, ancestors: new Set(), depth: 0 })
}

