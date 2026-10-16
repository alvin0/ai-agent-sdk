import { timeoutValue } from '../../platform/config.ts'
import { DEFAULT_WAIT_TIMEOUT_MS } from './common.ts'
import { abortable } from './managed-cancellation.ts'
import type { WorkerRuntime } from './managed-types.ts'

/** Bounded host read; cancellation stops waiting without cancelling the worker. */
export async function awaitManagedWorker(runtime: WorkerRuntime,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal }) {
    const budget = timeoutValue(options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    // The timer is cleared either way: a worker that finishes early must not
    // leave one pending, which in a long-lived host is a slow leak.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, budget) })
    try {
      await abortable(Promise.race([runtime.settled, deadline]), options.signal)
    } finally {
      clearTimeout(timer)
    }
    options.signal?.throwIfAborted()
    return runtime.result
}
