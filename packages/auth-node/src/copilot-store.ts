/**
 * Symlink-safe, atomic Node filesystem store for Copilot credentials.
 *
 * This is a deliberate mirror of `./codex-store.ts`: same path precedence, same
 * revisioned compare-and-swap shape, and the SAME shared helpers from
 * `./common/credential-file.ts` rather than a second copy of them. The two
 * providers persist structurally different documents, but the hazards of writing
 * a secret to a filesystem are identical, so the write path is shared and only
 * the document type differs.
 *
 * The default path `.providers/.copilot/auth.json` belongs to THIS SDK and sits
 * beside `.providers/.codex/auth.json`, separate from the credential location of
 * any editor client or vendor CLI (Requirement 6.7). The reason differs from
 * Codex: Codex MUST be separate because its refresh token rotates, so sharing the
 * file would sign the user out of their real CLI. Copilot has no rotation hazard
 * at all, and is still separate for the two remaining reasons — the SDK has no
 * business writing into another program's file, and a file the SDK owns is the
 * precondition for `--status` telling the truth about the SDK's own state.
 *
 * @module ai-agent-sdk/auth-node/copilot-store
 */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { defineCredentialStore } from '@alvin0/ai-agent-sdk-core/provider'
import type {
  CopilotAuthFile,
  CopilotAuthStore,
  CopilotCredentialStore,
} from '@alvin0/ai-agent-sdk-provider-copilot'
import {
  credentialFileError,
  readCredentialText,
  replaceCredentialText,
  withCredentialFileLock,
} from './common/credential-file.ts'

export const DEFAULT_COPILOT_AUTH_PATH = '.providers/.copilot/auth.json'
export const COPILOT_AUTH_PATH_ENV = 'AI_AGENT_SDK_COPILOT_AUTH'

/**
 * The code a losing commit carries (Requirement 6.3).
 *
 * Spelled as a literal rather than read from `COPILOT_ERROR_CODES` on purpose:
 * `@alvin0/ai-agent-sdk-provider-copilot` is an OPTIONAL peer of this package, so
 * every other reference to it here is type-only. A value import would turn the
 * optional peer into a hard runtime requirement of this module.
 */
const COPILOT_REVISION_CONFLICT_CODE = 'COPILOT_CREDENTIAL_REVISION_CONFLICT'

export interface CopilotAuthPathOptions {
  /** Base for relative paths. Defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Environment source. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/**
 * Resolve the credential file path: `explicitPath` → environment → default.
 *
 * An empty or all-whitespace string counts as absent, so an unset shell variable
 * that expanded to `''` falls through to the next source instead of resolving to
 * the current directory (Requirement 6.5).
 * @param explicitPath - a caller-supplied path; highest precedence.
 * @param options - the `cwd` relative paths resolve against, and the environment source.
 * @returns an absolute path.
 * @throws TypeError when a supplied path contains a NUL character.
 */
export function resolveCopilotAuthPath(
  explicitPath?: string,
  options: CopilotAuthPathOptions = {},
): string {
  const env = options.env ?? process.env
  const selected = nonEmptyPath(explicitPath)
    ?? nonEmptyPath(env[COPILOT_AUTH_PATH_ENV])
    ?? DEFAULT_COPILOT_AUTH_PATH
  const cwd = resolve(options.cwd ?? process.cwd())
  return isAbsolute(selected) ? resolve(selected) : resolve(cwd, selected)
}

/** @deprecated Use the revisioned {@link fileCopilotCredentialStore}. */
export function fileCopilotAuthStore(
  path?: string,
  options: CopilotAuthPathOptions = {},
): CopilotAuthStore {
  const location = resolveCopilotAuthPath(path, options)
  return {
    location,
    async read(): Promise<CopilotAuthFile | undefined> {
      return (await readAuthFile(location))?.file
    },
    async write(file: CopilotAuthFile): Promise<void> {
      const payload = authPayload(file)
      await withCredentialFileLock(location, undefined, async () => {
        await replaceCredentialText(location, payload)
      })
    },
  }
}

/**
 * Revisioned compare-and-swap store used by normal Node provider composition.
 *
 * The revision is a sha256 of the RAW file bytes, so any change made by any
 * writer — this SDK or a hand edit — invalidates a revision a reader is holding.
 * The compare and the replace both happen inside `withCredentialFileLock`, which
 * is what makes exactly one of two concurrent commits win (Requirement 6.3).
 * @param path - an explicit credential path; otherwise resolved by precedence.
 * @param options - the `cwd` relative paths resolve against, and the environment source.
 * @returns a compare-and-swap store over one file.
 */
export function fileCopilotCredentialStore(
  path?: string,
  options: CopilotAuthPathOptions = {},
): CopilotCredentialStore {
  const location = resolveCopilotAuthPath(path, options)
  return defineCredentialStore<CopilotAuthFile>({
    id: 'copilot-file-credentials',
    label: 'Copilot file credential store',
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
            'Copilot credential revision changed before commit',
            undefined,
            COPILOT_REVISION_CONFLICT_CODE,
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
  if (value.includes('\0')) throw new TypeError('Copilot credential path must not contain NUL')
  return value
}

async function readAuthFile(
  location: string,
  signal?: AbortSignal,
): Promise<{ readonly file: CopilotAuthFile; readonly raw: string } | undefined> {
  const raw = await readCredentialText(location, signal)
  if (raw === undefined) return undefined
  try {
    return Object.freeze({ file: JSON.parse(raw) as CopilotAuthFile, raw })
  } catch (error: unknown) {
    throw credentialFileError(
      'Copilot credential file is not valid JSON; delete it and log in again',
      error,
    )
  }
}

function authPayload(file: CopilotAuthFile): string {
  try {
    const encoded = JSON.stringify(file, null, 2)
    if (encoded === undefined) throw new TypeError('credential value is not JSON')
    return `${encoded}\n`
  } catch (error: unknown) {
    throw credentialFileError('Copilot credential value could not be serialized', error)
  }
}

function revisionOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function validateExpectedRevision(value: string | null): void {
  if (value !== null && (typeof value !== 'string' || value.length === 0 || value.length > 256)) {
    throw credentialFileError('Copilot expected credential revision is invalid')
  }
}
