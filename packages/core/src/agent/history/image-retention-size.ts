import type { ImageBlock, TextBlock } from '../../message/index.ts'
import { serializedBytes } from './config.ts'

const IMAGE_KEYS: ReadonlySet<string> = new Set(['type', 'source', 'detail'])
const SOURCE_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['base64', new Set(['kind', 'mediaType', 'data'])],
  ['url', new Set(['kind', 'url'])],
  ['file', new Set(['kind', 'fileId'])],
])
const JSON_SAFE_BASE64 = /^[A-Za-z0-9+/=_-]*$/

/**
 * History validation does not pin the image shape: extra fields, a non-string
 * detail, or non-base64 data are accepted. Only a canonical block may use the
 * arithmetic size; anything else is measured exactly so stored-byte
 * accounting never drifts from what the history actually serializes.
 */
function canonicalImage(image: ImageBlock): boolean {
  const source = image.source
  const sourceKeys = SOURCE_KEYS.get(source.kind)
  return sourceKeys !== undefined
    && Object.keys(image).every(key => IMAGE_KEYS.has(key))
    && (image.detail === undefined || typeof image.detail === 'string')
    && Object.keys(source).every(key => sourceKeys.has(key))
    && (source.kind !== 'base64' || JSON_SAFE_BASE64.test(source.data))
}

export function serializedByteLength(value: ImageBlock | TextBlock): number {
  if (value.type === 'text') return jsonStringLength(value.text) + 23 // {"type":"text","text":...}
  if (!canonicalImage(value)) return serializedBytes(value)
  const source = value.source
  let sourceFields: number[]
  if (source.kind === 'base64') {
    // ImageSource's base64 contract and ImageMediaType union are ASCII JSON-safe.
    // Avoid walking large payloads; the projection cache computes this once per block.
    sourceFields = [jsonProperty('kind', source.kind.length + 2),
      jsonProperty('mediaType', source.mediaType.length + 2),
      jsonProperty('data', source.data.length + 2)]
  } else {
    const key = source.kind === 'url' ? 'url' : 'fileId'
    const locator = source.kind === 'url' ? source.url : source.fileId
    sourceFields = [jsonProperty('kind', jsonStringLength(source.kind)), jsonProperty(key, jsonStringLength(locator))]
  }
  const sourceBytes = objectLength(sourceFields)
  const imageFields = [jsonProperty('type', jsonStringLength('image')),
    jsonProperty('source', sourceBytes),
    ...(value.detail === undefined ? [] : [jsonProperty('detail', jsonStringLength(value.detail))])]
  return objectLength(imageFields)
}

function objectLength(fields: readonly number[]): number {
  return 2 + fields.reduce((total, field) => total + field, Math.max(0, fields.length - 1))
}

function jsonProperty(name: string, valueBytes: number): number {
  return jsonStringLength(name) + 1 + valueBytes
}

/** UTF-8 bytes of JSON.stringify(text), computed without allocating a data-sized copy. */
function jsonStringLength(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    bytes += jsonCodeUnitLength(code, value.charCodeAt(index + 1))
    if (isHighSurrogatePair(code, value.charCodeAt(index + 1))) index++
  }
  return bytes
}

function jsonCodeUnitLength(code: number, next: number): number {
  if (JSON_ESCAPE_LENGTHS[code] !== undefined) return JSON_ESCAPE_LENGTHS[code]!
  if (code < 0x20) return 6
  return jsonUnicodeCodeUnitLength(code, next)
}

function jsonUnicodeCodeUnitLength(code: number, next: number): number {
  if (code >= 0xd800 && code <= 0xdbff) return next >= 0xdc00 && next <= 0xdfff ? 4 : 6
  if (code >= 0xdc00 && code <= 0xdfff) return 6
  if (code < 0x80) return 1
  return code < 0x800 ? 2 : 3
}

function isHighSurrogatePair(code: number, next: number): boolean {
  return code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}

const JSON_ESCAPE_LENGTHS: Readonly<Record<number, number>> = Object.freeze({
  8: 2, 9: 2, 10: 2, 12: 2, 13: 2, 34: 2, 92: 2,
})
