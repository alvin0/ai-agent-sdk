

/**
 * What happens to output that exceeds its budget.
 *
 * - `auto` — spill when a store is mounted, otherwise truncate.
 * - `truncate` — always cut the middle; never needs a store.
 * - `spill` — save the full text and show a preview; falls back to truncating
 *   when no store is mounted or the store fails, because losing the result
 *   entirely is worse than shortening it.
 */
export type ToolOutputOverflowPolicy = 'auto' | 'truncate' | 'spill'

/** A saved copy of one oversized tool result. */
export interface SpillRecord {
  /** Opaque handle the retrieval tool resolves; also shown to the model. */
  readonly locator: string
  /** Exact size of the saved text. */
  readonly bytes: number
  /**
   * One sentence telling the model how to get the rest.
   *
   * Written by the backend, because only it knows what the locator IS — a file
   * a shell can grep, or a handle only the built-in retrieval tool resolves.
   */
  readonly retrieval: string
}

/** A slice of a saved tool result. */
export interface SpillSlice {
  readonly text: string
  /** Total code points in the saved text, so a reader can page through it. */
  readonly totalChars: number
  /** Where this slice starts. */
  readonly offset: number
}

/**
 * Where oversized tool output goes when the policy spills it.
 *
 * The port is deliberately tiny: core is a universal package and cannot open a
 * file, so a host that wants durable spill implements this over its own
 * storage. {@link createMemorySpillStore} covers the common case.
 */
export interface SpillStore {
  /**
   * Save one oversized result.
   * @param text - The complete model-facing text.
   * @param context - What produced it, for naming and diagnostics.
   * @returns The locator the model can retrieve it by.
   */
  save(text: string, context: { readonly toolName: string; readonly callId: string }):
  Promise<SpillRecord> | SpillRecord
  /**
   * Read part of a saved result.
   * @param locator - A locator returned by {@link SpillStore.save}.
   * @param range - Where to start and how much to read, in code points.
   * @returns The slice, or undefined when the locator is unknown or expired.
   */
  read(locator: string, range: { readonly offset: number; readonly limit: number }):
  Promise<SpillSlice | undefined> | SpillSlice | undefined
  /**
   * Find matching lines in a saved result.
   * @param locator - A locator returned by {@link SpillStore.save}.
   * @param pattern - A regular expression source, matched per line.
   * @param limit - Maximum lines returned.
   * @returns Matching `line-number: text` entries, or undefined when unknown.
   */
  search(locator: string, pattern: string, limit: number):
  Promise<readonly string[] | undefined> | readonly string[] | undefined
}

/** Bounds for the built-in in-process store. */
export interface MemorySpillStoreLimits {
  /** Saved results kept before the oldest is evicted. Defaults to 64. */
  readonly maxEntries?: number
  /** Total characters kept across all entries. Defaults to 32,000,000. */
  readonly maxChars?: number
}
