/**
 * Two repairs to Next's local Edge sandbox.
 *
 * Both are for `next dev` and `next start`, which run Edge routes inside a VM
 * whose globals are not quite the platform's. A real Edge deployment — Vercel
 * Edge, Cloudflare Workers, Deno Deploy — provides both correctly, and this
 * module installs nothing there: each repair is gated on detecting the actual
 * defect, not on guessing at the environment.
 *
 * Import it before anything that touches the SDK.
 *
 * 1. `AbortSignal.any` is missing. The SDK composes every deadline and
 *    cancellation out of it.
 *
 * 2. `structuredClone` returns objects belonging to the host realm rather than
 *    the sandbox's, so `Object.getPrototypeOf(structuredClone({}))` is not the
 *    sandbox's `Object.prototype`. The SDK clones tool schemas on the way to
 *    the provider and then checks that what it is about to send is a plain
 *    object; a clone from another realm fails that check, and every run dies
 *    with `HTTP_WIRE_BODY_INVALID` before a request is sent.
 */

interface AbortSignalAny {
  any?: (signals: readonly AbortSignal[]) => AbortSignal
}

const signalTarget = AbortSignal as unknown as AbortSignalAny

if (typeof signalTarget.any !== 'function') {
  signalTarget.any = (signals: readonly AbortSignal[]): AbortSignal => {
    const controller = new AbortController()
    // An already-aborted input means the result is aborted before any listener
    // could fire, so it is checked first and the rest is never wired up.
    const settled = signals.find(signal => signal.aborted)
    if (settled !== undefined) {
      controller.abort(settled.reason)
      return controller.signal
    }
    const listeners: (() => void)[] = []
    const release = (): void => { for (const off of listeners) off() }
    for (const signal of signals) {
      const onAbort = (): void => {
        release()
        controller.abort(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      listeners.push(() => { signal.removeEventListener('abort', onAbort) })
    }
    // Dropping the listeners once the result settles keeps a long-lived source
    // signal from retaining every derived controller it ever fed.
    controller.signal.addEventListener('abort', release, { once: true })
    return controller.signal
  }
}

if (leaksRealm()) {
  // Plain assignment, not defineProperty: the sandbox's global object is a
  // Proxy that refuses redefinition but honours a write.
  globalThis.structuredClone = <T>(value: T): T => cloneValue(value, new Map<unknown, unknown>()) as T
}

/** True when the platform's clone returns objects from someone else's realm. */
function leaksRealm(): boolean {
  if (typeof globalThis.structuredClone !== 'function') return true
  try {
    return Object.getPrototypeOf(globalThis.structuredClone({})) !== Object.prototype
  } catch { return true }
}

/**
 * Clone one value into this realm.
 *
 * Covers what the structured-clone algorithm carries and this application can
 * actually produce; a function or a symbol throws, as the real algorithm does.
 * @param value - The value to clone.
 * @param seen - Values already cloned, so a cycle stays a cycle.
 * @returns The clone.
 */
function cloneValue(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new DOMException('value could not be cloned', 'DataCloneError')
    }
    return value
  }
  const existing = seen.get(value)
  if (existing !== undefined) return existing

  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof RegExp) return new RegExp(value.source, value.flags)
  if (value instanceof ArrayBuffer) return value.slice(0)
  if (ArrayBuffer.isView(value)) {
    const view = value as unknown as {
      readonly buffer: { slice: (start: number) => ArrayBufferLike }
      readonly constructor: new (buffer: ArrayBufferLike) => unknown
    }
    return new view.constructor(view.buffer.slice(0))
  }

  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(cloneValue(item, seen))
    return out
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>()
    seen.set(value, out)
    for (const [key, item] of value) out.set(cloneValue(key, seen), cloneValue(item, seen))
    return out
  }
  if (value instanceof Set) {
    const out = new Set<unknown>()
    seen.set(value, out)
    for (const item of value) out.add(cloneValue(item, seen))
    return out
  }

  // Everything else is treated as a record of its own enumerable string keys,
  // which is what the algorithm does for a plain object.
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cloneValue(item, seen)
  }
  return out
}

export {}
