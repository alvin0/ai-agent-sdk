/**
 * Turn-scoped store of structured child results a program chose to keep.
 *
 * A handle is an opaque capability for ONE owner (the program tool that stored
 * it) inside ONE turn. It is checked again on every load: owner, expiry, the
 * store being open, and the producing tool still being the definition that
 * produced the value. The store holds only finalized, post-policy values.
 */
import type { JsonValue } from '../../primitives/index.ts'
import type { ToolDefinition } from './definition.ts'
import { createOperationId } from '../../observation/context.ts'

export interface ProgramResultLimits {
  readonly ttlMs: number
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxTotalBytes: number
}

export const DEFAULT_PROGRAM_RESULT_LIMITS: ProgramResultLimits = Object.freeze({
  ttlMs: 10 * 60_000,
  maxEntries: 64,
  maxEntryBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
})

/** Where a retained value came from. Host-recorded, never program-supplied. */
export interface ProgramResultProvenance {
  readonly toolName: string
  readonly callId: string
  readonly parentCallId: string
  readonly storedAt: number
}

interface Entry {
  readonly owner: string
  readonly value: JsonValue
  readonly bytes: number
  readonly definition: ToolDefinition
  readonly schema: 'validated' | 'unchecked'
  readonly provenance: ProgramResultProvenance
  readonly expiresAt: number
}

export type ProgramResultLoad =
  | { readonly kind: 'found'; readonly value: JsonValue; readonly schema: 'validated' | 'unchecked'; readonly provenance: ProgramResultProvenance }
  | { readonly kind: 'unavailable'; readonly reason: 'unknown' | 'expired' | 'closed' | 'stale' }

export class ProgramResultStore {
  private readonly entries = new Map<string, Entry>()
  private totalBytes = 0
  private closed = false
  private readonly limits: ProgramResultLimits
  private readonly now: () => number
  private readonly newHandle: () => string

  constructor(options: { limits?: Partial<ProgramResultLimits>; now?: () => number; newHandle?: () => string } = {}) {
    this.limits = Object.freeze({ ...DEFAULT_PROGRAM_RESULT_LIMITS, ...options.limits })
    this.now = options.now ?? (() => Date.now())
    this.newHandle = options.newHandle ?? (() => `ph_${createOperationId()}`)
  }

  /**
   * @returns A handle, or the reason nothing was stored.
   */
  save(input: {
    readonly owner: string
    readonly value: JsonValue
    readonly definition: ToolDefinition
    readonly schema: 'validated' | 'unchecked'
    readonly provenance: Omit<ProgramResultProvenance, 'storedAt'>
  }): { readonly handle: string } | { readonly refused: 'closed' | 'entry-too-large' | 'store-full' } {
    if (this.closed) return { refused: 'closed' }
    this.evictExpired()
    const bytes = new TextEncoder().encode(JSON.stringify(input.value)).byteLength
    if (bytes > this.limits.maxEntryBytes) return { refused: 'entry-too-large' }
    // No eviction of live entries to make room: a handle a program already
    // holds must not silently disappear because a sibling stored more.
    if (this.entries.size >= this.limits.maxEntries || this.totalBytes + bytes > this.limits.maxTotalBytes) {
      return { refused: 'store-full' }
    }
    const storedAt = this.now()
    const handle = this.newHandle()
    if (this.entries.has(handle)) throw new Error('retained result handle collided with a live entry')
    this.entries.set(handle, Object.freeze({
      owner: input.owner, value: input.value, bytes, definition: input.definition, schema: input.schema,
      provenance: Object.freeze({ ...input.provenance, storedAt }), expiresAt: storedAt + this.limits.ttlMs,
    }))
    this.totalBytes += bytes
    return { handle }
  }

  /**
   * @param current - The definition the catalog holds now for the producing tool.
   */
  load(handle: string, owner: string, current: (toolName: string) => ToolDefinition | undefined): ProgramResultLoad {
    if (this.closed) return { kind: 'unavailable', reason: 'closed' }
    const entry = this.entries.get(handle)
    // Another owner's handle reads exactly like a handle that never existed.
    if (entry === undefined || entry.owner !== owner) return { kind: 'unavailable', reason: 'unknown' }
    if (this.now() >= entry.expiresAt) {
      this.drop(handle, entry)
      return { kind: 'unavailable', reason: 'expired' }
    }
    if (current(entry.provenance.toolName) !== entry.definition) return { kind: 'unavailable', reason: 'stale' }
    return { kind: 'found', value: entry.value, schema: entry.schema, provenance: entry.provenance }
  }

  release(handle: string, owner: string): boolean {
    const entry = this.entries.get(handle)
    if (entry === undefined || entry.owner !== owner) return false
    this.drop(handle, entry)
    return true
  }

  /** Idempotent. Every handle becomes unavailable. */
  close(): void {
    this.closed = true
    this.entries.clear()
    this.totalBytes = 0
  }

  get size(): number { return this.entries.size }
  get bytes(): number { return this.totalBytes }

  private evictExpired(): void {
    const now = this.now()
    for (const [handle, entry] of this.entries) if (now >= entry.expiresAt) this.drop(handle, entry)
  }

  private drop(handle: string, entry: Entry): void {
    this.entries.delete(handle)
    this.totalBytes -= entry.bytes
  }
}
