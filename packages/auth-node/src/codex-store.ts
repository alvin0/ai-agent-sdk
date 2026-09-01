/** Symlink-safe, atomic Node filesystem store for Codex OAuth credentials. */

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
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { AgentSdkError } from '@ai-agent-sdk/core'
import type { CodexAuthFile, CodexAuthStore } from '@ai-agent-sdk/provider-codex'

export const DEFAULT_CODEX_AUTH_PATH = '.providers/.codex/auth.json'
export const CODEX_AUTH_PATH_ENV = 'AI_AGENT_SDK_CODEX_AUTH'
const MAX_CODEX_AUTH_BYTES = 1024 * 1024

export interface CodexAuthPathOptions {
  /** Base for relative paths. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Environment source. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

export function resolveCodexAuthPath(
  explicitPath?: string,
  options: CodexAuthPathOptions = {},
): string {
  const env = options.env ?? process.env
  const selected = nonEmptyPath(explicitPath)
    ?? nonEmptyPath(env[CODEX_AUTH_PATH_ENV])
    ?? DEFAULT_CODEX_AUTH_PATH
  const cwd = resolve(options.cwd ?? process.cwd())
  return isAbsolute(selected) ? resolve(selected) : resolve(cwd, selected)
}

export function fileCodexAuthStore(
  path?: string,
  options: CodexAuthPathOptions = {},
): CodexAuthStore {
  const location = resolveCodexAuthPath(path, options)
  return {
    location,
    async read(): Promise<CodexAuthFile | undefined> {
      let handle: FileHandle | undefined
      try {
        handle = await openNoFollow(location, constants.O_RDONLY)
        const [opened, linked] = await Promise.all([handle.stat(), lstat(location)])
        if (!opened.isFile() || linked.isSymbolicLink()
          || opened.dev !== linked.dev || opened.ino !== linked.ino) {
          throw credentialError('Codex credential path must be a stable regular file')
        }
        if (opened.size > MAX_CODEX_AUTH_BYTES) {
          throw credentialError('Codex credential file exceeds the 1 MiB limit')
        }
        const raw = await handle.readFile('utf8')
        try {
          return JSON.parse(raw) as CodexAuthFile
        } catch (error: unknown) {
          throw credentialError('Codex credential file is not valid JSON; delete it and log in again', error)
        }
      } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return undefined
        throw error
      } finally {
        await handle?.close().catch(() => undefined)
      }
    },
    async write(file: CodexAuthFile): Promise<void> {
      const payload = `${JSON.stringify(file, null, 2)}\n`
      if (Buffer.byteLength(payload, 'utf8') > MAX_CODEX_AUTH_BYTES) {
        throw credentialError('Codex credential file exceeds the 1 MiB limit')
      }
      const directory = dirname(location)
      const created = await mkdir(directory, { recursive: true, mode: 0o700 })
      if (created !== undefined) await chmod(directory, 0o700)
      await rejectCredentialSymlink(location)

      const temporary = join(directory, `.auth-${process.pid}-${randomUUID()}.tmp`)
      let handle: FileHandle | undefined
      try {
        handle = await openNoFollow(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        )
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await chmod(temporary, 0o600)
        await rejectCredentialSymlink(location)
        await rename(temporary, location)
        await chmod(location, 0o600)
        await syncDirectory(directory)
      } catch (error: unknown) {
        await handle?.close().catch(() => undefined)
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    },
  }
}

function nonEmptyPath(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  if (value.includes('\0')) throw new TypeError('Codex credential path must not contain NUL')
  return value
}

async function openNoFollow(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  return mode === undefined ? open(path, flags | noFollow) : open(path, flags | noFollow, mode)
}

async function rejectCredentialSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw credentialError('Codex credential path must not be a symbolic link')
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

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
}

function credentialError(message: string, cause?: unknown): AgentSdkError {
  return new AgentSdkError(message, 'INVALID_CREDENTIAL', cause === undefined ? {} : { cause })
}
