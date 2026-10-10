import type { AgentMessageRecord } from './types.ts'
import { deepCloneFreeze } from './common.ts'

/** Reserves capacity before delivery, including outstanding remote replies. */
export class TeamMailbox {
  private readonly records: AgentMessageRecord[] = []
  private retainedBytes = 0
  private pendingMessages = 0
  private pendingBytes = 0

  constructor(private readonly maxMessages: number, private readonly maxBytes: number) {}

  reserve(contentBytes: number): () => void {
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
    this.retainedBytes += retainedBytes
  }

  messages(): readonly AgentMessageRecord[] { return deepCloneFreeze(this.records) }

  clear(): void {
    this.records.length = 0
    this.retainedBytes = 0
  }
}
