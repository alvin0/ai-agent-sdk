import { AgentSdkError } from '../../errors/agent-sdk-error.ts'
import { MEMORY_ERROR_CODES } from './config.ts'
import { MEMORY_LIMITS } from './config.ts'
import type { CapturedMemoryBinding } from './types.ts'

export function validateMemoryResumeBinding(
  snapshot: { readonly memoryBindingId?: unknown },
  binding: CapturedMemoryBinding | undefined,
): void {
  const persisted = Object.getOwnPropertyDescriptor(snapshot, 'memoryBindingId')
  if (persisted !== undefined && !('value' in persisted)) throw mismatch()
  const id = persistedId(persisted)
  if (id === undefined) {
    if (binding !== undefined) throw mismatch()
    return
  }
  if (!validBindingId(id)) throw mismatch()
  if (binding === undefined) {
    throw new AgentSdkError('The persisted memory binding must be supplied to resume this session',
      MEMORY_ERROR_CODES.BINDING_REQUIRED)
  }
  if (id !== binding.bindingId) throw mismatch()
}

function persistedId(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
}

function validBindingId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && new TextEncoder().encode(value).byteLength <= MEMORY_LIMITS.identityBytes
}

function mismatch(): AgentSdkError {
  return new AgentSdkError('The supplied memory binding does not match the persisted session',
    MEMORY_ERROR_CODES.BINDING_MISMATCH)
}
