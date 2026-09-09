/** Symlink-safe, atomic Node filesystem store for Codex OAuth credentials. */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { defineCredentialStore } from '@alvin0/ai-agent-sdk-core/provider'
import type {
  CodexAuthFile,
  CodexAuthStore,
  CodexCredentialStore,
} from '@alvin0/ai-agent-sdk-provider-codex'
import {
  credentialFileError,
  readCredentialText,
  replaceCredentialText,
  withCredentialFileLock,
} from './common/credential-file.ts'

export const DEFAULT_CODEX_AUTH_PATH = '.providers/.codex/auth.json'
export const CODEX_AUTH_PATH_ENV = 'AI_AGENT_SDK_CODEX_AUTH'

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

/** @deprecated Use the revisioned {@link fileCodexCredentialStore}. */
export function fileCodexAuthStore(
  path?: string,
  options: CodexAuthPathOptions = {},
): CodexAuthStore {
  const location = resolveCodexAuthPath(path, options)
  return {
    location,
    async read(): Promise<CodexAuthFile | undefined> {
      return (await readAuthFile(location))?.file
    },
    async write(file: CodexAuthFile): Promise<void> {
      const payload = authPayload(file)
      await withCredentialFileLock(location, undefined, async () => {
        await replaceCredentialText(location, payload)
      })
    },
  }
}

/** Revisioned compare-and-swap store used by normal Node provider composition. */
export function fileCodexCredentialStore(
  path?: string,
  options: CodexAuthPathOptions = {},
): CodexCredentialStore {
  const location = resolveCodexAuthPath(path, options)
  return defineCredentialStore<CodexAuthFile>({
    id: 'codex-file-credentials',
    label: 'Codex file credential store',
    async read({ signal }) {
      const snapshot = await readAuthFile(location, signal)
      return snapshot === undefined ? undefined : Object.freeze({
        value: snapshot.file,
        revision: revisionOf(snapshot.raw),
      })
    },
    async commit(input, { signal }) {
      validateExpectedRevision(input.expectedRevision)
      const payload = authPayload(input.value)
      return await withCredentialFileLock(location, signal, async () => {
        const current = await readAuthFile(location, signal)
        const actual = current === undefined ? null : revisionOf(current.raw)
        if (actual !== input.expectedRevision) {
          throw credentialFileError(
            'Codex credential revision changed before commit',
            undefined,
            'CODEX_CREDENTIAL_REVISION_CONFLICT',
          )
        }
        await replaceCredentialText(location, payload, signal)
        return Object.freeze({ revision: revisionOf(payload) })
      })
    },
  })
}

function nonEmptyPath(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  if (value.includes('\0')) throw new TypeError('Codex credential path must not contain NUL')
  return value
}

async function readAuthFile(
  location: string,
  signal?: AbortSignal,
): Promise<{ readonly file: CodexAuthFile; readonly raw: string } | undefined> {
  const raw = await readCredentialText(location, signal)
  if (raw === undefined) return undefined
  try {
    return Object.freeze({ file: JSON.parse(raw) as CodexAuthFile, raw })
  } catch (error: unknown) {
    throw credentialFileError(
      'Codex credential file is not valid JSON; delete it and log in again',
      error,
    )
  }
}

function authPayload(file: CodexAuthFile): string {
  try {
    const encoded = JSON.stringify(file, null, 2)
    if (encoded === undefined) throw new TypeError('credential value is not JSON')
    return `${encoded}\n`
  } catch (error: unknown) {
    throw credentialFileError('Codex credential value could not be serialized', error)
  }
}

function revisionOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function validateExpectedRevision(value: string | null): void {
  if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 256)) {
    throw credentialFileError('Codex expected credential revision is invalid')
  }
}
