/** Detach and recursively freeze a value before crossing an observer boundary. */

import { deepFreeze } from './freeze.ts'

/**
 * Plain-data snapshots this module produced. Each is detached from live state and
 * deeply frozen, so handing it out again — or embedding it in a new snapshot — is
 * indistinguishable from copying it, minus the copy. Structured-clone results are
 * never listed: freezing does not make a Date, Map or Set immutable, so each call
 * must still hand out its own copy of those.
 */
const detached = new WeakSet<object>()

/** Beyond this nesting depth the structured-clone path takes over. */
const MAX_PLAIN_DEPTH = 64

/** Sentinel: the value is not plain data, so the structured-clone path decides. */
const NOT_PLAIN: unique symbol = Symbol('not-plain')

/**
 * Prevent observers from mutating live runtime state through an event payload.
 * Values crossing this boundary are required to be structured-cloneable.
 *
 * Runs once per streamed event, so plain data — objects with `Object.prototype`
 * or `null` prototypes, dense arrays and primitives, which is what events are —
 * is copied and frozen in one pass with `structuredClone` semantics (own
 * enumerable string keys, shared references and cycles preserved). Anything else
 * (Date, Map, typed arrays, class instances, functions, …) goes through
 * `structuredClone`, unchanged, and is copied on every call. A value that is
 * already one of this function's plain-data snapshots is returned as is rather
 * than copied again.
 */
export function detachedFrozen<T>(value: T): T {
  if (typeof value !== 'object' || value === null) {
    // Primitives are their own snapshot; functions and symbols must still throw.
    return typeof value === 'function' || typeof value === 'symbol' ? structuredClone(value) : value
  }
  if (detached.has(value)) return value
  const plain = plainSnapshot(value, new Map(), 0)
  if (plain !== NOT_PLAIN) return plain as T
  return deepFreeze(structuredClone(value))
}

function plainSnapshot(value: unknown, copies: Map<object, object>, depth: number): unknown {
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'function' || typeof value === 'symbol' ? NOT_PLAIN : value
  }
  if (detached.has(value)) return value
  const existing = copies.get(value)
  if (existing !== undefined) return existing
  if (depth >= MAX_PLAIN_DEPTH) return NOT_PLAIN
  return Array.isArray(value)
    ? arraySnapshot(value, copies, depth)
    : objectSnapshot(value, copies, depth)
}

function arraySnapshot(value: unknown[], copies: Map<object, object>, depth: number): unknown {
  // Holes and extra named properties have structured-clone details of their own.
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) return NOT_PLAIN
  const copy: unknown[] = new Array<unknown>(value.length)
  copies.set(value, copy)
  for (let index = 0; index < value.length; index++) {
    const item = plainSnapshot(value[index], copies, depth + 1)
    if (item === NOT_PLAIN) return NOT_PLAIN
    copy[index] = item
  }
  return seal(copy)
}

function objectSnapshot(value: object, copies: Map<object, object>, depth: number): unknown {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return NOT_PLAIN
  const copy: Record<string, unknown> = {}
  copies.set(value, copy)
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    const item = plainSnapshot(source[key], copies, depth + 1)
    if (item === NOT_PLAIN) return NOT_PLAIN
    // An own `__proto__` key (JSON.parse makes one) must stay a data property, as
    // structuredClone keeps it; plain assignment would run the prototype setter.
    if (key === '__proto__') {
      Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true })
    } else {
      copy[key] = item
    }
  }
  return seal(copy)
}

function seal<T extends object>(copy: T): T {
  Object.freeze(copy)
  detached.add(copy)
  return copy
}
