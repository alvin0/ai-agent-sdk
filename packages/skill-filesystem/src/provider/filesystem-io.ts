import type { Dirent } from 'node:fs'
import { open, opendir } from 'node:fs/promises'
import { READ_CHUNK_BYTES, MAX_FRONT_MATTER_BYTES } from './filesystem-constants.ts'
import type { FileSystemSkillsOptions, FileSystemSkillIoPhase, FileSystemIoOptions } from './filesystem-types.ts'
import { normalize, throwIfAborted, emitIo } from './filesystem-support.ts'

export async function readFrontMatter(
  path: string,
  signal: AbortSignal | undefined,
  onIo: FileSystemSkillsOptions['onIo'],
): Promise<string> {
  throwIfAborted(signal)
  const handle = await open(path, 'r')
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < MAX_FRONT_MATTER_BYTES) {
      throwIfAborted(signal)
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_FRONT_MATTER_BYTES - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      total += bytesRead
      const prefix = normalize(Buffer.concat(chunks, total).toString('utf8'))
      const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(prefix)
      if (match !== null) {
        emitIo(onIo, { phase: 'discovery', operation: 'read', path, bytesRead: total })
        return match[0]
      }
    }
  } finally {
    await handle.close()
  }
  emitIo(onIo, { phase: 'discovery', operation: 'read', path, bytesRead: total })
  throw new RangeError(
    `skill '${path}' front matter is missing its closing delimiter within ${MAX_FRONT_MATTER_BYTES} bytes`,
  )
}

export async function readTextFileBounded(
  path: string,
  maxBytes: number,
  label: string,
  request: FileSystemIoOptions & {
    context?: { readonly phase: FileSystemSkillIoPhase; readonly skillId?: string };
  },
): Promise<string> {
  const { signal, onIo, context } = request
  throwIfAborted(signal)
  const handle = await open(path, 'r')
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} bytes`)
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally {
    await handle.close()
    if (context !== undefined) {
      emitIo(onIo, {
        phase: context.phase, operation: 'read', path,
        ...(context.skillId === undefined ? {} : { skillId: context.skillId }),
        bytesRead: total,
      })
    }
  }
}

export async function readDirectoryBounded(
  directory: string,
  maxEntries: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<Dirent[]> {
  if (maxEntries < 1) throw new RangeError(`${label} exceeds its entry limit`)
  const handle = await opendir(directory)
  const entries: Dirent[] = []
  try {
    for await (const entry of handle) {
      throwIfAborted(signal)
      if (entries.length >= maxEntries) {
        throw new RangeError(`${label} exceeds ${maxEntries} entries`)
      }
      entries.push(entry)
    }
  } finally {
    // Async iteration closes the handle. Some runtimes also reject a second
    // explicit close, so only close when iteration was interrupted and ignore
    // the already-closed case.
    await handle.close().catch(() => undefined)
  }
  return entries
}
