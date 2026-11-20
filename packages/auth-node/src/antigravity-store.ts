import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { defineCredentialStore } from '@alvin0/ai-agent-sdk-core/provider'
import { validateAntigravityAuthFile, type AntigravityCredentialStore } from '@alvin0/ai-agent-sdk-provider-antigravity'
import { accountAuthPath } from './common/account-path.ts'
import {
  credentialFileError, readCredentialBytes, replaceCredentialText, withCredentialFileLock,
} from './common/credential-file.ts'

export const DEFAULT_ANTIGRAVITY_AUTH_PATH = '.providers/.antigravity/auth.json'
export const ANTIGRAVITY_AUTH_PATH_ENV = 'AI_AGENT_SDK_ANTIGRAVITY_AUTH'

export interface AntigravityAuthPathOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export function antigravityAccountAuthPath(name: string): string { return accountAuthPath('antigravity', name) }

export function resolveAntigravityAuthPath(path?: string, options: AntigravityAuthPathOptions = {}): string {
  const selected = path?.trim() || (options.env ?? process.env)[ANTIGRAVITY_AUTH_PATH_ENV]?.trim()
    || DEFAULT_ANTIGRAVITY_AUTH_PATH
  if (selected.includes('\0')) throw new TypeError('Antigravity credential path must not contain NUL')
  return isAbsolute(selected) ? resolve(selected) : resolve(options.cwd ?? process.cwd(), selected)
}

const revisionOf = (raw: Buffer | string): string => createHash('sha256').update(raw).digest('hex')

export async function antigravityFileRevision(path: string, signal: AbortSignal): Promise<string | null> {
  const raw = await readCredentialBytes(path, signal)
  return raw === undefined ? null : revisionOf(raw)
}

/** Project-local, private, symlink-refusing file store with an atomic compare-and-swap commit. */
export function fileAntigravityCredentialStore(
  path?: string, options: AntigravityAuthPathOptions = {},
): AntigravityCredentialStore {
  const location = resolveAntigravityAuthPath(path, options)
  return defineCredentialStore({ id: 'antigravity-file-credentials', label: location,
    async read({ signal }) {
      const raw = await readCredentialBytes(location, signal)
      if (raw === undefined) return undefined
      try {
        const value = validateAntigravityAuthFile(JSON.parse(raw.toString('utf8')) as unknown)
        return { value, revision: revisionOf(raw) }
      }
      catch {
        throw credentialFileError('Antigravity credential file is invalid; sign in again',
          undefined, 'ANTIGRAVITY_AUTH_INVALID')
      }
    },
    async commit(input, { signal }) {
      if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string'
        || !input.expectedRevision || input.expectedRevision.length > 256)) {
        throw new TypeError('Invalid expected revision')
      }
      const payload = `${JSON.stringify(validateAntigravityAuthFile(input.value), null, 2)}\n`
      return withCredentialFileLock(location, signal, async () => {
        const raw = await readCredentialBytes(location, signal)
        if ((raw === undefined ? null : revisionOf(raw)) !== input.expectedRevision) {
          throw credentialFileError('Antigravity credential revision changed before commit',
            undefined, 'ANTIGRAVITY_CREDENTIAL_REVISION_CONFLICT')
        }
        await replaceCredentialText(location, payload, signal)
        return { revision: revisionOf(payload) }
      })
    },
  })
}
