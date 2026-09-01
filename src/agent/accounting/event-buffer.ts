import { AgentSdkError, OBSERVATION_ERROR_CODES } from '@ai-agent-sdk/core'

interface BufferedValue<T> { readonly value: T; readonly bytes: number }

/** Single-consumer, non-blocking producer buffer for public run events. */
export class RunEventBuffer<T> {
  private readonly values: BufferedValue<T>[] = []
  private readonly waiters: Array<() => void> = []
  private bytes = 0
  private closed = false
  private stopped = false
  private failure: unknown

  constructor(
    private readonly maxEvents = 100_000,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  push(value: T): void {
    if (this.stopped) return
    if (this.closed) throw new Error('run event buffer is closed')
    const bytes = serializedBytes(value)
    if (this.values.length >= this.maxEvents || this.bytes + bytes > this.maxBytes) {
      throw new AgentSdkError(
        'public run event buffer exceeded its resource limit',
        OBSERVATION_ERROR_CODES.LEDGER_LIMIT_EXCEEDED,
      )
    }
    this.values.push({ value, bytes })
    this.bytes += bytes
    this.notify()
  }

  close(): void {
    this.closed = true
    this.notify()
  }

  fail(error: unknown): void {
    this.failure = error
    this.closed = true
    this.notify()
  }

  stop(): void {
    this.stopped = true
    this.closed = true
    this.values.length = 0
    this.bytes = 0
    this.notify()
  }

  async take(): Promise<IteratorResult<T>> {
    while (true) {
      const item = this.values.shift()
      if (item !== undefined) {
        this.bytes -= item.bytes
        return { done: false, value: item.value }
      }
      if (this.failure !== undefined) throw this.failure
      if (this.closed) return { done: true, value: undefined }
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
  }

  private notify(): void {
    const waiters = this.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength
  } catch {
    throw new AgentSdkError(
      'public run event is not lossless JSON',
      OBSERVATION_ERROR_CODES.LEDGER_LIMIT_EXCEEDED,
    )
  }
}
