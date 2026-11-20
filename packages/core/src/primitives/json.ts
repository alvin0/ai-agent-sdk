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
  try { return check(value, new WeakSet()) } catch { return false }
}

function check(value: unknown, seen: WeakSet<object>): boolean {
  const pending: { value: unknown; leaving?: true }[] = [{ value }]
  while (pending.length > 0) {
    const task = pending.pop()!
    if (task.leaving) { seen.delete(task.value as object); continue }
    const current = task.value
    if (isJsonPrimitive(current)) continue
    if (typeof current !== 'object' || current === null || seen.has(current)) return false
    const children = jsonChildren(current)
    if (children === undefined) return false
    seen.add(current)
    pending.push({ value: current, leaving: true })
    for (let index = children.length - 1; index >= 0; index--) pending.push({ value: children[index] })
  }
  return true
}

function isJsonPrimitive(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

function jsonChildren(value: object): unknown[] | undefined {
  if (Array.isArray(value)) return arrayChildren(value)
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const children: unknown[] = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || descriptor.enumerable !== true || !('value' in descriptor)) return undefined
    children.push(descriptor.value)
  }
  return children
}

function arrayChildren(value: readonly unknown[]): unknown[] | undefined {
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(value).length !== length + 1) return undefined
  const children: unknown[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !('value' in descriptor)) return undefined
    children.push(descriptor.value)
  }
  return children
}
