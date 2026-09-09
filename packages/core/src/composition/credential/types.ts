import type { SdkLogger } from '../../logging/types.ts'
import type { CREDENTIAL_CAPABILITY_API_VERSION } from './config.ts'

export interface CredentialOperationOptions {
  readonly signal: AbortSignal
  readonly logger: SdkLogger
}

export interface CredentialSource {
  readonly kind: 'credential-source'
  readonly apiVersion: typeof CREDENTIAL_CAPABILITY_API_VERSION
  readonly id: string
  readonly resolve: (options: CredentialOperationOptions) => string | Promise<string>
}

export type CredentialInput = string | CredentialSource

export interface CredentialRecord<Value> {
  readonly value: Value
  readonly revision: string
}

export interface CredentialCommitInput<Value> {
  readonly value: Value
  readonly expectedRevision: string | null
}

export interface CredentialCommitResult { readonly revision: string }

export interface CredentialStore<Value> {
  readonly kind: 'credential-store'
  readonly apiVersion: typeof CREDENTIAL_CAPABILITY_API_VERSION
  readonly id: string
  readonly label: string
  readonly read: (options: CredentialOperationOptions) => Promise<CredentialRecord<Value> | undefined>
  readonly commit: (
    input: CredentialCommitInput<Value>,
    options: CredentialOperationOptions,
  ) => Promise<CredentialCommitResult>
}

export type CredentialStoreDefinition<Value> = Omit<CredentialStore<Value>, 'kind' | 'apiVersion'>
export type CredentialSourceDefinition = Omit<CredentialSource, 'kind' | 'apiVersion'>
