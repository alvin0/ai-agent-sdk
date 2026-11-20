import { ModelError, type ImageBlock, type ImageMediaType } from '@alvin0/ai-agent-sdk-core'
import { object } from './http.ts'

/** Cloud Code uses separate image-generation model IDs; vision input alone is not this capability. */
export function isAntigravityImageModel(id: string): boolean {
  return /(?:^|[-_])(?:image|imagen)(?:[-_]|$)/i.test(id)
}

function imageMediaType(value: unknown): ImageMediaType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  throw new ModelError('Antigravity returned an unsupported image media type', 'MALFORMED_RESPONSE')
}

/** Preserve the provider's encoded bytes once in public content; replay metadata carries only signatures. */
export function inlineImage(value: unknown): ImageBlock {
  const inline = object(value)
  const mediaType = imageMediaType(inline.mimeType ?? inline.mime_type)
  const data = inline.data
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new ModelError('Antigravity returned invalid base64 image data', 'MALFORMED_RESPONSE')
  }
  return { type: 'image', source: { kind: 'base64', mediaType, data } }
}
