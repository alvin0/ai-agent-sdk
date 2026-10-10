import { ModelError, MODEL_ERROR_CODES } from '@alvin0/ai-agent-sdk-core'

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof ModelError ? signal.reason : new ModelError(
    'Decision call aborted', MODEL_ERROR_CODES.ABORTED)
}
/** Settles promptly even if an extension ignores cancellation; observes its late rejection. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); try { throwIfAborted(signal) } catch (error) { reject(error) } }
    const cleanup = () => signal.removeEventListener('abort', abort)
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
export function waitDecisionDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); cleanup(); try { throwIfAborted(signal) } catch (error) {
      reject(error) } }
    const cleanup = () => signal.removeEventListener('abort', abort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
