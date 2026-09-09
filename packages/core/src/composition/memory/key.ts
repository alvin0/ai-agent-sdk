import { MEMORY_LIMITS } from './config.ts'
import type { CapturedMemoryBinding } from './types.ts'

const encoder = new TextEncoder()

/** JSON tuple encoding is versioned and unambiguous even when parts contain delimiters. */
export function memoryStoreKey(
  binding: CapturedMemoryBinding,
  agentId: string,
  conversationId: string,
): string {
  if (binding.scope.kind === 'fixed') return binding.scope.key
  boundedPart(agentId)
  boundedPart(conversationId)
  return JSON.stringify(['ai-agent-sdk-memory', 1, binding.scope.namespace, agentId, conversationId])
}

function boundedPart(value: string): void {
  if (typeof value !== 'string' || value.length === 0
    || encoder.encode(value).byteLength > MEMORY_LIMITS.scopeValueBytes) {
    throw new TypeError('Memory key identity is invalid')
  }
}
