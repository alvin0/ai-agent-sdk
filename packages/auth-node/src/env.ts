import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@ai-agent-sdk/core'

/** Read a credential lazily from Node's environment. */
export function envCredential(envVar: string): () => string {
  if (envVar.trim().length === 0) throw new TypeError('credential environment variable must not be empty')
  return () => {
    const value = process.env[envVar]
    if (value === undefined || value.length === 0) {
      throw new AgentSdkError(`no credential available; set ${envVar}`, MISSING_CREDENTIAL_CODE)
    }
    return value
  }
}

/** @deprecated Use {@link envCredential}. */
export const apiKeyFromEnv = envCredential
