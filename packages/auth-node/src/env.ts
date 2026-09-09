import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@alvin0/ai-agent-sdk-core'
import {
  defineCredentialSource,
  type CredentialSource,
} from '@alvin0/ai-agent-sdk-core/provider'

/** Read a credential lazily while preserving the historical callable view. */
export function envCredential(envVar: string): CredentialSource & (() => string) {
  if (envVar.trim().length === 0) throw new TypeError('credential environment variable must not be empty')
  const read = () => {
    const value = process.env[envVar]
    if (value === undefined || value.length === 0) {
      throw new AgentSdkError(`no credential available; set ${envVar}`, MISSING_CREDENTIAL_CODE)
    }
    return value
  }
  const source = defineCredentialSource({
    id: `env:${envVar}`,
    resolve: ({ signal }) => {
      signal.throwIfAborted()
      return read()
    },
  })
  return Object.freeze(Object.assign(read, {
    kind: source.kind,
    apiVersion: source.apiVersion,
    id: source.id,
    resolve: source.resolve,
  }))
}

/** @deprecated Use {@link envCredential}. */
export const apiKeyFromEnv = envCredential
