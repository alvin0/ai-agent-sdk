import { AgentSdkError } from './agent-sdk-error.ts'

export interface CapabilityIdentityConflict {
  readonly namespace: 'provider-plugin-id' | 'provider-route' | 'observation-exporter-id'
    | 'tool-source-id' | 'tool-name' | 'skill-provider-id' | 'skill-id' | 'team-member-name'
  readonly key: string
  readonly firstIndex: number
  readonly secondIndex: number
}

export const REDACTED_IDENTITY_KEY = '[redacted]'

export type CapabilityIdentityError = AgentSdkError & {
  readonly conflict: CapabilityIdentityConflict
}

const conflicts = new WeakMap<object, CapabilityIdentityConflict>()

export function capabilityIdentityConflict(
  namespace: CapabilityIdentityConflict['namespace'],
  firstIndex: number,
  secondIndex: number,
): CapabilityIdentityConflict {
  return Object.freeze({ namespace, key: REDACTED_IDENTITY_KEY, firstIndex, secondIndex })
}

export function capabilityIdentityError(
  code: string,
  namespace: CapabilityIdentityConflict['namespace'],
  firstIndex: number,
  secondIndex: number,
): CapabilityIdentityError {
  const error = new AgentSdkError('Capability identity conflicts in this scope', code) as CapabilityIdentityError
  return attachCapabilityIdentityConflict(error, capabilityIdentityConflict(namespace, firstIndex, secondIndex))
}

export function assertCapabilityIdentityNamespace(
  code: string,
  namespace: CapabilityIdentityConflict['namespace'],
  identities: readonly string[],
): void {
  const seen = new Map<string, number>()
  for (const [index, identity] of identities.entries()) {
    const first = seen.get(identity)
    if (first !== undefined) throw capabilityIdentityError(code, namespace, first, index)
    seen.set(identity, index)
  }
}

export function inheritCapabilityIdentityConflict<T extends Error>(target: T, source: unknown): T {
  if ((typeof source !== 'object' && typeof source !== 'function') || source === null) return target
  const conflict = conflicts.get(source)
  return conflict === undefined ? target : attachCapabilityIdentityConflict(target, conflict)
}

export function isCapabilityIdentityError(value: unknown): value is CapabilityIdentityError {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null && conflicts.has(value)
}

function attachCapabilityIdentityConflict<T extends Error>(
  error: T,
  conflict: CapabilityIdentityConflict,
): T {
  Object.defineProperty(error, 'conflict', {
    value: conflict, enumerable: true, configurable: false, writable: false,
  })
  conflicts.set(error, conflict)
  return error
}
