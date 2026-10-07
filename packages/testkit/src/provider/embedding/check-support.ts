import {
  type EmbeddingCacheEntry,
  type EmbeddingCacheStore,
} from '@alvin0/ai-agent-sdk-core/embedding'
import {
  ConformanceAssertionError,
  ConformanceTimeoutError,
  assert,
  within,
} from '../report.ts'
import type {
  EmbeddingConformanceDispatch,
} from './types.ts'

const ENCODER = new TextEncoder()

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function byteLength(text: string): number {
  return ENCODER.encode(text).byteLength
}

export function sameVector(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

/** Every input is accounted for exactly once, by the cache or by the provider. */
export function assertInputsAccounted(
  usage: { readonly inputsFromCache: number; readonly inputsFromProvider: number },
  inputCount: number,
): void {
  const total = usage.inputsFromCache + usage.inputsFromProvider
  assert(total === inputCount,
    `usage accounts for ${total} inputs in a call of ${inputCount}; cache and provider counts must sum to the call`)
}

/** The stable code of a rejection, without trusting the value's shape. */
export function codeOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    try {
      const code = Reflect.get(error, 'code')
      if (typeof code === 'string' && code.length > 0) return code
    } catch {
      return 'UNREADABLE'
    }
  }
  return 'UNKNOWN'
}

/** The message of a rejection, for the one privacy assertion that needs it. */
export function messageOf(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    try {
      const message = Reflect.get(error, 'message')
      if (typeof message === 'string') return message
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * The value a promise rejected with.
 *
 * A timeout is re-thrown rather than returned: a case that never settled is not
 * evidence that the call was rejected.
 */
export async function rejectionOf<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<unknown> {
  try {
    await within(promise, timeoutMs)
  } catch (error) {
    if (error instanceof ConformanceTimeoutError) throw error
    return error
  }
  throw new ConformanceAssertionError(`${what} unexpectedly succeeded`)
}

/** Await a call whose outcome is not the claim under test. */
export async function settled<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
  try {
    await within(promise, timeoutMs)
  } catch (error) {
    if (error instanceof ConformanceTimeoutError) throw error
  }
}

/** Attempts grouped by the exact item set they carried. */
export function groupBySignature(
  dispatches: readonly EmbeddingConformanceDispatch[],
): ReadonlyMap<string, readonly EmbeddingConformanceDispatch[]> {
  const groups = new Map<string, EmbeddingConformanceDispatch[]>()
  for (const dispatch of dispatches) {
    const signature = [...dispatch.itemIndexes].join(',')
    const rows = groups.get(signature) ?? []
    rows.push(dispatch)
    groups.set(signature, rows)
  }
  return groups
}

interface RecordingCacheStore extends EmbeddingCacheStore {
  /** Keys written, in write order. */
  written(): readonly string[]
}

/**
 * An in-process cache that also records what it was asked to store.
 *
 * The harness owns the store rather than the fixture: cache-key composition is a
 * runtime claim, and a provider-supplied store could satisfy it accidentally.
 */
export function recordingStore(): RecordingCacheStore {
  const entries = new Map<string, EmbeddingCacheEntry>()
  const written: string[] = []
  return {
    get: (key: string) => entries.get(key),
    set: (key: string, entry: EmbeddingCacheEntry) => {
      entries.set(key, entry)
      written.push(key)
    },
    written: () => [...written],
  }
}
