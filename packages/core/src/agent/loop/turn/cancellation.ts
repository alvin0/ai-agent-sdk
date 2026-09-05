import { waitForSettlement } from '../../../async/index.ts'

export class StreamAbortError extends Error {
  constructor(override readonly cause: unknown) {
    super('model stream was aborted')
    this.name = 'StreamAbortError'
  }
}
export async function nextWithAbort<T>(
  pending: Promise<IteratorResult<T>>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) throw new StreamAbortError(signal.reason)
  return await new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new StreamAbortError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
export async function closeIterator<T>(iterator: AsyncIterator<T>, timeoutMs: number): Promise<boolean> {
  const close = iterator.return?.bind(iterator)
  if (close === undefined) return true
  const closing = Promise.resolve().then(async () => { await close() })
  return await waitForSettlement(closing, timeoutMs)
}
export async function nextValueWithAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new StreamAbortError(signal.reason)
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new StreamAbortError(signal.reason))
    }
    signal.addEventListener('abort', abort, { once: true })
    void pending.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}
