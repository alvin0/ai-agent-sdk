import type { Part } from '@a2a-js/sdk'
import type { ContentBlock, ImageMediaType } from '@ai-agent-sdk/core'

export function partsToContent(parts: readonly Part[]): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const part of parts) {
    const content = part.content
    if (content?.$case === 'text') {
      blocks.push({ type: 'text', text: content.value })
    } else if (content?.$case === 'url' && isImageMediaType(part.mediaType)) {
      blocks.push({ type: 'image', source: { kind: 'url', url: content.value } })
    } else if (content?.$case === 'raw' && isImageMediaType(part.mediaType)) {
      blocks.push({ type: 'image', source: { kind: 'base64', mediaType: part.mediaType,
        data: bytesToBase64(content.value) } })
    } else if (content?.$case === 'data') {
      blocks.push({ type: 'text', text: JSON.stringify(content.value) })
    } else if (content !== undefined) {
      const location = content.$case === 'url' ? `: ${content.value}` : ''
      blocks.push({ type: 'text',
        text: `[A2A attachment${part.mediaType.length === 0 ? '' : ` ${part.mediaType}`}${location}]` })
    }
  }
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks
}

function isImageMediaType(value: string): value is ImageMediaType {
  return value === 'image/jpeg' || value === 'image/png'
    || value === 'image/gif' || value === 'image/webp'
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
