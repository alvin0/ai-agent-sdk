import type { AgentMessageRecord } from './types.ts'
import { deepCloneFreeze } from './common.ts'

export function evictsOldest(overflow: unknown): boolean {
  if (overflow !== undefined && overflow !== 'reject' && overflow !== 'evict-oldest') {
    throw new TypeError('mailboxOverflow must be reject or evict-oldest')
  }
  return overflow === 'evict-oldest'
}

/** Reserves capacity before delivery, including outstanding remote replies. */
export class TeamMailbox {
  private readonly records: AgentMessageRecord[] = []
  private readonly sizes: number[] = []
  private retainedBytes = 0
  private pendingMessages = 0
  private pendingBytes = 0

  /** With `evict`, the audit log drops its oldest delivered records instead of refusing new messages. */
  constructor(
    private readonly maxMessages: number, private readonly maxBytes: number, private readonly evict = false,
  ) {}

  reserve(contentBytes: number): () => void {
    if (this.evict) this.evictFor(contentBytes)
    if (this.records.length + this.pendingMessages >= this.maxMessages) {
      throw new Error(`A2A team reached its ${this.maxMessages}-message mailbox limit`)
    }
    if (this.retainedBytes + this.pendingBytes + contentBytes > this.maxBytes) {
      throw new Error(`A2A team reached its ${this.maxBytes}-byte mailbox limit`)
    }
    this.pendingMessages++
    this.pendingBytes += contentBytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.pendingMessages--
      this.pendingBytes -= contentBytes
    }
  }

  accept(record: AgentMessageRecord, retainedBytes: number): void {
    this.records.push(record)
    this.sizes.push(retainedBytes)
    this.retainedBytes += retainedBytes
  }

  private evictFor(bytes: number): void {
    while (this.records.length > 0 && (this.records.length + this.pendingMessages >= this.maxMessages
      || this.retainedBytes + this.pendingBytes + bytes > this.maxBytes)) {
      this.records.shift()
      this.retainedBytes -= this.sizes.shift()!
    }
  }

  messages(): readonly AgentMessageRecord[] { return deepCloneFreeze(this.records) }

  clear(): void {
    this.records.length = 0
    this.sizes.length = 0
    this.retainedBytes = 0
  }
}
