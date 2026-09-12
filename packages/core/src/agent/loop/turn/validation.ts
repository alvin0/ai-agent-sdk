import type { ContentBlock } from '../../../message/index.ts'
import type { StreamChunk } from '../../../stream/index.ts'

export function validateStreamChunk(chunk: StreamChunk, maxBlockNodes: number): void {
  if (typeof chunk !== 'object' || chunk === null || typeof chunk.type !== 'string') {
    throw new TypeError('chunk must be an object with a type')
  }
  if ('index' in chunk && (!Number.isSafeInteger(chunk.index) || chunk.index < 0)) {
    throw new TypeError('chunk index must be a non-negative safe integer')
  }
  switch (chunk.type) {
    case 'block-start':
      if (typeof chunk.blockType !== 'string' || chunk.blockType.length === 0) throw new TypeError('blockType must be non-empty')
      return
    case 'text-delta':
      if (typeof chunk.text !== 'string') throw new TypeError('text delta must be a string')
      if (chunk.phase !== undefined && chunk.phase !== 'commentary' && chunk.phase !== 'final-answer') {
        throw new TypeError('text phase is invalid')
      }
      return
    case 'reasoning-delta':
      if (typeof chunk.text !== 'string') throw new TypeError('reasoning delta must be a string')
      return
    case 'image-delta':
      if (typeof chunk.itemId !== 'string' || typeof chunk.data !== 'string' || typeof chunk.mediaType !== 'string') {
        throw new TypeError('image delta fields must be strings')
      }
      if (chunk.partialIndex !== undefined
        && (!Number.isSafeInteger(chunk.partialIndex) || chunk.partialIndex < 0)) {
        throw new TypeError('image partialIndex must be a non-negative safe integer')
      }
      return
    case 'tool-call-delta':
      if (typeof chunk.id !== 'string' || chunk.id.length === 0
        || (chunk.name !== undefined && typeof chunk.name !== 'string')
        || typeof chunk.argumentsDelta !== 'string') {
        throw new TypeError('tool-call delta fields are invalid')
      }
      return
    case 'block-end':
      if (typeof chunk.block !== 'object' || chunk.block === null || typeof chunk.block.type !== 'string') {
        throw new TypeError('block-end must contain a content block')
      }
      validateContentBlock(chunk.block, maxBlockNodes)
      return
    case 'usage-progress':
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
        if (chunk.usage[key] !== undefined) validateUsageCount(chunk.usage[key], key)
      }
      return
    case 'usage':
      validateUsageCount(chunk.usage.inputTokens, 'inputTokens')
      validateUsageCount(chunk.usage.outputTokens, 'outputTokens')
      for (const key of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
        if (chunk.usage[key] !== undefined) validateUsageCount(chunk.usage[key], key)
      }
      return
    case 'finish':
      if (typeof chunk.reason !== 'object' || chunk.reason === null || typeof chunk.reason.kind !== 'string') {
        throw new TypeError('finish reason is invalid')
      }
      if ((chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')
        && (typeof chunk.reason.failure !== 'object' || chunk.reason.failure === null
          || typeof chunk.reason.failure.message !== 'string'
          || typeof chunk.reason.failure.code !== 'string')) {
        throw new TypeError('finish failure is invalid')
      }
      return
    default:
      throw new TypeError(`unknown chunk type '${String((chunk as { type?: unknown }).type)}'`)
  }
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
    switch (value.type) {
      case 'text':
        if (typeof value.text !== 'string') throw new TypeError('text block text must be a string')
        if (value.phase !== undefined && value.phase !== 'commentary' && value.phase !== 'final-answer') {
          throw new TypeError('text block phase is invalid')
        }
        break
      case 'reasoning':
        if (typeof value.text !== 'string') throw new TypeError('reasoning block text must be a string')
        break
      case 'image':
        if (!record(value.source) || typeof value.source.kind !== 'string') {
          throw new TypeError('image block source is invalid')
        }
        if (value.source.kind === 'base64') {
          if (typeof value.source.data !== 'string' || typeof value.source.mediaType !== 'string') {
            throw new TypeError('base64 image source is invalid')
          }
        } else if (value.source.kind === 'url') {
          if (typeof value.source.url !== 'string') throw new TypeError('URL image source is invalid')
        } else if (value.source.kind === 'file') {
          if (typeof value.source.fileId !== 'string') throw new TypeError('file image source is invalid')
        } else {
          throw new TypeError('image source kind is invalid')
        }
        break
      case 'document':
        if (!record(value.source) || typeof value.source.kind !== 'string') {
          throw new TypeError('document block source is invalid')
        }
        if (value.source.kind === 'base64') {
          if (typeof value.source.data !== 'string' || typeof value.source.mediaType !== 'string') {
            throw new TypeError('base64 document source is invalid')
          }
        } else if (value.source.kind === 'url') {
          if (typeof value.source.url !== 'string') throw new TypeError('URL document source is invalid')
        } else if (value.source.kind === 'file') {
          if (typeof value.source.fileId !== 'string') throw new TypeError('file document source is invalid')
        } else {
          throw new TypeError('document source kind is invalid')
        }
        break
      case 'tool-call':
        if (typeof value.id !== 'string' || value.id.length === 0
          || typeof value.name !== 'string' || value.name.length === 0
          || typeof value.arguments !== 'string') {
          throw new TypeError('tool-call block fields are invalid')
        }
        break
      case 'tool-result':
        if (typeof value.toolCallId !== 'string' || value.toolCallId.length === 0
          || !Array.isArray(value.content)
          || (value.isError !== undefined && typeof value.isError !== 'boolean')) {
          throw new TypeError('tool-result block fields are invalid')
        }
        for (let index = value.content.length - 1; index >= 0; index--) pending.push(value.content[index])
        break
      case 'native-tool-call':
        if (typeof value.id !== 'string' || value.id.length === 0
          || typeof value.name !== 'string' || value.name.length === 0
          || (value.status !== undefined && typeof value.status !== 'string')
          || !Array.isArray(value.content)) {
          throw new TypeError('native-tool-call block fields are invalid')
        }
        for (let index = value.content.length - 1; index >= 0; index--) pending.push(value.content[index])
        break
      default:
        // ContentBlockMap is declaration-merge extensible. The core can only
        // validate the tags it owns; extension blocks remain adapter-defined.
        break
    }
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function validateUsageCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`usage ${field} must be a non-negative safe integer`)
}
