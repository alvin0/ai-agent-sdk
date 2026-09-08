/**
 * How much of a tool's output the model is allowed to read.
 *
 * A tool result enters the model's context unchanged, so one `cat` of a
 * generated bundle can spend a context window that the turn then has no way to
 * recover — the provider rejects the next request, and everything already paid
 * for is lost. Both reference harnesses stop this at the RESULT boundary rather
 * than waiting for the request to be assembled, and they differ only in where
 * the removed text goes:
 *
 * - **Codex** truncates the middle to a token budget and tells the model how
 *   much was dropped (`truncate_middle_with_token_budget`). Cheap and needs no
 *   storage; the model recovers by re-running a narrower command.
 * - **The DeepSeek harness** spills the full text to a store, and hands the
 *   model a bounded preview plus a locator to read or search (`dsh-spill`).
 *   Nothing is lost, but it needs somewhere to put the text.
 *
 * Both are offered here. `auto` — the default — takes the second when a store
 * is mounted and the first when none is, so the cheap path works everywhere and
 * the lossless one turns itself on the moment it can.
 *
 * @module ai-agent-sdk/agent/tool/output-budget
 */

import type { ContentBlock } from '../../message/index.ts'
import type { JsonObject } from '../../primitives/index.ts'
import { defineTool, type ToolDefinition } from './definition.ts'

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
  const entries = new Map<string, string>()
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
      held -= [...entries.get(oldest) ?? ''].length
      entries.delete(oldest)
    }
  }

  return {
    save(text, context) {
      const chars = [...text].length
      evictUntil(chars)
      counter += 1
      const locator = `spill:${context.toolName}:${String(counter)}`
      entries.set(locator, text)
      held += chars
      return {
        locator,
        bytes: new TextEncoder().encode(text).byteLength,
        retrieval: `Call read_tool_output with locator "${locator}" to read the rest,`
          + ' or with a pattern to search it.',
      }
    },
    read(locator, range) {
      const text = entries.get(locator)
      if (text === undefined) return undefined
      const points = [...text]
      const offset = Math.min(Math.max(0, range.offset), points.length)
      return {
        text: points.slice(offset, offset + Math.max(1, range.limit)).join(''),
        totalChars: points.length,
        offset,
      }
    },
    search(locator, pattern, limit) {
      const text = entries.get(locator)
      if (text === undefined) return undefined
      // An invalid pattern is the model's mistake to correct, so it surfaces as
      // a thrown tool error rather than as silently zero matches.
      const expression = new RegExp(pattern)
      const found: string[] = []
      const lines = text.split('\n')
      for (let index = 0; index < lines.length && found.length < limit; index++) {
        const line = lines[index] ?? ''
        if (expression.test(line)) found.push(`${String(index + 1)}: ${line}`)
      }
      return Object.freeze(found)
    },
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`spill store ${name} must be a positive safe integer`)
  }
  return value
}

/**
 * Deterministic token estimate for text.
 *
 * Four characters per token, the same heuristic compaction uses, and the same
 * order of magnitude as Codex's `approx_token_count`. It is an estimate: a real
 * tokenizer differs, and dense scripts differ more. It is used to decide when
 * to shorten output, never to bill anything.
 * @param text - The text to measure.
 * @returns The estimated token count.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Estimated tokens for the text a tool result puts in front of the model.
 *
 * Only text is counted. An image block is left alone — shortening it produces a
 * corrupt image rather than a smaller one.
 * @param content - The result's content blocks.
 * @returns The estimated token count of the text blocks.
 */
export function estimateTextBlockTokens(content: readonly ContentBlock[]): number {
  return content.reduce(
    (total, block) => block.type === 'text' ? total + estimateTextTokens(block.text) : total,
    0,
  )
}

/** The result of shortening one oversized text. */
export interface TruncatedText {
  readonly text: string
  /** Estimated tokens the original held. */
  readonly originalTokens: number
}

/**
 * Cut the middle out of a text to fit a token budget.
 *
 * The middle goes because the two ends carry the most: a command's invocation
 * and its verdict, a file's header and its tail. Codex splits its budget the
 * same way. The marker states how much left, so the model can see that it is
 * reading a fragment rather than a short result.
 * @param text - The full text.
 * @param maxTokens - Estimated tokens the model may read.
 * @returns The shortened text and what the original held.
 */
export function truncateMiddleToTokens(text: string, maxTokens: number): TruncatedText {
  const originalTokens = estimateTextTokens(text)
  if (originalTokens <= maxTokens) return { text, originalTokens }
  const budget = Math.max(1, maxTokens * 4)
  // Two thirds to the head: a command's own output usually leads with what it
  // did, and the tail is mostly the verdict.
  const head = Math.max(1, Math.floor(budget * 0.66))
  const tail = Math.max(0, budget - head)
  const points = [...text]
  const removed = originalTokens - maxTokens
  const marker = `\n\n[... ${String(removed)} estimated tokens omitted from the middle ...]\n\n`
  return {
    text: points.slice(0, head).join('')
      + marker
      + (tail === 0 ? '' : points.slice(points.length - tail).join('')),
    originalTokens,
  }
}

/**
 * The head/tail preview shown in place of a spilled result.
 * @param text - The full text.
 * @param maxTokens - Estimated tokens the preview may hold.
 * @returns The preview.
 */
export function previewForSpill(text: string, maxTokens: number): string {
  return truncateMiddleToTokens(text, maxTokens).text
}

/** The name the retrieval tool is registered under. */
export const SPILL_TOOL_NAME = 'read_tool_output'

interface ReadSpillArgs {
  readonly locator: string
  readonly offset?: number
  readonly limit?: number
  readonly pattern?: string
}

/**
 * The tool that reads back what a spill took out of the context.
 *
 * Spilling without this would be worse than truncating: the model would be
 * told its output exists somewhere and given no way to reach it. Registered
 * automatically wherever a store is mounted.
 * @param store - The mounted store.
 * @param defaultLimit - Characters one read returns when none is asked for.
 * @returns The tool definition.
 */
export function readSpillTool(store: SpillStore, defaultLimit = 8_000): ToolDefinition<ReadSpillArgs> {
  return defineTool({
    name: SPILL_TOOL_NAME,
    description: 'Read or search the full output of an earlier tool call that was too large to'
      + ' show in full. Pass the locator from that result. Use pattern to find matching lines,'
      + ' or offset/limit to page through it.',
    parameters: {
      type: 'object',
      properties: {
        locator: { type: 'string', description: 'The locator printed with the shortened result.' },
        offset: { type: 'number', description: 'Character offset to start reading from.' },
        limit: { type: 'number', description: `Characters to read; defaults to ${String(defaultLimit)}.` },
        pattern: {
          type: 'string',
          description: 'Regular expression matched per line; returns matching lines with numbers.',
        },
      },
      required: ['locator'],
      additionalProperties: false,
    },
    // Reading back is not exploration, and a model that cannot reach its own
    // spilled output is worse off than one whose output was simply cut.
    budgetExempt: true,
    parse: parseReadSpill,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      if (args.pattern !== undefined) {
        const matches = await store.search(args.locator, args.pattern, 200)
        if (matches === undefined) return unknownLocator(args.locator)
        return { locator: args.locator, matches: [...matches] }
      }
      const slice = await store.read(args.locator, {
        offset: args.offset ?? 0,
        limit: args.limit ?? defaultLimit,
      })
      if (slice === undefined) return unknownLocator(args.locator)
      const end = slice.offset + [...slice.text].length
      return {
        locator: args.locator,
        offset: slice.offset,
        nextOffset: end < slice.totalChars ? end : null,
        totalChars: slice.totalChars,
        text: slice.text,
      }
    },
  })
}

function unknownLocator(locator: string): JsonObject {
  // A store that has evicted or lost the entry is a normal outcome, not a
  // crash: the model needs to know to re-run the original call instead.
  return {
    locator,
    error: 'no saved output for this locator; it may have expired. Re-run the original call'
      + ' more narrowly if you still need it.',
  }
}

function parseReadSpill(raw: unknown): ReadSpillArgs {
  if (typeof raw !== 'object' || raw === null) throw new TypeError('arguments must be an object')
  const value = raw as Record<string, unknown>
  const locator = value['locator']
  if (typeof locator !== 'string' || locator.length === 0) {
    throw new TypeError('locator must be a non-empty string')
  }
  const offset = optionalCount(value['offset'], 'offset')
  const limit = optionalCount(value['limit'], 'limit')
  const pattern = value['pattern']
  if (pattern !== undefined && typeof pattern !== 'string') {
    throw new TypeError('pattern must be a string')
  }
  return {
    locator,
    ...offset === undefined ? {} : { offset },
    ...limit === undefined ? {} : { limit },
    ...pattern === undefined || pattern === '' ? {} : { pattern },
  }
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`)
  }
  return Math.floor(value)
}
