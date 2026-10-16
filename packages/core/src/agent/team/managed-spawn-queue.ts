/** A FIFO backlog with no worker/session allocation and exactly-once cancellation. */
export class ManagedSpawnQueue<T extends { queued: boolean; controller: AbortController }> {
  private readonly entries: { prepared: T; start(): Promise<unknown> }[] = []

  constructor(private readonly signal: AbortSignal, private readonly free: () => number) {}

  get size(): number { return this.entries.length }

  drain(): void {
    while (!this.signal.aborted && this.entries.length > 0 && this.free() > 0) {
      const entry = this.entries.shift()!
      entry.prepared.queued = false
      void entry.start()
    }
  }

  enqueue(prepared: T, signal: AbortSignal, start: () => Promise<unknown>, cancelled: () => void): void {
    const cancel = () => {
      const index = this.entries.indexOf(entry)
      if (index < 0) return
      this.entries.splice(index, 1)
      cleanup()
      cancelled()
    }
    const signals = [signal, this.signal, prepared.controller.signal]
    const cleanup = () => { for (const signal of signals) signal.removeEventListener('abort', cancel) }
    const entry = { prepared, start: () => { cleanup(); return start() } }
    this.entries.push(entry)
    for (const signal of signals) signal.addEventListener('abort', cancel, { once: true })
    if (signals.some(signal => signal.aborted)) cancel()
  }
}
