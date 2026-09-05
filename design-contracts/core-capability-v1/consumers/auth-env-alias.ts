import { envCredential as rootEnvCredential } from '@ai-agent-sdk/auth-node'
import { envCredential as subpathEnvCredential } from '@ai-agent-sdk/auth-node/env'
import type { CredentialSource } from '@ai-agent-sdk/core/provider'

/** Both supported routes project the same canonical env credential factory. */
export const supportedEnvCredentialRoutes = {
  root: rootEnvCredential,
  env: subpathEnvCredential,
}

export type EnvCredentialResult = CredentialSource
