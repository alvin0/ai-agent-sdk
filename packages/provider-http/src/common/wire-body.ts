import { ModelError } from '@alvin0/ai-agent-sdk-core'
import { HTTP_PROVIDER_ERROR_CODES } from './config.ts'
import { snapshotJsonObject } from './json-snapshot.ts'

const WIRE_BODY_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 200_000,
  maxObjectFields: 100_000,
  maxArrayItems: 100_000,
  maxKeyBytes: 16_384,
})

/** Validate and detach one synchronous protocol JSON object before dispatch. */
export function snapshotWireBody(
  value: unknown,
  maxBytes: number,
): Readonly<Record<string, unknown>> {
  if (isThenable(value)) {
    throw new ModelError(
      'runtime wire protocol serialize() must return synchronously',
      HTTP_PROVIDER_ERROR_CODES.WIRE_BODY_INVALID,
    )
  }
  try {
    return snapshotJsonObject(value, { ...WIRE_BODY_LIMITS, maxBytes })
  } catch (error) {
    const tooLarge = error instanceof Error && /byte bound/.test(error.message)
    throw new ModelError(
      tooLarge ? 'runtime wire body exceeds maxRequestBytes' : 'runtime wire body is not bounded JSON',
      tooLarge
        ? HTTP_PROVIDER_ERROR_CODES.WIRE_BODY_TOO_LARGE
        : HTTP_PROVIDER_ERROR_CODES.WIRE_BODY_INVALID,
      { cause: error },
    )
  }
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, 'then')
  if (descriptor !== undefined && !('value' in descriptor)) return true
  return descriptor !== undefined && typeof descriptor.value === 'function'
}
