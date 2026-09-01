/** Capacity-one queue whose producer waits until the consumer takes the event. */
export class AwaitedEventQueue<T> {
  private slot: { value: T; consumed: () => void } | undefined
  private taker: {
    readonly resolve: (item: IteratorResult<T>) => void
    readonly reject: (error: unknown) => void
  } | undefined
  private space: (() => void) | undefined
  private ended = false
  private failure: unknown

  async push(value: T): Promise<void> {
    if (this.ended) return
    if (this.slot !== undefined) await new Promise<void>(resolve => { this.space = resolve })
    if (this.ended) return
    const taker = this.taker
    if (taker !== undefined) {
      this.taker = undefined
      taker.resolve({ done: false, value })
      return
    }
    await new Promise<void>(resolve => { this.slot = { value, consumed: resolve } })
  }

  async take(): Promise<IteratorResult<T>> {
    if (this.slot !== undefined) {
      const slot = this.slot
      this.slot = undefined
      slot.consumed()
      this.space?.()
      this.space = undefined
      return { done: false, value: slot.value }
    }
    if (this.failure !== undefined) throw this.failure
    if (this.ended) return { done: true, value: undefined }
    return await new Promise((resolve, reject) => { this.taker = { resolve, reject } })
  }

  close(): void {
    this.ended = true
    this.slot?.consumed()
    this.slot = undefined
    this.space?.()
    this.space = undefined
    this.taker?.resolve({ done: true, value: undefined })
    this.taker = undefined
  }

  fail(error: unknown): void {
    this.failure = error
    this.ended = true
    this.slot?.consumed()
    this.slot = undefined
    this.space?.()
    this.space = undefined
    this.taker?.reject(error)
    this.taker = undefined
  }
}
