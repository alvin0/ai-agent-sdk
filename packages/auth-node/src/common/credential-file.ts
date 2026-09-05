import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentSdkError } from '@ai-agent-sdk/core'

export const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024
const LOCK_RETRY_MS = 10
const LOCK_TIMEOUT_MS = 30_000

/** Read one stable regular file without following its final symlink. */
export async function readCredentialText(
  location: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted()
  let handle: FileHandle | undefined
  try {
    handle = await openNoFollow(location, constants.O_RDONLY)
    signal?.throwIfAborted()
    const [opened, linked] = await Promise.all([handle.stat(), lstat(location)])
    if (!opened.isFile() || linked.isSymbolicLink()
      || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw credentialFileError('Codex credential path must be a stable regular file')
    }
    if (opened.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw credentialFileError('Codex credential file exceeds the 1 MiB limit')
    }
    const raw = await handle.readFile({ encoding: 'utf8', ...(signal === undefined ? {} : { signal }) })
    signal?.throwIfAborted()
    return raw
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Serialize cross-process compare-and-swap writers with an exclusive sidecar lock. */
export async function withCredentialFileLock<T>(
  location: string,
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const directory = dirname(location)
  await prepareDirectory(directory, signal)
  const lockPath = `${location}.lock`
  const startedAt = Date.now()
  let handle: FileHandle | undefined
  while (handle === undefined) {
    signal?.throwIfAborted()
    try {
      handle = await openNoFollow(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      )
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') throw error
      await rejectSymlink(lockPath)
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw credentialFileError(
          'Codex credential writer lock did not become available',
          undefined,
          'CODEX_CREDENTIAL_LOCK_TIMEOUT',
        )
      }
      await abortableDelay(LOCK_RETRY_MS, signal)
    }
  }
  try {
    signal?.throwIfAborted()
    return await task()
  } finally {
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

/** Atomically replace one credential file while preserving private modes. */
export async function replaceCredentialText(
  location: string,
  payload: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if (Buffer.byteLength(payload, 'utf8') > MAX_CREDENTIAL_FILE_BYTES) {
    throw credentialFileError('Codex credential file exceeds the 1 MiB limit')
  }
  const directory = dirname(location)
  await prepareDirectory(directory, signal)
  await rejectSymlink(location)
  const temporary = join(directory, `.auth-${process.pid}-${randomUUID()}.tmp`)
  let handle: FileHandle | undefined
  try {
    handle = await openNoFollow(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    )
    signal?.throwIfAborted()
    await handle.writeFile(payload, { encoding: 'utf8', ...(signal === undefined ? {} : { signal }) })
    await handle.sync()
    await handle.close()
    handle = undefined
    signal?.throwIfAborted()
    await chmod(temporary, 0o600)
    await rejectSymlink(location)
    await rename(temporary, location)
    await chmod(location, 0o600)
    await syncDirectory(directory)
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export function credentialFileError(
  message: string,
  cause?: unknown,
  code = 'INVALID_CREDENTIAL',
): AgentSdkError {
  return new AgentSdkError(message, code, cause === undefined ? {} : { cause })
}

function openNoFollow(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  return mode === undefined ? open(path, flags | noFollow) : open(path, flags | noFollow, mode)
}

async function prepareDirectory(directory: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const created = await mkdir(directory, { recursive: true, mode: 0o700 })
  if (created !== undefined) await chmod(directory, 0o700)
  signal?.throwIfAborted()
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw credentialFileError('Codex credential path must not be a symbolic link')
    }
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error: unknown) {
    const code = errorCode(error)
    if (process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL')) return
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('operation aborted')) }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}
