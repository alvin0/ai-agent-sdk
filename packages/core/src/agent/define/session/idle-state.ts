/** Settles idle waiters independently of session input and memory state. */
export class SessionIdleState {
  private readonly waiters = new Set<() => void>()
  constructor(private readonly isRunning: () => boolean) {}
  whenIdle(signal?: AbortSignal): Promise<void> {
    if (!this.isRunning()) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.waiters.delete(finish)
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        this.waiters.delete(finish)
        reject(signal?.reason)
      }
      this.waiters.add(finish)
      signal?.addEventListener('abort', abort, { once: true })
      if (!this.isRunning()) finish()
    })
  }
  release(): void {
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resolve of waiters) resolve()
  }
}
