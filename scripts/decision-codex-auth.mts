import { MISSING_CREDENTIAL_CODE } from '@alvin0/ai-agent-sdk-core'
import { defineCredentialSource, type CredentialSource } from '@alvin0/ai-agent-sdk-core/provider'
import {
  fileCodexCredentialStore, getCodexTokens, type CodexCredentialStore,
} from '@alvin0/ai-agent-sdk-auth-node/codex'

export async function findDecisionCodexAuth(): Promise<{
  readonly authStore: CodexCredentialStore
  readonly credential: CredentialSource
} | undefined> {
  const authStore = fileCodexCredentialStore()
  try {
    await getCodexTokens(authStore, { refreshIfNeeded: false })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === MISSING_CREDENTIAL_CODE) {
      return undefined
    }
    throw error
  }
  const credential = defineCredentialSource({
    id: 'codex-decisions',
    async resolve({ signal }) {
      return (await getCodexTokens(authStore, { signal, requireVersionedRefresh: true })).access_token
    },
  })
  return { authStore, credential }
}
