import type { SpillStore, MemorySpillStoreLimits } from './types.ts'

/**
 * A spill store that keeps text in this process.
 *
 * Universal, so it works in a browser and in a worker as well as on a server,
 * and enough for the case the policy exists for: the text leaves the model's
 * context immediately and is read back through the retrieval tool. It is not
 * durable — a restart loses it, and the locators in an old transcript stop
 * resolving. A host that needs durability implements {@link SpillStore} over
 * its own filesystem or object storage.
 * @param limits - Retention bounds.
 * @returns The store.
 */
export function createMemorySpillStore(limits: MemorySpillStoreLimits = {}): SpillStore {
  const maxEntries = positive(limits.maxEntries ?? 64, 'maxEntries')
  const maxChars = positive(limits.maxChars ?? 32_000_000, 'maxChars')
  // Insertion-ordered, which makes the oldest entry the first key.
  const entries = new Map<string, { readonly text: string; readonly chars: number }>()
  let held = 0
  let counter = 0

  // One text larger than the whole allowance evicts everything and is still
  // kept: dropping the save would leave the model a locator that resolves to
  // nothing, which is worse than briefly exceeding a soft retention bound. The
  // next save evicts it.
  const evictUntil = (room: number): void => {
    while ((entries.size >= maxEntries || held + room > maxChars) && entries.size > 0) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      held -= entries.get(oldest)?.chars ?? 0
      entries.delete(oldest)
    }
  }

  return {
    save(text, context) {
      let chars = 0
      for (const _point of text) chars++
      evictUntil(chars)
      counter += 1
      const locator = `spill:${context.toolName}:${String(counter)}`
      entries.set(locator, { text, chars })
      held += chars
      return {
        locator,
        bytes: new TextEncoder().encode(text).byteLength,
        retrieval: `Call read_tool_output with locator "${locator}" to read the rest,`
          + ' or with a pattern to search it.',
      }
    },
    read(locator, range) {
      const entry = entries.get(locator)
      if (entry === undefined) return undefined
      const offset = Math.min(Math.max(0, range.offset), entry.chars)
      // Match Array.slice's coercion, including fractional and NaN ranges,
      // without allocating every code point of a large observation.
      const startPoints = Number.isNaN(offset) ? 0 : Math.trunc(offset)
      const endPoints = Math.trunc(offset + Math.max(1, range.limit))
      const start = codeUnitOffset(entry.text, startPoints)
      const end = codeUnitOffset(entry.text, Number.isNaN(endPoints) ? 0 : Math.max(0, endPoints - startPoints), start)
      return {
        text: entry.text.slice(start, end),
        totalChars: entry.chars,
        offset,
      }
    },
    search(locator, pattern, limit) {
      const entry = entries.get(locator)
      if (entry === undefined) return undefined
      // An invalid pattern is the model's mistake to correct, so it surfaces as
      // a thrown tool error rather than as silently zero matches.
      const expression = new RegExp(pattern)
      const found: string[] = []
      const lines = entry.text.split('\n')
      for (let index = 0; index < lines.length && found.length < limit; index++) {
        const line = lines[index] ?? ''
        if (expression.test(line)) found.push(`${String(index + 1)}: ${line}`)
      }
      return Object.freeze(found)
    },
  }
}

/** Locate a code-point boundary without allocating a copy of the whole saved log. */
function codeUnitOffset(text: string, points: number, start = 0): number {
  let index = start
  for (let count = 0; count < points && index < text.length; count++) {
    const high = text.charCodeAt(index++)
    if (high >= 0xD800 && high <= 0xDBFF && index < text.length) {
      const low = text.charCodeAt(index)
      if (low >= 0xDC00 && low <= 0xDFFF) index++
    }
  }
  return index
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`spill store ${name} must be a positive safe integer`)
  }
  return value
}
