import { deepFreeze } from './freeze.ts'
import type { JsonObject, JsonValue } from './json.ts'

export interface JsonSnapshotLimits {
  readonly maxObjectFields: number
  readonly maxArrayItems: number
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxKeyBytes: number
  readonly maxBytes: number
}

/** Clone bounded lossless JSON without invoking accessors or serialization hooks. */
export function snapshotJsonObject(value: unknown, limits: JsonSnapshotLimits): Readonly<JsonObject> {
  const snapshot = snapshotJsonValue(value, limits)
  if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== 'object') {
    throw new TypeError('Expected a JSON object')
  }
  return snapshot as Readonly<JsonObject>
}

/** Clone any bounded lossless JSON value, including primitive and array locators. */
export function snapshotJsonValue(value: unknown, limits: JsonSnapshotLimits): JsonValue {
  let nodes = 0
  const seen = new Set<object>()
  const encoder = new TextEncoder()

  const clone = (input: unknown, depth: number): JsonValue => {
    nodes++
    if (nodes > limits.maxNodes || depth > limits.maxDepth) throw new TypeError('JSON data exceeds its bound')
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('JSON number must be finite')
      return input
    }
    if (Array.isArray(input)) return cloneArray(input, depth)
    if (typeof input !== 'object' || input === null) throw new TypeError('JSON data contains an unsupported value')
    return cloneObject(input, depth)
  }

  const cloneArray = (source: readonly unknown[], depth: number): readonly JsonValue[] => {
    if (seen.has(source)) throw new TypeError('JSON data is cyclic')
    const length = ownData(source, 'length')
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > limits.maxArrayItems) {
      throw new TypeError('JSON array exceeds its bound')
    }
    seen.add(source)
    try {
      const result: JsonValue[] = []
      for (let index = 0; index < Number(length); index++) result.push(clone(ownData(source, String(index)), depth + 1))
      return Object.freeze(result)
    } finally { seen.delete(source) }
  }

  const cloneObject = (source: object, depth: number): Readonly<JsonObject> => {
    const prototype: unknown = Object.getPrototypeOf(source)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('JSON object must be plain')
    if (seen.has(source)) throw new TypeError('JSON data is cyclic')
    const keys = Reflect.ownKeys(source)
    if (keys.some(key => typeof key !== 'string') || keys.length > limits.maxObjectFields) {
      throw new TypeError('JSON object fields exceed their bound')
    }
    seen.add(source)
    try {
      const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
      for (const key of keys as string[]) {
        if (encoder.encode(key).byteLength > limits.maxKeyBytes) throw new TypeError('JSON object key exceeds its bound')
        result[key] = clone(ownData(source, key), depth + 1)
      }
      return Object.freeze(result)
    } finally { seen.delete(source) }
  }

  const snapshot = clone(value, 0)
  if (encoder.encode(JSON.stringify(snapshot)).byteLength > limits.maxBytes) {
    throw new TypeError('JSON data exceeds its byte bound')
  }
  return deepFreeze(snapshot)
}

function ownData(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined) throw new TypeError('JSON arrays must not be sparse')
  if (!('value' in descriptor)) throw new TypeError('JSON data must not use accessors')
  return descriptor.value
}
