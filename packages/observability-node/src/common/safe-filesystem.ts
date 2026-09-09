import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { NODE_OBSERVATION_ERROR_CODES, NodeObservationError } from './errors.ts'

function ioError(message: string, error: unknown): NodeObservationError {
  if (error instanceof NodeObservationError) return error
  return new NodeObservationError(NODE_OBSERVATION_ERROR_CODES.io, message, { cause: error })
}

export async function ensureSafeRoot(input: string): Promise<string> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new TypeError('observation journal rootDir must be explicit and non-empty')
  }
  const requestedRoot = resolve(input)
  try {
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
    const requestedInfo = await lstat(requestedRoot)
    if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) throw new NodeObservationError(
      NODE_OBSERVATION_ERROR_CODES.io, 'observation journal root must be a real directory',
    )
    // Host-configured roots may include an operating-system alias such as
    // macOS /var -> /private/var. Canonicalize that trusted boundary once,
    // while continuing to reject a symlink as the final root component.
    const root = await realpath(requestedRoot)
    const canonicalInfo = await lstat(root)
    if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) throw new NodeObservationError(
      NODE_OBSERVATION_ERROR_CODES.io, 'observation journal root must resolve to a real directory',
    )
    await chmod(root, 0o700)
    return root
  } catch (error) {
    throw ioError('observation journal root validation failed', error)
  }
}

export async function openExclusiveFile(root: string, name: string): Promise<FileHandle> {
  if (basename(name) !== name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new TypeError('observation journal segment name is unsafe')
  }
  const path = join(root, name)
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | constants.O_APPEND | noFollow, 0o600)
    try {
      const [opened, linked] = await Promise.all([handle.stat(), lstat(path)])
      if (!opened.isFile() || linked.isSymbolicLink() || opened.dev !== linked.dev || opened.ino !== linked.ino) {
        throw new NodeObservationError(
          NODE_OBSERVATION_ERROR_CODES.io, 'observation journal segment identity changed during open',
        )
      }
      await chmod(path, 0o600)
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(path).catch(() => undefined)
      throw error
    }
  } catch (error) {
    throw ioError('observation journal segment open failed', error)
  }
}

export async function atomicWriteJson(root: string, targetName: string, value: unknown): Promise<void> {
  if (basename(targetName) !== targetName) throw new TypeError('atomic target name is unsafe')
  const temporary = `${targetName}.tmp-${randomUUID()}`
  const target = join(root, targetName)
  const handle = await openExclusiveFile(root, temporary)
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(join(root, temporary), target)
    await syncDirectory(dirname(target))
  } catch (error) {
    await unlink(join(root, temporary)).catch(() => undefined)
    throw ioError('observation journal cursor commit failed', error)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
    if (process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL')) return
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
