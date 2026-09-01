import type { Observability } from '@ai-agent-sdk/observability'

interface LifecycleTarget {
  readonly visibilityState?: string
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

export interface BrowserLifecycleOptions {
  readonly document?: LifecycleTarget
  readonly page?: LifecycleTarget
  readonly onFlushFailure?: (error: unknown) => void
}

/**
 * Opt into best-effort browser lifecycle flushing. Page lifecycle events do not
 * provide a durability extension, so callers must inspect queue recovery later.
 */
export function installBrowserObservabilityLifecycle(
  observation: Pick<Observability, 'flush'>,
  options: BrowserLifecycleOptions = {},
): () => void {
  if (typeof observation?.flush !== 'function') throw new TypeError('browser lifecycle requires observability.flush')
  const documentTarget = options.document ?? globalThis.document
  const pageTarget = options.page ?? globalThis.window
  if (documentTarget === undefined || pageTarget === undefined) {
    throw new TypeError('browser lifecycle requires document and window event targets')
  }
  let disposed = false
  let pending: Promise<unknown> | undefined
  const flush = () => {
    if (disposed || pending !== undefined) return
    try {
      pending = observation.flush()
      void pending.catch(error => {
        try { options.onFlushFailure?.(error) } catch { /* user callback is contained */ }
      }).finally(() => { pending = undefined })
    } catch (error) {
      try { options.onFlushFailure?.(error) } catch { /* user callback is contained */ }
    }
  }
  const visibility = () => {
    if (documentTarget.visibilityState === 'hidden') flush()
  }
  documentTarget.addEventListener('visibilitychange', visibility)
  pageTarget.addEventListener('pagehide', flush)
  return () => {
    if (disposed) return
    disposed = true
    documentTarget.removeEventListener('visibilitychange', visibility)
    pageTarget.removeEventListener('pagehide', flush)
  }
}
