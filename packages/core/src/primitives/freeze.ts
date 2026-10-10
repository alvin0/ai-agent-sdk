/**
 * In-place deep freeze used to publish immutable messages and configs.
 *
 * @module ai-agent-sdk/core/primitives/freeze
 */

/**
 * Deep-freeze a value in place with an ITERATIVE traversal, guarding cycles.
 *
 * Iterative rather than recursive so that a deeply nested message (a long tool
 * result chain, say) cannot blow the JavaScript call stack. {@link AbortSignal}
 * is skipped deliberately: it is the request's live cancellation channel and
 * freezing it breaks abort.
 * @param value - the value to freeze in place.
 * @returns the same value, frozen.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    processFreezeTask(pending.pop(), pending, seen)
  }
  return value
}

type FreezeTask = { kind: 'visit'; node: unknown }
  | { kind: 'property'; source: Record<string, unknown>; key: string }

function processFreezeTask(task: FreezeTask | undefined, pending: FreezeTask[], seen: WeakSet<object>): void {
  if (task === undefined) return
  if (task.kind === 'property') {
    pending.push({ kind: 'visit', node: task.source[task.key] })
    return
  }
  const node = task.node
  if (node === null || typeof node !== 'object' || node instanceof AbortSignal || seen.has(node)) return
  seen.add(node)
  Object.freeze(node)
  const keys = Object.keys(node)
  for (let index = keys.length - 1; index >= 0; index--) {
    const key = keys[index]
    if (key !== undefined) pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
  }
}
