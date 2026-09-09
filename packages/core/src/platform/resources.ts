import type { RuntimePlatform } from './adapter.ts'
import { timeoutValue } from './config.ts'

export interface CancellationScope {
  readonly signal: AbortSignal
  cancel(): void
  dispose(): void
}

/** One owner for cancelable timers/listeners. No interval or native timeout-signal can outlive it. */
export class RuntimeResources {
  private closed = false
  private readonly timers = new Set<() => void>()
  private readonly listeners = new Set<() => void>()
  private readonly scopes = new Set<() => void>()

  constructor(readonly platform: RuntimePlatform) {}

  get pendingTimers(): number { return this.timers.size }
  get isClosed(): boolean { return this.closed }
  get pendingListeners(): number { return this.listeners.size }

  private assertOpen(): void {
    if (this.closed) throw new Error('Runtime resources are closed')
  }

  after(milliseconds: number, callback: () => void): () => void {
    this.assertOpen()
    timeoutValue(milliseconds, true)
    let active = true
    let cancel = (): void => undefined
    const release = (): void => {
      if (!active) return
      active = false
      this.timers.delete(release)
      cancel()
    }
    this.timers.add(release)
    try {
      cancel = this.platform.after(milliseconds, () => {
        if (!active) return
        release()
        callback()
      })
    } catch (error) { release(); throw error }
    return release
  }

  onAbort(signal: AbortSignal, callback: () => void): () => void {
    this.assertOpen()
    let active = true
    const release = (): void => {
      if (!active) return
      active = false
      this.listeners.delete(release)
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => { if (active) { release(); callback() } }
    this.listeners.add(release)
    try {
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    } catch (error) { release(); throw error }
    return release
  }

  cancellation(signals: readonly AbortSignal[], timeoutMs?: number): CancellationScope {
    this.assertOpen()
    if (timeoutMs !== undefined) timeoutValue(timeoutMs)
    const controller = this.platform.controller()
    const releases: (() => void)[] = []
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      this.scopes.delete(shutdown)
      for (const release of releases.splice(0).reverse()) release()
    }
    const abort = (): void => {
      controller.abort(new Error('Runtime operation was cancelled'))
      dispose()
    }
    const shutdown = (): void => { abort() }
    this.scopes.add(shutdown)
    try {
      for (const signal of signals) {
        if (disposed) break
        const release = this.onAbort(signal, abort)
        if (disposed) release()
        else releases.push(release)
      }
      if (!disposed && timeoutMs !== undefined) releases.push(this.after(timeoutMs, abort))
    } catch (error) { dispose(); throw error }
    return Object.freeze({ signal: controller.signal, cancel: abort, dispose })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const shutdown of [...this.scopes]) shutdown()
    for (const release of [...this.timers]) release()
    for (const release of [...this.listeners]) release()
  }
}
