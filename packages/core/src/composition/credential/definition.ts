import { COMPOSITION_LIMITS } from '../common/config.ts'
import { boundedText, capturedMethod, objectValue, ownData } from '../common/data.ts'
import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { CREDENTIAL_CAPABILITY_API_VERSION, CREDENTIAL_CAPABILITY_ERROR_CODES } from './config.ts'
import { runCoreCapabilityAsync, runCoreCapabilityMaybeAsync } from '../logging/capability.ts'
import type {
  CredentialCommitInput, CredentialCommitResult, CredentialOperationOptions,
  CredentialRecord, CredentialSource, CredentialSourceDefinition, CredentialStore,
  CredentialStoreDefinition,
} from './types.ts'

/** Side-effect-free author helper; executable references retain the caller receiver. */
export function defineCredentialSource(definition: CredentialSourceDefinition): CredentialSource {
  try {
    const source = objectValue(definition)
    const id = boundedText(ownData(source, 'id'), COMPOSITION_LIMITS.identityBytes)
    const capturedResolve = capturedMethod<[CredentialOperationOptions], string | Promise<string>>(source, 'resolve')
    const resolve = (options: CredentialOperationOptions): string | Promise<string> =>
      runCoreCapabilityMaybeAsync(options.logger, 'core-credential', 'resolve', options.signal,
        () => capturedResolve(options))
    return Object.freeze({ kind: 'credential-source', apiVersion: CREDENTIAL_CAPABILITY_API_VERSION, id, resolve })
  } catch {
    throw new AgentSdkError('Credential source definition is invalid', CREDENTIAL_CAPABILITY_ERROR_CODES.SOURCE_INVALID)
  }
}

/** Side-effect-free author helper; it neither reads credentials nor mutates the caller store. */
export function defineCredentialStore<Value>(definition: CredentialStoreDefinition<Value>): CredentialStore<Value> {
  try {
    const source = objectValue(definition)
    const id = boundedText(ownData(source, 'id'), COMPOSITION_LIMITS.identityBytes)
    const label = boundedText(ownData(source, 'label'), COMPOSITION_LIMITS.displayNameBytes)
    const capturedRead = capturedMethod<[CredentialOperationOptions], Promise<CredentialRecord<Value> | undefined>>(source, 'read')
    const capturedCommit = capturedMethod<
      [CredentialCommitInput<Value>, CredentialOperationOptions], Promise<CredentialCommitResult>
    >(source, 'commit')
    const read = (options: CredentialOperationOptions) =>
      runCoreCapabilityAsync(options.logger, 'core-credential', 'read', options.signal,
        () => capturedRead(options))
    const commit = (input: CredentialCommitInput<Value>, options: CredentialOperationOptions) =>
      runCoreCapabilityAsync(options.logger, 'core-credential', 'commit', options.signal,
        () => capturedCommit(input, options))
    return Object.freeze({ kind: 'credential-store', apiVersion: CREDENTIAL_CAPABILITY_API_VERSION,
      id, label, read, commit })
  } catch {
    throw new AgentSdkError('Credential store definition is invalid', CREDENTIAL_CAPABILITY_ERROR_CODES.STORE_INVALID)
  }
}
