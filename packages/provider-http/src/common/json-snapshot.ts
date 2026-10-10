export interface JsonObjectSnapshotLimits {
  readonly maxObjectFields: number
  readonly maxArrayItems: number
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxKeyBytes: number
  readonly maxBytes: number
}

/** Clone bounded JSON data without invoking accessors, prototypes, or serialization hooks. */
export function snapshotJsonObject(
  value: unknown, limits: JsonObjectSnapshotLimits,
): Readonly<Record<string, unknown>> {
  return new JsonSnapshot(limits).snapshot(value)
}

class JsonSnapshot {
  private nodes = 0
  private readonly seen = new Set<object>()
  private readonly encoder = new TextEncoder()

  constructor(private readonly limits: JsonObjectSnapshotLimits) {}

  snapshot(value: unknown): Readonly<Record<string, unknown>> {
    const snapshot = this.clone(value, 0)
    if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== 'object') {
      throw new TypeError('Expected a JSON object')
    }
    if (this.encoder.encode(JSON.stringify(snapshot)).byteLength > this.limits.maxBytes) {
      throw new TypeError('JSON data exceeds its byte bound')
    }
    return snapshot as Readonly<Record<string, unknown>>
  }

  private clone(input: unknown, depth: number): unknown {
    this.nodes++
    if (this.nodes > this.limits.maxNodes || depth > this.limits.maxDepth) {
      throw new TypeError('JSON data exceeds its structural bound')
    }
    if (isJsonPrimitive(input)) return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('JSON number must be finite')
      return input
    }
    if (Array.isArray(input)) return this.cloneArray(input, depth)
    if (input === null || typeof input !== 'object') {
      throw new TypeError('JSON data contains an unsupported value')
    }
    return this.cloneRecord(input, depth)
  }

  private cloneArray(source: readonly unknown[], depth: number): readonly unknown[] {
    if (this.seen.has(source)) throw new TypeError('JSON data is cyclic')
    const length = ownValue(source, 'length')
    if (!Number.isSafeInteger(length) || Number(length) < 0 || Number(length) > this.limits.maxArrayItems) {
      throw new TypeError('JSON array exceeds its item bound')
    }
    this.seen.add(source)
    try {
      const result: unknown[] = []
      for (let index = 0; index < Number(length); index++) {
        result.push(this.clone(ownValue(source, String(index)), depth + 1))
      }
      return Object.freeze(result)
    } finally {
      this.seen.delete(source)
    }
  }

  private cloneRecord(source: object, depth: number): Readonly<Record<string, unknown>> {
    const prototype = Object.getPrototypeOf(source)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON object must be plain')
    }
    if (this.seen.has(source)) throw new TypeError('JSON data is cyclic')
    const keys = Reflect.ownKeys(source)
    if (keys.some(key => typeof key !== 'string') || keys.length > this.limits.maxObjectFields) {
      throw new TypeError('JSON object exceeds its field bound')
    }
    this.seen.add(source)
    try {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const key of keys as string[]) {
        if (this.encoder.encode(key).byteLength > this.limits.maxKeyBytes) {
          throw new TypeError('JSON object key exceeds its byte bound')
        }
        result[key] = this.clone(ownValue(source, key), depth + 1)
      }
      return Object.freeze(result)
    } finally {
      this.seen.delete(source)
    }
  }
}

function ownValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined) throw new TypeError('JSON arrays must not be sparse')
  if (!('value' in descriptor)) throw new TypeError('JSON data must not use accessors')
  return descriptor.value
}

function isJsonPrimitive(input: unknown): boolean {
  return input === null || typeof input === 'boolean' || typeof input === 'string'
}
