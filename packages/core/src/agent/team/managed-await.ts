import { timeoutValue } from '../../platform/config.ts'
import { abortable } from './managed-cancellation.ts'
import type { WorkerRuntime } from './managed-types.ts'

/** Host read; cancellation stops waiting without cancelling the worker. */
export async function awaitManagedWorker(runtime: WorkerRuntime,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal }) {
    // Opt-in: no timeout waits until the worker settles or the signal aborts.
    const budget = options.timeoutMs === undefined ? undefined : timeoutValue(options.timeoutMs)
    // The timer is cleared either way: a worker that finishes early must not
    // leave one pending, which in a long-lived host is a slow leak.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => { if (budget !== undefined) timer = setTimeout(resolve, budget) })
    try {
      await abortable(Promise.race([runtime.settled, deadline]), options.signal)
    } finally {
      clearTimeout(timer)
    }
    options.signal?.throwIfAborted()
    return runtime.result
}
