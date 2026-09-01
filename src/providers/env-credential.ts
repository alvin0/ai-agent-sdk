import { AgentSdkError, MISSING_CREDENTIAL_CODE } from '@ai-agent-sdk/core'

/**
 * Read a credential from Node's environment.
 * @deprecated Compatibility bridge; migrate to `envCredential` from `@ai-agent-sdk/auth-node`.
 */
export function apiKeyFromEnv(envVar: string): () => string {
  return () => {
    const value = process.env[envVar]
    if (value === undefined || value.length === 0) {
      throw new AgentSdkError(`no credential available; set ${envVar}`, MISSING_CREDENTIAL_CODE)
    }
    return value
  }
}
