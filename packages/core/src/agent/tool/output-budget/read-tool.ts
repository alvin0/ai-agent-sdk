import type { JsonObject } from '../../../primitives/index.ts'
import { defineTool, type ToolDefinition } from '.././definition.ts'
import type { SpillStore } from './types.ts'

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
  // crash. Losing output does not establish that the original operation failed.
  return {
    locator,
    error: 'Saved output is unavailable; the locator may have expired. This does not mean'
      + ' the original operation failed. Check an existing receipt or current state.'
      + ' Repeat the operation only when the host confirms it is safe.',
  }
}

function parseReadSpill(raw: unknown): ReadSpillArgs {
  if (typeof raw !== 'object' || raw === null) throw new TypeError('arguments must be an object')
  const value = raw as Record<string, unknown>
  return Object.freeze({
    locator: requiredLocator(value.locator),
    ...optionalNumber(value.offset, 'offset'),
    ...optionalNumber(value.limit, 'limit'),
    ...optionalPattern(value.pattern),
  })
}

function requiredLocator(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('locator must be a non-empty string')
  return value
}

function optionalNumber(value: unknown, field: string): Readonly<Record<string, number>> {
  const parsed = optionalCount(value, field)
  return parsed === undefined ? {} : { [field]: parsed }
}

function optionalPattern(value: unknown): Readonly<{ pattern?: string }> {
  if (value !== undefined && typeof value !== 'string') throw new TypeError('pattern must be a string')
  return value === undefined || value === '' ? {} : { pattern: value }
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative number`)
  }
  return Math.floor(value)
}
