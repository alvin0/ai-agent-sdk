/**
 * Deep-merge `override` onto a serialized request body.
 *
 * The user's value always wins, including over a field the SDK itself set
 * (`model`, `max_tokens`, `reasoning`, `stream`, …) — decision 12. A `null`
 * value deletes the key outright, the escape hatch for removing an SDK-set
 * field without reaching for `transformRequest`. Two plain objects at the same
 * key merge recursively; anything else (an array, a primitive, a plain object
 * merging onto a non-object) replaces the base value wholesale — merging an
 * array element-wise would silently reorder or interleave items the caller
 * never asked to touch.
 */
export function mergeRequestBody(
  base: unknown,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const target: Record<string, unknown> = isPlainObject(base) ? { ...base } : {}
  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      delete target[key]
      continue
    }
    const existing = target[key]
    target[key] = isPlainObject(value) && isPlainObject(existing)
      ? mergeRequestBody(existing, value)
      : value
  }
  return target
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
