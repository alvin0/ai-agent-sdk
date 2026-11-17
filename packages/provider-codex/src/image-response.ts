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

function imageMediaType(data: string): ImageMediaType {
  validateBase64(data)
  const header = atob(data.slice(0, 24))
  if (header.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png'
  if (header.startsWith('\xff\xd8\xff')) return 'image/jpeg'
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp'
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
