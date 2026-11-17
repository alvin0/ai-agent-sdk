import {
  AgentSdkError, defineCredentialStore, type CredentialOperationOptions,
} from '@alvin0/ai-agent-sdk-core/provider'
import { abortable, object, requiredString } from './http.ts'
import { exchangeAntigravityToken } from './oauth.ts'
import type { AntigravityAuthFile, AntigravityCredentialStore, AntigravityOAuthOptions } from './types.ts'

export function validateAntigravityAuthFile(value: unknown): AntigravityAuthFile {
  const file = object(value)
  const tokens = object(file.tokens)
  if (file.version !== 1 || typeof tokens.expires_at !== 'number' || !Number.isFinite(tokens.expires_at)) {
    throw new AgentSdkError('Antigravity credentials are invalid; sign in again', 'ANTIGRAVITY_AUTH_INVALID')
  }
  requiredString(tokens.access_token, 'stored access token')
  requiredString(tokens.refresh_token, 'stored refresh token')
  requiredString(file.projectId, 'stored project')
  requiredString(file.clientId, 'stored OAuth client')
  requiredString(file.obtainedAt, 'stored login time')
  return structuredClone(file) as unknown as AntigravityAuthFile
}

export function memoryAntigravityCredentialStore(initial?: AntigravityAuthFile): AntigravityCredentialStore {
  let value = initial === undefined ? undefined : validateAntigravityAuthFile(initial)
  let revision = 0
  return defineCredentialStore({ id: 'antigravity-memory-credentials', label: '<memory>',
    async read({ signal }) {
      signal.throwIfAborted()
      return value === undefined ? undefined : { value: structuredClone(value), revision: String(revision) }
    },
    async commit(input, { signal }) {
      signal.throwIfAborted()
      if (input.expectedRevision !== (value === undefined ? null : String(revision))) {
        throw new AgentSdkError('Antigravity credential revision changed before commit',
          'ANTIGRAVITY_CREDENTIAL_REVISION_CONFLICT')
      }
      value = validateAntigravityAuthFile(input.value)
      return { revision: String(++revision) }
    },
  })
}

function assertClient(file: AntigravityAuthFile, options: AntigravityOAuthOptions): void {
  if (options.clientId !== undefined && options.clientId !== file.clientId) {
    throw new AgentSdkError('Antigravity OAuth client changed; sign in again', 'ANTIGRAVITY_AUTH_INVALID')
  }
}

/** Serialize refreshes on this adapter. No cached token can outlive a changed store revision. */
export function createAntigravityCredentialResolver(
  store: AntigravityCredentialStore, options: AntigravityOAuthOptions,
) {
  let tail: Promise<unknown> = Promise.resolve()
  return (operation: CredentialOperationOptions): Promise<AntigravityAuthFile> => {
    const pending = tail.catch(() => undefined).then(async () => {
      operation.signal.throwIfAborted()
      const snapshot = await abortable(store.read(operation), operation.signal)
      if (snapshot === undefined) throw new AgentSdkError(
        'No Antigravity credentials; run ai-agent-sdk-antigravity-login to sign in', 'MISSING_CREDENTIAL')
      const current = validateAntigravityAuthFile(snapshot.value)
      assertClient(current, options)
      if (current.tokens.expires_at > Date.now() + 60_000) return current
      const tokens = await exchangeAntigravityToken({ grant_type: 'refresh_token',
        refresh_token: current.tokens.refresh_token }, {
        ...options, clientId: current.clientId, signal: operation.signal,
      })
      const updated = { ...current, tokens }
      try { await abortable(store.commit({ expectedRevision: snapshot.revision, value: updated }, operation),
        operation.signal) }
      catch (error) {
        if (!(error instanceof AgentSdkError) || error.code !== 'ANTIGRAVITY_CREDENTIAL_REVISION_CONFLICT') throw error
        // A login or another process won the race. Use only the winner's current credential.
        const winner = await abortable(store.read(operation), operation.signal)
        if (winner === undefined) throw error
        const file = validateAntigravityAuthFile(winner.value)
        assertClient(file, options)
        if (file.tokens.expires_at <= Date.now() + 60_000) throw error
        return file
      }
      return updated
    })
    tail = pending
    return pending
  }
}
