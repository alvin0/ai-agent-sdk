import { chmod, lstat, readFile, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_LIMITS } from './config.ts'
import { journalFailure } from './errors.ts'

export async function readSegmentLines(
  root: string, name: string, truncatedSegments: string[], runtime: boolean,
): Promise<string[]> {
  const path = join(root, name)
  const label = runtime ? 'runtime journal segment' : 'journal segment'
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw journalFailure('io', `${label} is not a regular file`)
  if (info.size > JOURNAL_LIMITS.recoverySegmentBytes)
    throw journalFailure('corrupt', `${label} exceeds recovery bound`)
  await chmod(path, 0o600)
  let text = await readFile(path, 'utf8')
  if (text.length > 0 && !text.endsWith('\n')) {
    const boundary = text.lastIndexOf('\n') + 1
    await truncate(path, Buffer.byteLength(text.slice(0, boundary)))
    text = text.slice(0, boundary)
    truncatedSegments.push(name)
  }
  return text.length === 0 ? [] : text.slice(0, -1).split('\n')
}
