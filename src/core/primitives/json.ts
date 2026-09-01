/**
 * Lossless-JSON values.
 *
 * Used wherever a value has to survive being logged, persisted, replayed, or sent
 * across a process boundary. Typing it explicitly rather than using `unknown`
 * makes the constraint checkable: a tool that returns a `Map`, a `Date`, or a
 * class instance cannot silently produce a log entry that fails to round-trip.
 *
 * @module ai-agent-sdk/core/primitives/json
 */

/** A value that survives `JSON.parse(JSON.stringify(x))` unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** A JSON object, when the top level must not be a primitive or array. */
export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * Whether a value round-trips through JSON unchanged.
 *
 * Rejects `undefined`, functions, symbols, and any non-plain object — including
 * `Date` and `Map`, which `JSON.stringify` accepts but corrupts (a `Date` becomes
 * a string, a `Map` becomes `{}`). Cycles are rejected rather than throwing.
 * @param value - the value to check.
 * @returns true when the value is losslessly JSON.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return check(value, new WeakSet())
}

function check(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    // NaN and Infinity serialize to `null`, so they do not round-trip.
    case 'number':
      return Number.isFinite(value)
    case 'object':
      break
    default:
      return false
  }
  const object = value as object
  if (seen.has(object)) return false
  seen.add(object)
  try {
    if (Array.isArray(object)) return object.every(entry => check(entry, seen))
    // A plain object only. `Object.create(null)` is accepted because it also
    // serializes faithfully.
    const prototype = Object.getPrototypeOf(object) as unknown
    if (prototype !== Object.prototype && prototype !== null) return false
    return Object.values(object).every(entry => check(entry, seen))
  } finally {
    seen.delete(object)
  }
}
