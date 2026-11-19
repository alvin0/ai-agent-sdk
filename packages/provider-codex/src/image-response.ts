import { AgentSdkError, type ImageBlock, type ImageMediaType } from '@alvin0/ai-agent-sdk-core'
import type { CodexImageResult } from './image-types.ts'

/** No raw backend body, prompt, credential or base64 data is included in errors. */
export class CodexImageError extends AgentSdkError {
  readonly status?: number

  constructor(message: string, code: string, status?: number, options?: ErrorOptions) {
    super(message, code, options)
    if (status !== undefined) this.status = status
  }
}

function malformed(): never {
  throw new CodexImageError('Codex Images returned invalid image data', 'CODEX_IMAGE_MALFORMED')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateBase64(data: string): void {
  if (data.length === 0 || data.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) malformed()
  if (btoa(atob(data.slice(-4))) !== data.slice(-4)) malformed()
}

function isWebp(header: string, length: number): boolean {
  return header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(header.slice(12, 16)) && length > 24
    && new DataView(Uint8Array.from(header, ch => ch.charCodeAt(0)).buffer).getUint32(4, true) === length - 8
}

function isJpeg(header: string, tail: string): boolean {
  return header.startsWith('\xff\xd8\xff') && tail.endsWith('\xff\xd9')
}

function decodedLength(data: string): number {
  return data.length / 4 * 3 - (data.endsWith('==') ? 2 : Number(data.endsWith('=')))
}

function imageMediaType(data: string): ImageMediaType {
  validateBase64(data)
  // Check container boundaries without decoding pixels or allocating a second full image.
  const header = atob(data.slice(0, 48))
  const tail = atob(data.slice(-24))
  const length = decodedLength(data)
  if (header.startsWith('\x89PNG\r\n\x1a\n\0\0\0\rIHDR') && length > 57
    && tail.endsWith('\0\0\0\0IEND\xaeB\x60\x82')) return 'image/png'
  if (length > 24 && isJpeg(header, tail)) return 'image/jpeg'
  if (/^GIF8[79]a/.test(header) && length > 24 && tail.endsWith(';')) return 'image/gif'
  if (isWebp(header, length)) return 'image/webp'
  return malformed()
}

export function parseCodexImageBody(body: unknown): CodexImageResult {
  if (!record(body) || !Array.isArray(body.data) || body.data.length !== 1) malformed()
  const images: ImageBlock[] = body.data.map((entry: unknown) => {
    if (!record(entry) || typeof entry.b64_json !== 'string') malformed()
    return { type: 'image', source: {
      kind: 'base64', mediaType: imageMediaType(entry.b64_json), data: entry.b64_json,
    } }
  })
  return { images }
}
