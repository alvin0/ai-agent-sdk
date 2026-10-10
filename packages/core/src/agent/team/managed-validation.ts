import type { ManagedAgentSpawnContext } from './managed-types.ts'

export function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of strings`)
  return value.map(entry => nonEmpty(entry, `${label} entry`))
}

export function spawnContext(value: unknown): ManagedAgentSpawnContext {
  if (value !== 'fresh' && value !== 'fork') {
    throw new TypeError("worker context must be 'fresh' or 'fork'")
  }
  return value
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function memberName(value: unknown): string {
  const name = nonEmpty(value, 'managed agent name')
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new TypeError('managed agent name must start with a letter and contain only letters, digits, _ or -')
  }
  if (name.length > 128) throw new TypeError('managed agent name must not exceed 128 characters')
  return name
}

export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

export function boundedString(value: unknown, label: string, maxBytes: number): string {
  const text = nonEmpty(value, label)
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new TypeError(`${label} exceeds the ${maxBytes}-byte limit`)
  }
  return text
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

export function assertDependencyOffset(text: string, offset: number): void {
  if (offset > text.length || (offset > 0
    && /[\uDC00-\uDFFF]/.test(text[offset]!))) throw new RangeError('offset must be a valid character boundary')
}
