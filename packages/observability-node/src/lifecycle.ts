import type { Observability } from '@alvin0/ai-agent-sdk-core/observability'

export interface NodeLifecycleTarget {
  on(event: 'beforeExit' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'beforeExit' | 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface NodeLifecycleOptions {
  readonly target?: NodeLifecycleTarget
  readonly signals?: readonly ('SIGINT' | 'SIGTERM')[]
  readonly onFailure?: (error: unknown) => void
}

/** Install opt-in Node shutdown triggers and return an idempotent disposer. */
export function installNodeObservabilityLifecycle(
  observation: Pick<Observability, 'shutdown'>,
  options: NodeLifecycleOptions = {},
): () => void {
  if (typeof observation?.shutdown !== 'function') throw new TypeError('Node lifecycle requires observability.shutdown')
  const target = options.target ?? process
  const events = Object.freeze(['beforeExit', ...(options.signals ?? [])] as const)
  let disposed = false
  let pending: Promise<unknown> | undefined
  const shutdown = () => {
    if (disposed || pending !== undefined) return
    try {
      pending = observation.shutdown()
      void pending.catch(error => {
        try { options.onFailure?.(error) } catch { /* user callback is contained */ }
      })
    } catch (error) {
      try { options.onFailure?.(error) } catch { /* user callback is contained */ }
    }
  }
  for (const event of events) target.on(event, shutdown)
  return () => {
    if (disposed) return
    disposed = true
    for (const event of events) target.off(event, shutdown)
  }
}
