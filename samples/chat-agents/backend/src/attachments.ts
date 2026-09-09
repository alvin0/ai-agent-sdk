/**
 * Durable storage and admission for what the user attaches to a prompt.
 *
 * Two kinds travel through here and they are NOT the same thing. An image is
 * model input: its bytes are base64-encoded into the prompt on every turn that
 * replays it, so the limits below bound what a provider request may cost. A
 * generic file is material: a text-ish one is inlined so the model can read it,
 * and anything else stays on disk with its path named in the prompt, because
 * inlining a PDF's bytes teaches the model nothing and spends the context
 * window doing it.
 *
 * Files never live in the workspace, for the same reason spill does not: the
 * agent's filesystem tools are confined to that directory, and an attachment
 * inside it would be discoverable, editable, and deletable by any run in the
 * project — including runs in other conversations.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import type { ContentBlock, ImageMediaType } from '@ai-agent-sdk/core'
import { databaseFile } from './db/client'

/** Raster types every supported provider accepts; the SDK's `ImageMediaType`. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
])

/** Largest encoded source accepted for one image. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Largest accepted generic file. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** Largest number of attachments accepted on one prompt. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20
/** Largest source width multiplied by height. */
const MAX_IMAGE_PIXELS = 64_000_000
/** Largest source width or height. */
const MAX_IMAGE_DIMENSION = 8192
/**
 * How much of a text file is inlined into the prompt.
 *
 * A cap rather than the whole file: an attached 5 MB log would otherwise spend
 * the entire context window before the agent read a word of the question. Past
 * the cap the prompt says so and names the path, which the agent can read.
 */
const MAX_INLINE_TEXT_BYTES = 128 * 1024

/** What an attachment is, once admitted. */
export type AttachmentKind = 'image' | 'file'

/** One admitted attachment, as both the browser and the prompt builder see it. */
export interface AttachmentRecord {
  /** Content address; stable across re-uploads of the same bytes and name. */
  readonly id: string
  /** Display name, sanitized to a single path-free leaf. */
  readonly name: string
  readonly mediaType: string
  readonly bytes: number
  readonly kind: AttachmentKind
  /** Intrinsic pixel width, for images whose header could be read. */
  readonly width?: number
  /** Intrinsic pixel height, for images whose header could be read. */
  readonly height?: number
}

/** An attachment refused at intake, with a code the UI can explain in its own words. */
export class AttachmentRejected extends Error {
  readonly code: string

  /**
   * @param code - Stable reason code.
   * @param message - One line naming what was refused and why.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AttachmentRejected'
    this.code = code
  }
}

/**
 * Where attachments live.
 * @returns Absolute directory, created on first use.
 */
export function attachmentRoot(): string {
  const root = process.env.CHAT_AGENTS_ATTACHMENTS
    ?? resolve(dirname(databaseFile()), 'attachments')
  // 0o700 for the same reason spill uses it: whatever the user attached is
  // theirs, and routinely a screenshot of something private.
  mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

/**
 * Reduce a browser-supplied name to one safe leaf.
 *
 * The name reaches the model and the filesystem, so it is rebuilt rather than
 * trusted: separators, traversal, and control characters are removed instead of
 * escaped, and an empty result gets a neutral placeholder.
 * @param raw - Browser-declared file name, possibly empty or hostile.
 * @returns A single path-free leaf.
 */
export function sanitizeName(raw: string): string {
  const flattened = raw
    // Control characters are stripped rather than escaped, and the class is
    // written by codepoint so the source stays readable.
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
  const leaf = flattened.replace(/^\.+/, '').slice(0, 120)
  return leaf === '' ? 'attachment' : leaf
}

/** Paths of one stored attachment: its bytes and its metadata sidecar. */
function pathsFor(id: string): { readonly blob: string; readonly meta: string } {
  const root = attachmentRoot()
  return { blob: join(root, `${id}.bin`), meta: join(root, `${id}.json`) }
}

/**
 * An id names one stored attachment, and nothing else.
 *
 * Ids ride in request bodies and in stored transcripts, so by the time one
 * comes back it is attacker-influenced text: it is matched against a strict
 * shape and joined to the root, never interpolated into a path.
 * @param id - Candidate id.
 * @returns True when the id has the minted shape.
 */
function wellFormed(id: string): boolean {
  return /^[0-9a-f]{32}$/.test(id)
}

/**
 * Read the intrinsic size out of an image header.
 *
 * A header parse rather than a decode: admission has to bound pixels before
 * anything allocates them, and a decoder that reads a 60,000×60,000 PNG to
 * find out it is too big has already lost. An unreadable header returns
 * nothing and the pixel limits simply do not bind — the byte limit still does.
 * @param bytes - The encoded image.
 * @param mediaType - Its declared type.
 * @returns Width and height, when the header discloses them.
 */
function imageSize(
  bytes: Buffer,
  mediaType: string,
): { readonly width: number; readonly height: number } | undefined {
  try {
    if (mediaType === 'image/png' && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    }
    if (mediaType === 'image/gif' && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
    }
    if (mediaType === 'image/webp' && bytes.length >= 30) {
      const format = bytes.toString('ascii', 12, 16)
      // Lossy: 14 bytes of VP8 frame header, then two 14-bit fields.
      if (format === 'VP8 ') {
        return { width: bytes.readUInt16LE(26) & 0x3FFF, height: bytes.readUInt16LE(28) & 0x3FFF }
      }
      if (format === 'VP8L') {
        const packed = bytes.readUInt32LE(21)
        return { width: (packed & 0x3FFF) + 1, height: ((packed >> 14) & 0x3FFF) + 1 }
      }
      if (format === 'VP8X') {
        return {
          width: (bytes.readUIntLE(24, 3)) + 1,
          height: (bytes.readUIntLE(27, 3)) + 1,
        }
      }
      return undefined
    }
    if (mediaType === 'image/jpeg') {
      // Walk the marker chain to the frame header; SOF0..SOF15 carry the size,
      // minus the four that are not frames at all.
      let offset = 2
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xFF) { offset += 1; continue }
        const marker = bytes[offset + 1] ?? 0
        const length = bytes.readUInt16BE(offset + 2)
        const isFrame = marker >= 0xC0 && marker <= 0xCF
          && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC
        if (isFrame) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
        }
        offset += 2 + length
      }
    }
  } catch {
    // A truncated or malformed header is not a reason to refuse the upload
    // here; the byte limit already bounds it, and the provider will say so.
  }
  return undefined
}

/**
 * Whether the bytes actually are what they claim to be.
 *
 * A browser's declared MIME comes from the file extension, so a `.png` that is
 * really a 20 MB video would otherwise be sent to a provider as an image and
 * rejected there, far from where it could be explained.
 * @param bytes - The encoded image.
 * @param mediaType - Its declared type.
 * @returns True when the magic bytes match.
 */
function magicMatches(bytes: Buffer, mediaType: string): boolean {
  if (bytes.length < 12) return false
  if (mediaType === 'image/png') return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  if (mediaType === 'image/jpeg') return bytes[0] === 0xFF && bytes[1] === 0xD8
  if (mediaType === 'image/gif') return bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a'
  if (mediaType === 'image/webp') {
    return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  }
  return true
}

/**
 * Admit one attachment and store its bytes.
 *
 * Admission is write-time policy only: an already-stored attachment stays
 * readable after these limits are tightened, so a conversation from last week
 * still replays.
 * @param bytes - Exact file bytes.
 * @param name - Browser-declared display name.
 * @param declaredType - Browser-declared MIME, possibly empty.
 * @returns The stored record.
 * @throws AttachmentRejected when a limit or a type check refuses it.
 */
export function storeAttachment(
  bytes: Buffer,
  name: string,
  declaredType: string,
): AttachmentRecord {
  const safeName = sanitizeName(name)
  const mediaType = declaredType.split(';')[0]?.trim().toLowerCase() ?? ''
  const isImage = IMAGE_MEDIA_TYPES.has(mediaType)

  if (bytes.length === 0) {
    throw new AttachmentRejected('EMPTY_FILE', `"${safeName}" is empty`)
  }
  if (isImage) {
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new AttachmentRejected(
        'IMAGE_TOO_LARGE',
        `"${safeName}" is ${sizeText(bytes.length)}; images are limited to ${sizeText(MAX_IMAGE_BYTES)}`,
      )
    }
    if (!magicMatches(bytes, mediaType)) {
      throw new AttachmentRejected(
        'MEDIA_TYPE_MISMATCH',
        `"${safeName}" does not contain ${mediaType} data`,
      )
    }
  } else if (bytes.length > MAX_FILE_BYTES) {
    throw new AttachmentRejected(
      'FILE_TOO_LARGE',
      `"${safeName}" is ${sizeText(bytes.length)}; files are limited to ${sizeText(MAX_FILE_BYTES)}`,
    )
  }

  const size = isImage ? imageSize(bytes, mediaType) : undefined
  if (size !== undefined) {
    if (size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION) {
      throw new AttachmentRejected(
        'IMAGE_DIMENSION',
        `"${safeName}" is ${String(size.width)}×${String(size.height)};`
        + ` neither side may exceed ${String(MAX_IMAGE_DIMENSION)}px`,
      )
    }
    if (size.width * size.height > MAX_IMAGE_PIXELS) {
      throw new AttachmentRejected(
        'IMAGE_PIXELS',
        `"${safeName}" has more than ${String(MAX_IMAGE_PIXELS / 1_000_000)} megapixels`,
      )
    }
  }

  // Content-addressed over bytes AND name: identical uploads collapse onto one
  // object, while the same picture attached twice under different names keeps
  // the name each message was sent with.
  const id = createHash('sha256')
    .update(bytes)
    .update(' ')
    .update(safeName)
    .digest('hex')
    .slice(0, 32)
  const record: AttachmentRecord = {
    id,
    name: safeName,
    mediaType: mediaType === '' ? 'application/octet-stream' : mediaType,
    bytes: bytes.length,
    kind: isImage ? 'image' : 'file',
    ...size === undefined ? {} : { width: size.width, height: size.height },
  }
  const paths = pathsFor(id)
  if (!existsSync(paths.blob)) writeFileSync(paths.blob, bytes, { mode: 0o600 })
  writeFileSync(paths.meta, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  return record
}

/**
 * Read one stored attachment's metadata.
 * @param id - The attachment id.
 * @returns The record, or undefined when the id is unknown or malformed.
 */
export function readAttachment(id: string): AttachmentRecord | undefined {
  if (!wellFormed(id)) return undefined
  const paths = pathsFor(id)
  if (!existsSync(paths.meta) || !existsSync(paths.blob)) return undefined
  try {
    return JSON.parse(readFileSync(paths.meta, 'utf8')) as AttachmentRecord
  } catch {
    return undefined
  }
}

/**
 * Read one stored attachment's bytes.
 * @param id - The attachment id.
 * @returns The bytes, or undefined when the id is unknown or malformed.
 */
export function readAttachmentBytes(id: string): Buffer | undefined {
  if (!wellFormed(id)) return undefined
  const paths = pathsFor(id)
  if (!existsSync(paths.blob)) return undefined
  try {
    return readFileSync(paths.blob)
  } catch {
    return undefined
  }
}

/**
 * The on-disk path of one stored attachment.
 * @param id - The attachment id.
 * @returns The absolute path, or undefined when the id is unknown.
 */
export function attachmentPath(id: string): string | undefined {
  if (!wellFormed(id)) return undefined
  const path = pathsFor(id).blob
  return existsSync(path) ? path : undefined
}

/** Types whose bytes are worth putting in front of the model verbatim. */
const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/typescript',
  'application/x-yaml', 'application/yaml', 'application/toml', 'application/sql',
  'application/x-sh', 'image/svg+xml',
])

/** Extensions a browser routinely reports as `application/octet-stream`. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.csv', '.tsv', '.xml', '.html', '.css', '.scss', '.sql', '.sh', '.bash', '.zsh', '.env',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.lua', '.vue', '.svelte', '.log',
  '.gitignore', '.dockerfile', '.diff', '.patch',
])

/**
 * Whether a file's content should be inlined as text.
 * @param record - The stored attachment.
 * @returns True when the bytes are text the model can read.
 */
function isTextual(record: AttachmentRecord): boolean {
  if (record.mediaType.startsWith('text/')) return true
  if (TEXT_MEDIA_TYPES.has(record.mediaType)) return true
  if (record.mediaType.endsWith('+json') || record.mediaType.endsWith('+xml')) return true
  return TEXT_EXTENSIONS.has(extname(record.name).toLowerCase())
}

/**
 * Human byte size, matching what the composer shows.
 * @param bytes - Byte count.
 * @returns A short label such as `1.2 MB`.
 */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Resolve prompt attachment ids into the blocks the model receives.
 *
 * Order is the order the user picked them in, and it is preserved: a prompt
 * that says "compare the first two" means the first two on screen.
 * @param ids - Attachment ids from the request body.
 * @returns The records that resolved and the content blocks they project into.
 * @throws AttachmentRejected when more attachments are sent than one message allows.
 */
export function projectAttachments(ids: readonly string[]): {
  readonly records: readonly AttachmentRecord[]
  readonly blocks: readonly ContentBlock[]
} {
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentRejected(
      'TOO_MANY_ATTACHMENTS',
      `one message may carry ${String(MAX_ATTACHMENTS_PER_MESSAGE)} attachments; ${String(ids.length)} were sent`,
    )
  }
  const records: AttachmentRecord[] = []
  const blocks: ContentBlock[] = []
  for (const id of ids) {
    const record = readAttachment(id)
    if (record === undefined) continue
    records.push(record)
    if (record.kind === 'image') {
      const bytes = readAttachmentBytes(id)
      if (bytes === undefined) continue
      blocks.push({
        type: 'image',
        source: {
          kind: 'base64',
          mediaType: record.mediaType as ImageMediaType,
          data: bytes.toString('base64'),
        },
      })
      continue
    }
    blocks.push({ type: 'text', text: fileBlockText(record) })
  }
  return { records, blocks }
}

/**
 * What the model is told about one attached file.
 *
 * Text is inlined because that is the only way the model can read it — the
 * agent's own filesystem tools are confined to the workspace, and attachments
 * deliberately live outside it. Anything else is named, sized, and located, so
 * a run that genuinely needs the bytes can be given a tool that reaches them
 * rather than being handed megabytes of base64 it cannot use.
 * @param record - The stored attachment.
 * @returns One text block's content.
 */
function fileBlockText(record: AttachmentRecord): string {
  const path = attachmentPath(record.id)
  const header = `Attached file: ${record.name} (${record.mediaType}, ${sizeText(record.bytes)})`
  if (!isTextual(record)) {
    return `${header}\nStored at: ${path ?? '(unavailable)'}\n`
      + 'Its bytes are not text; ask before assuming what it contains.'
  }
  const bytes = readAttachmentBytes(record.id)
  if (bytes === undefined) return `${header}\nIts stored bytes could not be read.`
  const truncated = bytes.length > MAX_INLINE_TEXT_BYTES
  const text = bytes.subarray(0, MAX_INLINE_TEXT_BYTES).toString('utf8')
  const tail = truncated
    ? `\n[…truncated at ${sizeText(MAX_INLINE_TEXT_BYTES)}; the whole file is at ${path ?? '(unavailable)'}]`
    : ''
  return `${header}\n\`\`\`\n${text}\n\`\`\`${tail}`
}
