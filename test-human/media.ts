/** Image input loading and generated-image persistence. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import type { ContentBlock, ImageBlock, ImageMediaType } from '@ai-agent-sdk/core'
import { label } from './console.ts'

export async function loadImageBlock(input: string): Promise<ImageBlock> {
  if (/^https?:\/\//i.test(input)) return { type: 'image', source: { kind: 'url', url: input } }
  if (input.startsWith('file-id:')) {
    const fileId = input.slice('file-id:'.length)
    if (fileId.length === 0) throw new Error('file-id image source is empty')
    return { type: 'image', source: { kind: 'file', fileId }, detail: 'original' }
  }

  const path = resolve(input)
  const mediaType = mediaTypeOf(path)
  const data = (await readFile(path)).toString('base64')
  console.log(label('image-input'), basename(path), mediaType, `${data.length} base64 chars`)
  return { type: 'image', source: { kind: 'base64', mediaType, data }, detail: 'original' }
}

export async function saveGeneratedImages(
  callId: string,
  content: readonly ContentBlock[],
): Promise<void> {
  const images = content.filter((block): block is ImageBlock => block.type === 'image')
  if (images.length === 0) return
  const directory = resolve('test-human', 'output')
  await mkdir(directory, { recursive: true })

  for (let index = 0; index < images.length; index++) {
    const image = images[index]
    if (image?.source.kind === 'url') {
      console.log(label('image-output'), image.source.url)
      continue
    }
    if (image?.source.kind === 'file') {
      console.log(label('image-output'), `provider file id: ${image.source.fileId}`)
      continue
    }
    if (image === undefined) continue
    const extension = image.source.mediaType === 'image/jpeg' ? 'jpg'
      : image.source.mediaType.split('/')[1] ?? 'bin'
    const safeId = callId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const file = resolve(directory, `${Date.now()}-${safeId}-${index}.${extension}`)
    await writeFile(file, Buffer.from(image.source.data, 'base64'))
    console.log(label('image-output'), file)
  }
}

export function mediaTypeOf(path: string): ImageMediaType {
  const extension = extname(path).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.gif') return 'image/gif'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  throw new Error(`unsupported image extension '${extension}'; use png, jpg, jpeg, gif, or webp`)
}
