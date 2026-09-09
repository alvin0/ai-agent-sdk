const ENCODER = new TextEncoder()

/** Read an own data property without evaluating accessors or inherited state. */
export function ownData(
  source: object,
  key: PropertyKey,
  required = true,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  if (descriptor === undefined) {
    if (!required) return undefined
    throw new TypeError(`Missing ${String(key)}`)
  }
  if (!('value' in descriptor)) throw new TypeError(`${String(key)} must not be an accessor`)
  return descriptor.value
}

/** Require a plain configuration object. */
export function plainObject(value: unknown, label: string): Record<PropertyKey, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value as Record<PropertyKey, unknown>
}

/** Capture a method once while retaining its original receiver. */
export function capturedMethod<Args extends readonly unknown[], Result>(
  source: object,
  key: PropertyKey,
): (...args: Args) => Result {
  const value = ownData(source, key)
  if (typeof value !== 'function') throw new TypeError(`${String(key)} must be a function`)
  return (...args: Args) => Reflect.apply(value, source, args) as Result
}

/** Capture an optional method once while retaining its original receiver. */
export function optionalCapturedMethod<Args extends readonly unknown[], Result>(
  source: object,
  key: PropertyKey,
): ((...args: Args) => Result) | undefined {
  const value = ownData(source, key, false)
  if (value === undefined) return undefined
  if (typeof value !== 'function') throw new TypeError(`${String(key)} must be a function`)
  return (...args: Args) => Reflect.apply(value, source, args) as Result
}

/** Validate one bounded non-empty UTF-8 identifier. */
export function boundedIdentifier(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value
    || ENCODER.encode(value).byteLength > maxBytes) {
    throw new TypeError(`${label} must be a bounded non-empty string`)
  }
  return value
}
