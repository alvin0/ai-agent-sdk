/** Detach and recursively freeze a value before crossing an observer boundary. */

import { deepFreeze } from './freeze.ts'

/**
 * Prevent observers from mutating live runtime state through an event payload.
 * Values crossing this boundary are required to be structured-cloneable.
 */
export function detachedFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}
