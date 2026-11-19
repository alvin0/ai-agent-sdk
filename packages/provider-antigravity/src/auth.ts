import {
  AgentSdkError, defineCredentialStore, type CredentialOperationOptions,
} from '@alvin0/ai-agent-sdk-core/provider'
import { credentialLoginId, withCredentialRefresh } from '@alvin0/ai-agent-sdk-provider-http'
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

async function resolveRefresh(store: AntigravityCredentialStore, options: AntigravityOAuthOptions,
  operation: CredentialOperationOptions, snapshot: { value: AntigravityAuthFile; revision: string; loginId: string },
): Promise<AntigravityAuthFile> {
  const { value: current, revision, loginId } = snapshot
  const latest = await abortable(store.read(operation), operation.signal)
  if (latest?.revision !== revision) return refreshWinner(current, loginId, latest?.value, options)
  try {
    const tokens = await exchangeAntigravityToken({ grant_type: 'refresh_token',
      refresh_token: current.tokens.refresh_token },
    { ...options, clientId: current.clientId, signal: operation.signal })
    const updated = { ...current, loginId, tokens }
    await abortable(store.commit({ expectedRevision: revision, value: updated }, operation), operation.signal)
    return updated
  } catch (error) {
    operation.signal.throwIfAborted()
    const winner = await abortable(store.read(operation), operation.signal)
    if (winner?.revision === revision) throw error
    return refreshWinner(current, loginId, winner?.value, options)
  }
}

function refreshWinner(current: AntigravityAuthFile, loginId: string, value: AntigravityAuthFile | undefined,
  options: AntigravityOAuthOptions): AntigravityAuthFile {
  if (value !== undefined) {
    const winner = validateAntigravityAuthFile(value)
    assertClient(winner, options)
    if (winner.loginId === loginId && winner.obtainedAt === current.obtainedAt
      && winner.clientId === current.clientId && winner.projectId === current.projectId
      && winner.account?.email === current.account?.email
      && winner.tokens.expires_at > Date.now() + 60_000) return winner
  }
  throw new AgentSdkError('Antigravity credentials changed during refresh', 'ANTIGRAVITY_AUTH_INVALID')
}

export function createAntigravityCredentialResolver(
  store: AntigravityCredentialStore, options: AntigravityOAuthOptions,
) {
  return async (operation: CredentialOperationOptions): Promise<AntigravityAuthFile> => {
    const signal = options.signal ? AbortSignal.any([operation.signal, options.signal]) : operation.signal
    operation = { ...operation, signal }
    signal.throwIfAborted()
    const snapshot = await abortable(store.read(operation), signal)
    if (!snapshot) throw new AgentSdkError(
      'No Antigravity credentials; run ai-agent-sdk-antigravity-login to sign in', 'MISSING_CREDENTIAL')
    const current = validateAntigravityAuthFile(snapshot.value)
    assertClient(current, options)
    if (current.tokens.expires_at > Date.now() + 60_000) return current
    const loginId = await credentialLoginId(current.loginId, current.tokens.refresh_token)
    return withCredentialRefresh(`antigravity:${loginId}`, signal, () =>
      resolveRefresh(store, options, operation, { ...snapshot, value: current, loginId }))
  }
}
