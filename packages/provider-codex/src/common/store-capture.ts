import {
  AgentSdkError,
  CREDENTIAL_CAPABILITY_API_VERSION,
  type CredentialCommitInput,
  type CredentialCommitResult,
  type CredentialOperationOptions,
  type CredentialRecord,
} from '@alvin0/ai-agent-sdk-core/provider'
import type {
  CodexAuthFile,
  CodexAuthStore,
  CodexCredentialStore,
} from './store-types.ts'

export type CapturedCodexStore =
  | { readonly kind: 'legacy'; readonly label: string; readonly store: CodexAuthStore }
  | { readonly kind: 'versioned'; readonly label: string; readonly store: CodexCredentialStore }

/** Capture store identity and methods without invoking accessors or doing storage I/O. */
export function captureCodexStore(value: unknown): CapturedCodexStore {
  try {
    if (value === null || typeof value !== 'object') throw new TypeError('store must be an object')
    const marker = dataValue(value, 'kind', false)
    if (marker === undefined) return captureLegacy(value)
    if (marker !== 'credential-store'
      || dataValue(value, 'apiVersion') !== CREDENTIAL_CAPABILITY_API_VERSION) {
      throw new TypeError('unsupported credential-store marker')
    }
    const id = boundedString(dataValue(value, 'id'), 128, 'credential store id')
    const label = boundedString(dataValue(value, 'label'), 256, 'credential store label')
    const read = capturedMethod<
      [CredentialOperationOptions], Promise<CredentialRecord<CodexAuthFile> | undefined>
    >(value, 'read')
    const commit = capturedMethod<
      [CredentialCommitInput<CodexAuthFile>, CredentialOperationOptions], Promise<CredentialCommitResult>
    >(value, 'commit')
    return Object.freeze({
      kind: 'versioned',
      label,
      store: Object.freeze({
        kind: 'credential-store',
        apiVersion: CREDENTIAL_CAPABILITY_API_VERSION,
        id,
        label,
        read,
        commit,
      }),
    })
  } catch (error) {
    throw new AgentSdkError('Codex authStore credential store is invalid', 'CREDENTIAL_STORE_INVALID', { cause: error })
  }
}

function captureLegacy(source: object): CapturedCodexStore {
  const location = boundedString(dataValue(source, 'location'), 1_024, 'Codex auth store location')
  const read = capturedMethod<[], Promise<CodexAuthFile | undefined>>(source, 'read')
  const write = capturedMethod<[CodexAuthFile], Promise<void>>(source, 'write')
  return Object.freeze({
    kind: 'legacy',
    label: location,
    store: Object.freeze({ location, read, write }),
  })
}

function capturedMethod<Args extends readonly unknown[], Result>(
  source: object,
  key: PropertyKey,
): (...args: Args) => Result {
  const method = dataValue(source, key)
  if (typeof method !== 'function') throw new TypeError(`${String(key)} must be a function`)
  return (...args: Args) => Reflect.apply(method, source, args) as Result
}

function dataValue(source: object, key: PropertyKey, required = true): unknown {
  let owner: object | null = source
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError(`${String(key)} must not be an accessor`)
      return descriptor.value
    }
    owner = Object.getPrototypeOf(owner)
  }
  if (!required) return undefined
  throw new TypeError(`missing ${String(key)}`)
}

function boundedString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} must be a bounded non-empty string`)
  }
  return value
}
