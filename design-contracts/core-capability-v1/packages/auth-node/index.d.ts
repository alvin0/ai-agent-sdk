import type { CredentialSource } from '@ai-agent-sdk/core/provider'

/**
 * A versioned credential source that remains callable for the current callback API.
 * The callable view is a compatibility bridge; providers consume CredentialSource.
 */
export declare function envCredential(
  variable: string,
): CredentialSource & (() => string)

/** @deprecated Use envCredential. */
export declare const apiKeyFromEnv: typeof envCredential
