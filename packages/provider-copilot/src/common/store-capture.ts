/**
 * Store capture: decide which credential store variant the caller passed, and
 * take a snapshot of its identity and methods.
 *
 * The counterpart of `captureCodexStore`, and it holds the same two lines:
 *
 * - **No accessors.** Every property is read through
 *   `Object.getOwnPropertyDescriptor`, and a descriptor without a `value` is
 *   REJECTED rather than invoked. Telling the two variants apart must not run a
 *   line of the caller's code, because a getter here would run during provider
 *   construction, in an order the caller cannot see.
 * - **No I/O.** Methods are captured, not called. Nothing touches storage at
 *   construction time; the first read happens when an operation asks for a
 *   credential.
 *
 * Methods are invoked through `Reflect.apply` with the original object as the
 * receiver, so a store written against `this` keeps working after capture.
 *
 * @module ai-agent-sdk/providers/copilot/store-capture
 */

import {
  AgentSdkError,
  CREDENTIAL_CAPABILITY_API_VERSION,
  type CredentialCommitInput,
  type CredentialCommitResult,
  type CredentialOperationOptions,
  type CredentialRecord,
} from '@alvin0/ai-agent-sdk-core/provider'
import type {
  CopilotAuthFile,
  CopilotAuthStore,
  CopilotCredentialStore,
} from './store-types.ts'

/** A captured store, tagged with the variant it came from. */
export type CapturedCopilotStore =
  | { readonly kind: 'legacy'; readonly label: string; readonly store: CopilotAuthStore }
  | { readonly kind: 'versioned'; readonly label: string; readonly store: CopilotCredentialStore }

/** Capture store identity and methods without invoking accessors or doing storage I/O. */
export function captureCopilotStore(value: unknown): CapturedCopilotStore {
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
      [CredentialOperationOptions], Promise<CredentialRecord<CopilotAuthFile> | undefined>
    >(value, 'read')
    const commit = capturedMethod<
      [CredentialCommitInput<CopilotAuthFile>, CredentialOperationOptions], Promise<CredentialCommitResult>
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
    throw new AgentSdkError(
      'Copilot authStore credential store is invalid',
      'CREDENTIAL_STORE_INVALID',
      { cause: error },
    )
  }
}

function captureLegacy(source: object): CapturedCopilotStore {
  const location = boundedString(dataValue(source, 'location'), 1_024, 'Copilot auth store location')
  const read = capturedMethod<[], Promise<CopilotAuthFile | undefined>>(source, 'read')
  const write = capturedMethod<[CopilotAuthFile], Promise<void>>(source, 'write')
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

/**
 * Read an own-or-inherited DATA property. An accessor anywhere on the prototype
 * chain is an error: reading it would run caller code during construction.
 */
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
