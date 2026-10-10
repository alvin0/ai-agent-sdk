import type { ContentBlock } from '../../../message/index.ts'
import type { StreamChunk } from '../../../stream/index.ts'

export function validateStreamChunk(chunk: StreamChunk, maxBlockNodes: number): void {
  if (typeof chunk !== 'object' || chunk === null || typeof chunk.type !== 'string') {
    throw new TypeError('chunk must be an object with a type')
  }
  if ('index' in chunk && (!Number.isSafeInteger(chunk.index) || chunk.index < 0)) {
    throw new TypeError('chunk index must be a non-negative safe integer')
  }
  const validator = CHUNK_VALIDATORS[chunk.type]
  if (validator === undefined) throw new TypeError(`unknown chunk type '${String(chunk.type)}'`)
  validator(chunk, maxBlockNodes)
}

type ChunkValidator = (chunk: StreamChunk, maxBlockNodes: number) => void
const CHUNK_VALIDATORS: Partial<Record<StreamChunk['type'], ChunkValidator>> = {
  'block-start': (chunk) => {
    const value = chunk as Extract<StreamChunk, { type: 'block-start' }>
    requireNonEmpty(value.blockType, 'blockType must be non-empty')
  },
  'text-delta': (chunk) => {
    const value = chunk as Extract<StreamChunk, { type: 'text-delta' }>
    validateText(value.text, value.phase, 'text delta must be a string', 'text phase is invalid')
  },
  'reasoning-delta': (chunk) => {
    if (typeof (chunk as Extract<StreamChunk, { type: 'reasoning-delta' }>).text !== 'string') {
      throw new TypeError('reasoning delta must be a string')
    }
  },
  'image-delta': (chunk) => validateImageDelta(chunk as Extract<StreamChunk, { type: 'image-delta' }>),
  'tool-call-delta': (chunk) => validateToolCallDelta(chunk as Extract<StreamChunk, { type: 'tool-call-delta' }>),
  'block-end': (chunk, max) => validateBlockEnd(chunk as Extract<StreamChunk, { type: 'block-end' }>, max),
  'usage-progress': (chunk) => validateUsageProgress(chunk as Extract<StreamChunk, { type: 'usage-progress' }>),
  usage: (chunk) => validateUsage(chunk as Extract<StreamChunk, { type: 'usage' }>),
  finish: (chunk) => validateFinish((chunk as Extract<StreamChunk, { type: 'finish' }>).reason),
}

export function validateContentBlock(root: ContentBlock, maxNodes: number): void {
  const pending: unknown[] = [root]
  let nodes = 0
  while (pending.length > 0) {
    const value = pending.pop()
    if (!record(value) || typeof value.type !== 'string' || value.type.length === 0) {
      throw new TypeError('content block must be an object with a non-empty type')
    }
    nodes++
    if (nodes > maxNodes) throw new TypeError(`content block tree exceeds ${maxNodes} nodes`)
    const children = CONTENT_VALIDATORS[value.type]?.(value) ?? []
    for (const child of children.toReversed()) pending.push(child)
  }
}

function validateText(
  text: unknown,
  phase: unknown,
  textMessage: string,
  phaseMessage: string,
): void {
  if (typeof text !== 'string') throw new TypeError(textMessage)
  if (phase !== undefined && phase !== 'commentary' && phase !== 'final-answer') {
    throw new TypeError(phaseMessage)
  }
}

function validateIndex(value: unknown, message: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(message)
  }
}

function requireNonEmpty(value: unknown, message: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(message)
}

function validateToolCallDelta(chunk: Extract<StreamChunk, { type: 'tool-call-delta' }>): void {
  if (typeof chunk.id !== 'string' || chunk.id.length === 0
    || (chunk.name !== undefined && typeof chunk.name !== 'string')
    || typeof chunk.argumentsDelta !== 'string') throw new TypeError('tool-call delta fields are invalid')
}

function validateImageDelta(chunk: Extract<StreamChunk, { type: 'image-delta' }>): void {
  if (typeof chunk.itemId !== 'string' || typeof chunk.data !== 'string'
    || typeof chunk.mediaType !== 'string') throw new TypeError('image delta fields must be strings')
  validateIndex(chunk.partialIndex, 'image partialIndex must be a non-negative safe integer')
}

function validateBlockEnd(chunk: Extract<StreamChunk, { type: 'block-end' }>, maxNodes: number): void {
  if (typeof chunk.block !== 'object' || chunk.block === null || typeof chunk.block.type !== 'string') {
    throw new TypeError('block-end must contain a content block')
  }
  validateContentBlock(chunk.block, maxNodes)
}

function validateUsageProgress(chunk: Extract<StreamChunk, { type: 'usage-progress' }>): void {
  const fields = [
    'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  ] as const
  for (const key of fields) {
    if (chunk.usage[key] !== undefined) validateUsageCount(chunk.usage[key], key)
  }
}

function validateUsage(chunk: Extract<StreamChunk, { type: 'usage' }>): void {
  validateUsageCount(chunk.usage.inputTokens, 'inputTokens')
  validateUsageCount(chunk.usage.outputTokens, 'outputTokens')
  validateUsageProgress({ ...chunk, type: 'usage-progress' })
}

function validateFinish(reason: Extract<StreamChunk, { type: 'finish' }>['reason']): void {
  if (typeof reason !== 'object' || reason === null || typeof reason.kind !== 'string') {
    throw new TypeError('finish reason is invalid')
  }
  if ((reason.kind === 'error' || reason.kind === 'aborted')
    && (typeof reason.failure !== 'object' || reason.failure === null
      || typeof reason.failure.message !== 'string' || typeof reason.failure.code !== 'string')) {
    throw new TypeError('finish failure is invalid')
  }
}

function validateSource(source: unknown, label: 'image' | 'document'): void {
  if (!record(source) || typeof source.kind !== 'string') throw new TypeError(`${label} block source is invalid`)
  if (source.kind === 'base64') {
    if (typeof source.data !== 'string' || typeof source.mediaType !== 'string') {
      throw new TypeError(`base64 ${label} source is invalid`)
    }
  } else if (source.kind === 'url') {
    if (typeof source.url !== 'string') throw new TypeError(`URL ${label} source is invalid`)
  } else if (source.kind === 'file') {
    if (typeof source.fileId !== 'string') throw new TypeError(`file ${label} source is invalid`)
  } else throw new TypeError(`${label} source kind is invalid`)
}

function validateToolCall(value: Extract<ContentBlock, { type: 'tool-call' }>): void {
  if (typeof value.id !== 'string' || value.id.length === 0
    || typeof value.name !== 'string' || value.name.length === 0
    || typeof value.arguments !== 'string') throw new TypeError('tool-call block fields are invalid')
}

function validateToolResult(value: Extract<ContentBlock, { type: 'tool-result' }>): readonly unknown[] {
  if (typeof value.toolCallId !== 'string' || value.toolCallId.length === 0
    || !Array.isArray(value.content)
    || (value.isError !== undefined && typeof value.isError !== 'boolean')) {
    throw new TypeError('tool-result block fields are invalid')
  }
  return value.content
}

function validateNativeToolCall(value: Extract<ContentBlock, { type: 'native-tool-call' }>): readonly unknown[] {
  if (typeof value.id !== 'string' || value.id.length === 0
    || typeof value.name !== 'string' || value.name.length === 0
    || (value.status !== undefined && typeof value.status !== 'string')
    || !Array.isArray(value.content)) throw new TypeError('native-tool-call block fields are invalid')
  return value.content
}

type ContentValidator = (value: Record<string, unknown>) => readonly unknown[]
const CONTENT_VALIDATORS: Record<string, ContentValidator> = {
  text: value => {
    validateText(value.text, value.phase, 'text block text must be a string', 'text block phase is invalid')
    return []
  },
  reasoning: value => {
    if (typeof value.text !== 'string') throw new TypeError('reasoning block text must be a string')
    return []
  },
  image: value => {
    validateSource(value.source, 'image')
    return []
  },
  document: value => {
    validateSource(value.source, 'document')
    return []
  },
  'tool-call': value => {
    validateToolCall(value as unknown as Extract<ContentBlock, { type: 'tool-call' }>)
    return []
  },
  'tool-result': value => validateToolResult(value as unknown as Extract<ContentBlock, { type: 'tool-result' }>),
  'native-tool-call': value => validateNativeToolCall(
    value as unknown as Extract<ContentBlock, { type: 'native-tool-call' }>,
  ),
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function validateUsageCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value)
    || value < 0) throw new TypeError(`usage ${field} must be a non-negative safe integer`)
}
